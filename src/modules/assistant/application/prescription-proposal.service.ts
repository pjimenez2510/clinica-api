import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type {
  KnownAllergy,
  SubstanceKeys,
} from '../../../shared/clinical/allergy-match';
import {
  ALLERGY_ABSENCE_READER,
  type AllergyAbsenceReader,
} from '../../../shared/clinical/allergy-absence.port';
import {
  acceptsNewContent,
  CODING_CONTEXT_READER,
  type CodingContextReader,
  type CodingEncounter,
  type NoteSectionText,
} from '../../../shared/clinical/coding-context.port';
import {
  SURVIVING_CHART_ALLERGY_READER,
  type SurvivingChartAllergyReader,
} from '../../../shared/clinical/patient-allergy.port';
import {
  PRESCRIBING_CONTEXT_READER,
  type CnmbMedicine,
  type PrescribedLine,
  type PrescribingContextReader,
} from '../../../shared/clinical/prescribing-context.port';
import type {
  DosageForm,
  DoseUnit,
  Frequency,
  MedicationRoute,
} from '../../../shared/clinical/prescription-vocabulary';
import {
  AssistantAllergyCheckFailedError,
  AssistantAllergyContraindicationError,
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNoteEmptyError,
  AssistantNotEncounterOwnerError,
  AssistantPrescriptionLineNotReadyError,
  AssistantProposalNotKeptError,
  AssistantReadingInProgressError,
  PseudonymizerFailedError,
  SuggestionAlreadyDecidedError,
  SuggestionInvalidError,
  SuggestionNotFoundError,
  SuggestionPrescriptionMismatchError,
} from '../domain/assistant.errors';
import {
  allergyVerdictOf,
  backedLines,
  blockOf,
  canonicalLine,
  choosePresentation,
  chosenIsWritten,
  cnmbSearchName,
  knownCodes,
  proposedFields,
  strengthIn,
  type AllergyVerdict,
  type LineBlock,
  type PrescriptionProposal,
  type ProposedFields,
  type UnsaidField,
} from '../domain/prescription-reading';
import {
  carriesAnIdentifier,
  currentReading,
  locateQuote,
} from '../domain/problem-coding';
import type { SuggestionStatus, SuggestionView } from '../domain/suggestion';

import {
  ASSISTANT_DEMO,
  type ProposalRequester,
} from './diagnosis-proposal.service';
import {
  LLM_CLIENT,
  withContext,
  type LlmClient,
  type PseudonymizedText,
} from './llm-client.port';
import {
  CANDIDATES,
  candidatesContext,
  LINES_INSTRUCTIONS,
  LINES_MAX_TOKENS,
  LINES_PROMPT_VERSION,
  LINES_PURPOSE,
  linesAnswer,
  MAPPING_INSTRUCTIONS,
  MAPPING_MAX_TOKENS,
  MAPPING_PROMPT_VERSION,
  MAPPING_PURPOSE,
  mappingAnswer,
  MOST_LINES,
  vocabularyContext,
  writtenLines,
} from './prescription-reading.prompts';
import { noteText } from './problem-coding.prompts';
import {
  PSEUDONYMIZER,
  type Pseudonymizer,
  restorePlaceholders,
} from './pseudonymizer.port';
import {
  type SuggestionRequester,
  SuggestionService,
} from './suggestion.service';

/** AS-077. The same deadline as the CIE-10 reading: a physician is waiting. */
export const PRESCRIPTION_READING_LIMIT_MS = 90_000;

/** The trail's names: the history read, and the note sent cleared (EN-122). */
const RESOURCE_TYPE = 'assistant_prescription';
const READING_RESOURCE_TYPE = 'assistant_prescription_reading';

/** AS-069. What the screen says of the chart's allergies, once, above the lines. */
export interface AllergyCheck {
  /** False when they could not be read or compared: nothing is «sin conflicto». */
  checked: boolean;
  /** PR-064. Allergies recorded only as text: the rule cannot compare them. */
  uncoded: boolean;
  /** EN-087. No allergy and nobody ever asserted there is none. */
  notAsked: boolean;
}

export interface PrescriptionLineView {
  id: string;
  quote: string;
  section: string;
  medicine: PrescriptionProposal['medicine'];
  fields: ProposedFields;
  instructions: string | null;
  unsaid: UnsaidField[];
  doseByWeight: boolean;
  /** Null for a line with no medicine: there is nothing to compare. */
  allergy: AllergyVerdict | null;
  /** Why it cannot go to the receta now, or null. */
  block: LineBlock | null;
  status: SuggestionStatus;
  /** The receta it went to, once linked. */
  prescriptionId: string | null;
  /**
   * AS-275. Linked, and its medicine still in a standing receta of the
   * attention; false once «Quitar» took it out; null while undecided.
   */
  inPrescription: boolean | null;
  /** AS-270. Why the medicine went without presentation. */
  presentationGap: 'none' | 'several' | null;
  demo: boolean;
}

export interface PrescriptionOverview {
  lines: PrescriptionLineView[];
  allergies: AllergyCheck;
  readAt: Date | null;
  demo: boolean;
}

export interface PrescriptionReadingResult extends PrescriptionOverview {
  found: number;
  dropped: number;
}

/** AS-069, AS-070. The allergies read now, or the failure to read them. */
type AllergyCheckResult =
  | {
      ok: true;
      allergies: readonly KnownAllergy[];
      keys: SubstanceKeys;
      uncoded: boolean;
      notAsked: boolean;
    }
  | { ok: false };

/** AS-073. A line ready for the draft, in the receta's codes. */
export interface ConfirmedLine {
  suggestionId: string;
  conceptId: string;
  dosageForm: DosageForm | null;
  concentration: string | null;
  routeCode: MedicationRoute | null;
  doseAmount: number | null;
  doseUnit: DoseUnit | null;
  frequency: Frequency | null;
  frequencyText: string | null;
  durationDays: number | null;
  quantity: number | null;
  instructions: string | null;
}

/**
 * AS-063 to AS-078. The receta the assistant proposes in Receta: the lines
 * the note prescribes, found in the CNMB, checked against the allergies with
 * no model, and handed to the physician — who puts them in the draft through
 * the receta's own route. Nothing here writes a receta (P1).
 */
@Injectable()
export class PrescriptionProposalService {
  private readonly logger = new Logger(PrescriptionProposalService.name);
  private readonly reading = new Set<string>();

  constructor(
    @Inject(CODING_CONTEXT_READER) private readonly context: CodingContextReader, // prettier-ignore
    @Inject(PRESCRIBING_CONTEXT_READER) private readonly prescribing: PrescribingContextReader, // prettier-ignore
    @Inject(SURVIVING_CHART_ALLERGY_READER) private readonly allergies: SurvivingChartAllergyReader, // prettier-ignore
    @Inject(ALLERGY_ABSENCE_READER) private readonly absences: AllergyAbsenceReader, // prettier-ignore
    @Inject(PSEUDONYMIZER) private readonly pseudonymizer: Pseudonymizer,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly suggestions: SuggestionService,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    @Inject(ASSISTANT_DEMO) private readonly demo: boolean,
  ) {}

  /** AS-069, AS-072, AS-076. What Receta shows: checked again, now. */
  async overview(
    encounterId: string,
    requester: ProposalRequester,
  ): Promise<PrescriptionOverview> {
    const encounter = await this.encounterFor(encounterId, requester.readSites);
    const overview = await this.overviewOf(encounter, requester);
    await this.trail(encounter, requester);
    return overview;
  }

  /**
   * AS-063 to AS-070, AS-072, AS-077, AS-078. Reads the receta out of the
   * note. The allergies are read FIRST: without them nothing is proposed and
   * nothing is paid for (AS-070).
   */
  async read(
    encounterId: string,
    requester: ProposalRequester,
  ): Promise<PrescriptionReadingResult> {
    const encounter = await this.ownLiveEncounter(encounterId, requester);
    if (this.reading.has(encounter.id)) {
      throw new AssistantReadingInProgressError();
    }
    this.reading.add(encounter.id);
    try {
      return await this.readNote(encounter, requester);
    } finally {
      this.reading.delete(encounter.id);
    }
  }

  private async readNote(
    encounter: CodingEncounter,
    requester: ProposalRequester,
  ): Promise<PrescriptionReadingResult> {
    const note = await this.context.consultationNote(encounter.id);
    if (!note || note.sections.length === 0) {
      throw new AssistantNoteEmptyError();
    }
    // AS-070. Fail closed before any call: an unreadable chart proposes nothing.
    const allergyCheck = await this.allergyCheckOf(encounter, []);
    if (!allergyCheck.ok) throw new AssistantAllergyCheckFailedError();

    // EN-122. The note leaves for a provider: who asked is in the trail first.
    await this.audit.record({
      userId: requester.userId,
      resourceType: READING_RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'EXPORT',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    const signal = AbortSignal.timeout(PRESCRIPTION_READING_LIMIT_MS);
    const people = await this.context.people(encounter.id);
    const clear = async (text: string) => {
      const cleared = await this.pseudonymizer.pseudonymize(
        { text, subject: encounter.patientId, names: people.patient, staff: people.staff }, // prettier-ignore
        signal,
      );
      // AS-025 (P4). An identifier still in the cleared text: fail closed.
      if (carriesAnIdentifier(cleared.cleared)) {
        throw new PseudonymizerFailedError('invalid-answer');
      }
      return cleared;
    };

    const cleared = await clear(noteText(note.sections));
    const read = await this.llm.generate({
      tier: 'quality',
      purpose: LINES_PURPOSE,
      promptVersion: LINES_PROMPT_VERSION,
      system: LINES_INSTRUCTIONS,
      prompt: withContext(cleared.cleared, vocabularyContext()),
      answer: linesAnswer,
      maxTokens: LINES_MAX_TOKENS,
      signal,
      encounterId: encounter.id,
    });
    if (read.runId === null) throw new AssistantProposalNotKeptError();

    const backed = backedLines({
      read: read.value.lines.slice(0, MOST_LINES).map(knownCodes),
      cleared: cleared.cleared,
      sections: note.sections,
      restore: (text) => restorePlaceholders(text, cleared.replacements),
    });

    // AS-064. The system searches; the model only chooses from what it found.
    const candidates = await Promise.all(
      backed.kept.map(
        (line) =>
        this.prescribing.searchCnmb(cnmbSearchName(line.drug), encounter.clinicalDate, CANDIDATES), // prettier-ignore
      ),
    );
    const chosen = await this.choose(backed.kept, candidates, clear, signal, encounter.id); // prettier-ignore

    const proposals = backed.kept.map((line, at): PrescriptionProposal => {
      const choice = chosen[at];
      // m3. The medicine chosen is the one the sentence writes, or none.
      const medicine =
        choice && chosenIsWritten(choice.medicine.display, line.quote)
          ? choice.medicine
          : null;
      // AS-269, AS-270. The model's presentation when it agrees with what
      // was written; else the only one that does, or none and why.
      const presentation = medicine
        ? choosePresentation(medicine.presentations, choice?.presentation, {
            form: line.form,
            strength: line.strength ?? strengthIn(line.quote, line.drug),
          })
        : null;
      const { fields, unsaid, doseByWeight } = medicine
        ? proposedFields(
            { ...line, strength: presentation?.strength ?? null },
            presentation?.chosen ?? null,
            noteText(note.sections),
            { strengthDeduced: presentation?.strengthDeduced ?? false },
          )
        : { fields: unchosen(), unsaid: [], doseByWeight: false };
      return {
        quote: line.quote,
        section: line.section,
        // AS-065. No name of the model's: only the cuadro's, or none.
        medicine: medicine
          ? { conceptId: medicine.conceptId, code: medicine.code, display: medicine.display } // prettier-ignore
          : null,
        controlled: medicine?.controlled ?? false,
        fields,
        instructions: medicine ? line.instructions : null,
        unsaid,
        doseByWeight,
        presentationGap: presentation?.gap ?? null,
        text: canonicalLine(medicine?.conceptId ?? null, fields),
        demo: this.demo,
      };
    });

    // AS-077. Up to 90 s went by: nothing is kept on an attention closed since.
    await this.ownLiveEncounter(encounter.id, requester);
    if (proposals.length > 0) {
      await this.suggestions.propose(
        proposals.map((proposal) => ({
          encounterId: encounter.id,
          aiRunId: read.runId!,
          kind: 'prescription-item',
          proposal: { ...proposal },
          sources: [{ kind: 'chart', table: 'clinical_note', id: note.id }],
        })),
        writer(requester),
      );
    }

    // AS-078. Counts only: no medicine, no phrase reaches the log.
    this.logger.log(
      {
        assistant_lines: proposals.length,
        assistant_lines_without_quote: backed.dropped,
        assistant_lines_in_cnmb: proposals.filter((each) => each.medicine).length, // prettier-ignore
      },
      'assistant prescription read',
    );

    return {
      ...(await this.overviewOf(encounter, requester)),
      found: proposals.length,
      dropped: backed.dropped,
    };
  }

  /**
   * AS-064. One call for every line that found candidates: which medicine and
   * presentation it is. A number the model was not offered is no choice.
   */
  private async choose(
    lines: readonly { drug: string; strength: string | null; form: string | null }[], // prettier-ignore
    candidates: readonly CnmbMedicine[][],
    clear: (text: string) => Promise<{ cleared: PseudonymizedText }>,
    signal: AbortSignal,
    encounterId: string,
  ): Promise<
    ({
      medicine: CnmbMedicine;
      presentation: CnmbMedicine['presentations'][number] | undefined;
    } | null)[]
  > {
    // prettier-ignore
    if (candidates.every((each) => each.length === 0)) {
      return lines.map(() => null);
    }
    // The lines were read from the patient's note: they go cleared again.
    const written = await clear(writtenLines(lines));
    const answer = await this.llm.generate({
      tier: 'quality',
      purpose: MAPPING_PURPOSE,
      promptVersion: MAPPING_PROMPT_VERSION,
      system: MAPPING_INSTRUCTIONS,
      prompt: withContext(written.cleared, candidatesContext(candidates)),
      answer: mappingAnswer,
      maxTokens: MAPPING_MAX_TOKENS,
      signal,
      encounterId,
    });
    return lines.map((_, at) => {
      const choice = answer.value.choices.find((each) => each.line === at + 1);
      const medicine =
        choice?.medicine == null
          ? undefined
          : candidates[at]?.[choice.medicine - 1];
      if (!medicine) return null;
      return {
        medicine,
        presentation:
          choice?.presentation == null
            ? undefined
            : medicine.presentations[choice.presentation - 1],
      };
    });
  }

  /**
   * AS-073. The accepted lines, checked again now, ready for the draft.
   * Nothing is written: the screen composes or rewrites the draft through
   * the receta's own route.
   */
  async confirm(
    input: { encounterId: string; suggestionIds: readonly string[] },
    requester: ProposalRequester,
  ): Promise<ConfirmedLine[]> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    const stored = await this.suggestions.ofEncounter(encounter.id, writer(requester), 'prescription-item'); // prettier-ignore
    const shown = await this.shownOf(encounter, stored);
    const wanted = [...new Set(input.suggestionIds)];
    const picked = wanted.map((id) => shown.find((each) => each.id === id));

    const proposals = picked.flatMap((each) =>
      each ? [proposalOf(each)] : [],
    );
    const check = await this.allergyCheckOf(
      encounter,
      proposals.flatMap((each) => (each.medicine ? [each.medicine.conceptId] : [])), // prettier-ignore
    );
    if (!check.ok) throw new AssistantAllergyCheckFailedError();
    const prescribed = new Set(await this.prescribing.prescribedCodes(encounter.id)); // prettier-ignore

    const notReady: string[] = [];
    const allergic: string[] = [];
    for (const [at, id] of wanted.entries()) {
      const suggestion = picked[at];
      if (!suggestion || suggestion.status !== 'PROPOSED') {
        notReady.push(id);
        continue;
      }
      const proposal = proposalOf(suggestion);
      const block = blockOf(proposal, {
        prescribed,
        allergy: verdictFor(proposal, check),
      });
      if (block === 'allergy-exact') allergic.push(id);
      else if (block !== null) notReady.push(id);
    }
    if (notReady.length > 0) {
      throw new AssistantPrescriptionLineNotReadyError(notReady);
    }
    if (allergic.length > 0) {
      throw new AssistantAllergyContraindicationError(allergic);
    }

    await this.trail(encounter, requester);
    return picked.map((suggestion) => {
      const proposal = proposalOf(suggestion!);
      const { fields } = proposal;
      return {
        suggestionId: suggestion!.id,
        conceptId: proposal.medicine!.conceptId,
        dosageForm: fields.form,
        concentration: fields.concentration,
        routeCode: fields.route,
        doseAmount: fields.doseAmount,
        doseUnit: fields.doseUnit,
        frequency: fields.frequency,
        frequencyText: fields.frequencyText,
        durationDays: fields.durationDays,
        quantity: fields.quantity,
        instructions: proposal.instructions,
      };
    });
  }

  /**
   * AS-074. Links each proposal to the receta its line was saved in, reading
   * that line: «tal cual» when it says what was proposed, «con cambios»
   * otherwise. The distance is the system's, never the caller's.
   */
  async link(
    input: {
      encounterId: string;
      prescriptionId: string;
      lines: readonly { suggestionId: string; line: number }[];
    },
    requester: ProposalRequester,
  ): Promise<PrescriptionOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    const stored = await this.suggestions.ofEncounter(encounter.id, writer(requester), 'prescription-item'); // prettier-ignore
    // Everything is checked before anything is written: one link that cannot
    // be made leaves none made (reviews of 12-10-2026).
    const ids = input.lines.map((each) => each.suggestionId);
    const lines = input.lines.map((each) => each.line);
    if (
      new Set(ids).size !== ids.length ||
      new Set(lines).size !== lines.length
    ) {
      throw new SuggestionInvalidError('lines');
    }
    const shown = await this.shownOf(encounter, stored);
    const saved = await Promise.all(
      input.lines.map(async ({ suggestionId, line }) => {
        const suggestion = shown.find((each) => each.id === suggestionId);
        if (!suggestion) throw new SuggestionNotFoundError();
        if (suggestion.status !== 'PROPOSED') {
          throw new SuggestionAlreadyDecidedError();
        }
        const written = await this.prescribing.prescriptionLine(
          encounter.id,
          input.prescriptionId,
          line,
        );
        // The line saved is of THIS proposal's medicine: a line of another
        // one is not the proposal's doing, and would spoil phase F.
        const medicine = proposalOf(suggestion).medicine;
        if (!written || !medicine || written.conceptId !== medicine.conceptId) {
          throw new SuggestionPrescriptionMismatchError();
        }
        return { suggestionId, text: savedText(written) };
      }),
    );
    for (const { suggestionId, text } of saved) {
      await this.suggestions.accept(
        { suggestionId, recordId: input.prescriptionId, saved: text },
        writer(requester),
      );
    }
    await this.trail(encounter, requester);
    return this.overviewOf(encounter, requester);
  }

  /** AS-075. The physician says no to a line. */
  async discard(
    input: { encounterId: string; suggestionId: string },
    requester: ProposalRequester,
  ): Promise<PrescriptionOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    const stored = await this.suggestions.ofEncounter(encounter.id, writer(requester), 'prescription-item'); // prettier-ignore
    if (!stored.some((each) => each.id === input.suggestionId)) {
      throw new SuggestionNotFoundError();
    }
    await this.suggestions.discard(input.suggestionId, writer(requester));
    await this.trail(encounter, requester);
    return this.overviewOf(encounter, requester);
  }

  /** AS-069, AS-072. The current reading, with its checks made now. */
  private async overviewOf(
    encounter: CodingEncounter,
    requester: ProposalRequester,
  ): Promise<PrescriptionOverview> {
    // Read with the sites where the requester reads the history (AS-076).
    const stored = await this.suggestions.ofEncounter(
      encounter.id,
      { userId: requester.userId, sites: requester.readSites },
      'prescription-item',
    );
    const shown = await this.shownOf(encounter, stored);
    const proposals = shown.map(proposalOf);
    const check = await this.allergyCheckOf(
      encounter,
      proposals.flatMap((each) => (each.medicine ? [each.medicine.conceptId] : [])), // prettier-ignore
    );
    const prescribed = new Set(await this.prescribing.prescribedCodes(encounter.id)); // prettier-ignore

    return {
      lines: shown.map((suggestion, at) => {
        const proposal = proposals[at]!;
        const allergy = proposal.medicine ? verdictFor(proposal, check) : null;
        return {
          id: suggestion.id,
          quote: proposal.quote,
          section: proposal.section,
          medicine: proposal.medicine,
          fields: proposal.fields,
          instructions: proposal.instructions,
          unsaid: proposal.unsaid,
          doseByWeight: proposal.doseByWeight,
          allergy,
          block:
            suggestion.status === 'PROPOSED'
              ? blockOf(proposal, { prescribed, allergy: allergy ?? 'none' })
              : null,
          status: suggestion.status,
          prescriptionId:
            suggestion.record?.kind === 'prescription'
              ? suggestion.record.id
              : null,
          inPrescription:
            suggestion.status === 'PROPOSED' || !proposal.medicine
              ? null
              : prescribed.has(proposal.medicine.code),
          presentationGap: proposal.presentationGap ?? null,
          demo: proposal.demo,
        };
      }),
      allergies: check.ok
        ? { checked: true, uncoded: check.uncoded, notAsked: check.notAsked }
        : { checked: false, uncoded: false, notAsked: false },
      readAt: shown[0]?.proposedAt ?? null,
      demo: this.demo,
    };
  }

  /**
   * AS-072. The lines of the latest reading, less the discarded, whose
   * sentence the note still says (AS-063 at showing time, as AS-028).
   */
  private async shownOf(
    encounter: CodingEncounter,
    stored: readonly SuggestionView[],
  ): Promise<SuggestionView[]> {
    const sections: NoteSectionText[] =
      (await this.context.consultationNote(encounter.id))?.sections ?? [];
    return currentReading(stored).filter((suggestion) => {
      const { quote } = suggestion.proposal as { quote?: unknown };
      return typeof quote === 'string' && locateQuote(quote, sections) !== null;
    });
  }

  /**
   * AS-069, AS-070. The chart's allergies and the keys to compare them, read
   * now. ANY failure is `ok: false` — never an empty list, never «none».
   */
  private async allergyCheckOf(
    encounter: CodingEncounter,
    conceptIds: readonly string[],
  ): Promise<AllergyCheckResult> {
    try {
      const [allergies, absence] = await Promise.all([
        this.allergies.activeForSurvivorOf(encounter.patientId),
        this.absences.standingAbsenceFor(encounter.patientId),
      ]);
      const keys = await this.prescribing.substanceKeys([
        ...conceptIds,
        ...allergies.flatMap((each) => (each.substanceConceptId ? [each.substanceConceptId] : [])), // prettier-ignore
      ]);
      return {
        ok: true,
        allergies,
        keys,
        uncoded: allergies.some((each) => each.substanceConceptId === null),
        notAsked: allergies.length === 0 && absence === null,
      };
    } catch (error) {
      // AS-078. The failure, never what was being read.
      this.logger.warn(
        { dependency: 'patient_allergy', error_code: error instanceof Error ? error.name : 'unknown' }, // prettier-ignore
        'assistant allergy check failed',
      );
      return { ok: false };
    }
  }

  private async trail(
    encounter: CodingEncounter,
    requester: ProposalRequester,
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }

  /** EN-121. Absent and out of reach are one answer. */
  private async encounterFor(
    encounterId: string,
    sites: 'all' | readonly string[],
  ): Promise<CodingEncounter> {
    const encounter = await this.context.encounter(encounterId, sites);
    if (!encounter) throw new AssistantEncounterNotFoundError();
    return encounter;
  }

  /** AS-076 (AS-039, M-02). Its own professional, where they write, while live. */
  private async ownLiveEncounter(
    encounterId: string,
    requester: ProposalRequester,
  ): Promise<CodingEncounter> {
    const encounter = await this.encounterFor(encounterId, requester.writeSites); // prettier-ignore
    if (encounter.practitionerUserId !== requester.userId) {
      throw new AssistantNotEncounterOwnerError();
    }
    if (!acceptsNewContent(encounter.status)) {
      throw new AssistantEncounterClosedError();
    }
    return encounter;
  }
}

function writer(requester: ProposalRequester): SuggestionRequester {
  return { userId: requester.userId, sites: requester.writeSites };
}

function proposalOf(suggestion: SuggestionView): PrescriptionProposal {
  return suggestion.proposal as unknown as PrescriptionProposal;
}

/** AS-065. A line with no medicine carries no field: the physician writes it. */
function unchosen(): ProposedFields {
  return {
    form: null,
    concentration: null,
    route: null,
    doseAmount: null,
    doseUnit: null,
    frequency: null,
    frequencyText: null,
    durationDays: null,
    quantity: null,
  };
}

function verdictFor(
  proposal: PrescriptionProposal,
  check: AllergyCheckResult,
): AllergyVerdict {
  if (!check.ok) return 'failed';
  if (!proposal.medicine) return 'none';
  return allergyVerdictOf(proposal.medicine.conceptId, check.allergies, check.keys); // prettier-ignore
}

/** AS-074. The saved line in the same canonical text as the proposal. */
function savedText(line: PrescribedLine): string {
  return canonicalLine(line.conceptId, {
    form: line.dosageFormCode as DosageForm | null,
    concentration: line.concentration,
    route: line.routeCode as MedicationRoute | null,
    doseAmount: line.doseAmount,
    doseUnit: line.doseUnitCode as DoseUnit | null,
    frequency: line.frequencyCode as Frequency | null,
    frequencyText: line.frequencyCode === null ? line.frequencyText : null,
    durationDays: line.durationDays,
    quantity: line.quantity,
  });
}
