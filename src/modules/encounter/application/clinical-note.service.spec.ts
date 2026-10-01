import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  AmendmentReasonRequiredError,
  DischargeConditionRequiredError,
  EncounterAlreadyClosedError,
  NoteAlreadySignedError,
  NoteContentIncompleteError,
  NoteNotAmendableError,
  PractitionerNotLicensedError,
  PractitionerProfileRequiredError,
  UnknownClinicalFormError,
} from '../domain/encounter.errors';
import { contentHashOf } from '../domain/clinical-note';
import type {
  AmendmentDraft,
  ClinicalNoteRepository,
  ClinicalNoteView,
  NewClinicalNote,
  NoteEncounterRead,
  NoteQuery,
  SignaturePlan,
} from '../domain/clinical-note.repository';
import type {
  EncounterRepository,
  PractitionerIdentity,
} from '../domain/encounter.repository';
import type { NoteContent } from '../domain/clinical-note';
import type { Requester } from './encounter.service';
import { ClinicalNoteService } from './clinical-note.service';

/**
 * The note chain's use cases, against in-memory ports.
 *
 * ⚠️ THE IMMUTABILITY OF A SIGNED NOTE IS *NOT* PROVEN HERE and cannot be: it
 * is `trg_clinical_note_immutable`, and a double that refuses what we told it
 * to refuse demonstrates nothing. It is attacked directly in
 * `test/integration/encounter-notes.spec.ts`. What lives here is the order of
 * the refusals, the ACESS check at the instant of signing, and the shape of
 * what an amendment writes.
 */

const SITE = 'site-1';
const PRACTITIONER = 'practitioner-1';
const USER = 'user-1';
const ENCOUNTER = 'encounter-1';

const requester: Requester = { userId: USER, sites: [SITE] };

const COMPLETE_002: NoteContent = {
  motivoConsulta: 'Dolor abdominal de dos días',
  antecedentes: 'Sin antecedentes patológicos de importancia',
  enfermedadActual: 'Dolor en epigastrio, sin irradiación',
  revisionOrganosSistemas: 'Resto de sistemas sin particularidades',
  examenFisico: 'Abdomen blando, doloroso a la palpación',
  planTratamiento: 'Dieta blanda y control en 72 horas',
};

/**
 * The same form MINUS one section, without a destructuring the linter reads as
 * a dead variable. Built by omission rather than by listing the survivors so
 * adding a mandatory section to the 002 does not silently make this a
 * different test.
 */
function without(section: keyof typeof COMPLETE_002) {
  return Object.fromEntries(
    Object.entries(COMPLETE_002).filter(([name]) => name !== section),
  );
}

const aNote = (
  overrides: Partial<ClinicalNoteView> = {},
): ClinicalNoteView => ({
  id: 'note-1',
  encounterId: ENCOUNTER,
  chainId: 'note-1',
  version: 1,
  formCode: '002',
  formVersion: '1',
  status: 'DRAFT',
  content: COMPLETE_002,
  authorId: PRACTITIONER,
  signedById: null,
  signedAt: null,
  contentHash: null,
  supersedesId: null,
  amendmentReason: null,
  createdAt: new Date('2026-09-14T14:10:00Z'),
  ...overrides,
});

const anEncounterRead = (
  overrides: Partial<NoteEncounterRead> = {},
): NoteEncounterRead => ({
  id: ENCOUNTER,
  status: 'OPEN',
  practitionerId: PRACTITIONER,
  endedAt: null,
  dischargeCondition: null,
  ...overrides,
});

class FakeNotes implements ClinicalNoteRepository {
  stored: ClinicalNoteView = aNote();
  encounter: NoteEncounterRead = anEncounterRead();
  drafted: NewClinicalNote[] = [];
  signature?: SignaturePlan;
  amendment?: AmendmentDraft;

  createDraft(draft: NewClinicalNote): Promise<ClinicalNoteView> {
    this.drafted.push(draft);
    return Promise.resolve(this.stored);
  }

  findById(): Promise<ClinicalNoteView | null> {
    return Promise.resolve(this.stored);
  }

  listOfEncounter(): Promise<readonly ClinicalNoteView[]> {
    return Promise.resolve([this.stored]);
  }

  updateDraft(
    _query: NoteQuery,
    content: NoteContent,
    decide: (note: ClinicalNoteView) => void,
  ): Promise<ClinicalNoteView> {
    decide(this.stored);
    this.stored = { ...this.stored, content };
    return Promise.resolve(this.stored);
  }

  sign(
    _query: NoteQuery,
    decide: (
      note: ClinicalNoteView,
      encounter: NoteEncounterRead,
    ) => SignaturePlan,
  ): Promise<ClinicalNoteView> {
    this.signature = decide(this.stored, this.encounter);
    this.stored = {
      ...this.stored,
      status: 'SIGNED',
      signedById: this.signature.signedById,
      signedAt: this.signature.signedAt,
      contentHash: this.signature.contentHash,
    };
    return Promise.resolve(this.stored);
  }

  amend(
    _query: NoteQuery,
    decide: (
      previous: ClinicalNoteView,
      encounter: NoteEncounterRead,
    ) => AmendmentDraft,
  ): Promise<ClinicalNoteView> {
    this.amendment = decide(this.stored, this.encounter);
    return Promise.resolve(
      aNote({
        id: 'note-2',
        chainId: this.amendment.chainId,
        version: this.amendment.version,
        status: 'SIGNED',
        content: this.amendment.content,
        supersedesId: this.amendment.supersedesId,
        amendmentReason: this.amendment.amendmentReason,
      }),
    );
  }

  retract(
    _query: NoteQuery,
    decide: (note: ClinicalNoteView) => void,
  ): Promise<ClinicalNoteView> {
    decide(this.stored);
    this.stored = { ...this.stored, status: 'ENTERED_IN_ERROR' };
    return Promise.resolve(this.stored);
  }
}

/** Only the one method the note service uses of the attention's port. */
class FakeEncounters {
  practitioner: PractitionerIdentity | null = {
    practitionerId: PRACTITIONER,
    acessExpiresOn: null,
  };

  findPractitionerByUser(): Promise<PractitionerIdentity | null> {
    return Promise.resolve(this.practitioner);
  }
}

describe('los casos de uso de la nota clínica', () => {
  let notes: FakeNotes;
  let encounters: FakeEncounters;
  let audit: AccessAuditRecorder & { entries: AccessAuditEntry[] };
  let service: ClinicalNoteService;

  beforeEach(() => {
    notes = new FakeNotes();
    encounters = new FakeEncounters();
    const entries: AccessAuditEntry[] = [];
    audit = {
      entries,
      record: (entry: AccessAuditEntry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    };
    const logger = {
      setContext: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as PinoLogger;

    service = new ClinicalNoteService(
      notes,
      encounters as unknown as EncounterRepository,
      audit,
      logger,
    );
  });

  const draftRequest = {
    encounterId: ENCOUNTER,
    formCode: '002',
    formVersion: '1',
    content: COMPLETE_002,
  };

  it('EN-021 abre la nota identificándola por el código de formulario como dato', async () => {
    await service.draft(draftRequest, requester);

    expect(notes.drafted[0]).toMatchObject({
      formCode: '002',
      formVersion: '1',
      authorId: PRACTITIONER,
    });
  });

  it('EN-021 rechaza un formulario no configurado antes de escribir nada', async () => {
    await expect(
      service.draft({ ...draftRequest, formCode: '033' }, requester),
    ).rejects.toBeInstanceOf(UnknownClinicalFormError);
    expect(notes.drafted).toEqual([]);
  });

  it('EN-020 acepta un borrador incompleto: se exige el contenido mínimo al FIRMAR', async () => {
    /**
     * A doctor writes the motive at 09:02 and the plan at 09:20, and a form
     * that refused to save until it was complete is a form nobody saves. The
     * signature is the moment the note becomes the record.
     */
    await service.draft(
      { ...draftRequest, content: { motivoConsulta: 'Control' } },
      requester,
    );

    expect(notes.drafted).toHaveLength(1);
  });

  it('EN-020 rechaza firmar una nota sin una sección obligatoria del artículo 6', async () => {
    notes.stored = aNote({ content: without('planTratamiento') });

    await expect(
      service.sign(
        { encounterId: ENCOUNTER, noteId: 'note-1', dischargeCondition: 'ALIVE' }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(NoteContentIncompleteError);
  });

  it('EN-027 firma registrando quién, cuándo y el resumen del contenido', async () => {
    const signed = await service.sign(
      { encounterId: ENCOUNTER, noteId: 'note-1', dischargeCondition: 'ALIVE' },
      requester,
    );

    expect(signed.status).toBe('SIGNED');
    expect(signed.signedById).toBe(PRACTITIONER);
    expect(signed.signedAt).not.toBeNull();
    // The digest is the one the domain computes over the content, the signer
    // and the instant — recomputed here so the service cannot have invented it.
    expect(signed.contentHash).toBe(
      contentHashOf({
        content: COMPLETE_002,
        signedById: PRACTITIONER,
        signedAt: signed.signedAt as Date,
      }),
    );
  });

  it('EN-130 da el alta clínica al firmar la nota de consulta externa', async () => {
    await service.sign(
      { encounterId: ENCOUNTER, noteId: 'note-1', dischargeCondition: 'ALIVE' },
      requester,
    );

    expect(notes.signature?.dischargesTheEncounter).toBe(true);
    expect(notes.signature?.dischargeCondition).toBe('ALIVE');
  });

  it('EN-009 rechaza firmar la consulta externa sin condición de egreso', async () => {
    /**
     * `encounter_discharge_states_a_condition` would refuse the discharge
     * anyway; refusing here is what turns it into a per-field sentence naming
     * the four admitted values, before the note has been written.
     */
    await expect(
      service.sign({ encounterId: ENCOUNTER, noteId: 'note-1' }, requester),
    ).rejects.toBeInstanceOf(DischargeConditionRequiredError);
  });

  it('EN-130 no da el alta al firmar una nota de evolución', async () => {
    // A patient can have three evolution notes in one visit; discharging on
    // the first would end the attention before it had begun.
    notes.stored = aNote({
      formCode: '005',
      content: { evolucion: 'Se retira el vendaje sin incidencias' },
    });

    await service.sign({ encounterId: ENCOUNTER, noteId: 'note-1' }, requester);

    expect(notes.signature?.dischargesTheEncounter).toBe(false);
    expect(notes.signature?.dischargeCondition).toBeNull();
  });

  it('EN-023 rechaza firmar una nota que ya está firmada', async () => {
    notes.stored = aNote({ status: 'SIGNED' });

    await expect(
      service.sign(
        { encounterId: ENCOUNTER, noteId: 'note-1', dischargeCondition: 'ALIVE' }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(NoteAlreadySignedError);
  });

  it('EN-130 rechaza abrir contenido clínico nuevo sobre una atención ya cerrada', async () => {
    notes.encounter = anEncounterRead({
      status: 'COMPLETED',
      endedAt: new Date('2026-09-14T15:00:00Z'),
      dischargeCondition: 'ALIVE',
    });

    await expect(
      service.sign(
        { encounterId: ENCOUNTER, noteId: 'note-1', dischargeCondition: 'ALIVE' }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(EncounterAlreadyClosedError);
  });

  it('EN-029 rechaza firmar con el registro ACESS vencido AYER', async () => {
    /**
     * Checked at the instant of SIGNING and never when the practitioner was
     * registered: a registration that lapses on Tuesday stops enabling on
     * Wednesday without anybody touching a row.
     */
    // Yesterday IN ECUADOR: from 19:00 in Guayaquil the UTC day before is
    // today, and the registration would still be in force.
    const yesterday = addDays(clinicalDateOf(new Date()), -1);
    encounters.practitioner = {
      practitionerId: PRACTITIONER,
      acessExpiresOn: new Date(`${yesterday}T00:00:00.000Z`),
    };

    await expect(
      service.sign(
        { encounterId: ENCOUNTER, noteId: 'note-1', dischargeCondition: 'ALIVE' }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(PractitionerNotLicensedError);
  });

  it('EN-029 admite firmar el mismo día en que caduca el registro', async () => {
    // The registration is in force THROUGH its expiry date: a column of type
    // `date` names a whole day, and refusing on that day would withdraw a
    // licence twenty-four hours early. Today IN ECUADOR: the UTC date is
    // already tomorrow from 19:00, and that would test the day after.
    const today = clinicalDateOf(new Date());
    encounters.practitioner = {
      practitionerId: PRACTITIONER,
      acessExpiresOn: new Date(`${today}T00:00:00.000Z`),
    };

    await expect(
      service.sign(
        { encounterId: ENCOUNTER, noteId: 'note-1', dischargeCondition: 'ALIVE' }, // prettier-ignore
        requester,
      ),
    ).resolves.toMatchObject({ status: 'SIGNED' });
  });

  it('EN-029 no exige registro ACESS a quien no tiene ninguno anotado', async () => {
    /**
     * Whether a practitioner MUST hold one is `staff`'s question (ST-002,
     * ST-005) and it is asked when they are registered. Asking it again here
     * would make this module the second place that decides who may practise,
     * and the two would drift. What this refuses is the one thing only the
     * signature can see: a registration whose date has passed.
     */
    encounters.practitioner = {
      practitionerId: PRACTITIONER,
      acessExpiresOn: null,
    };

    await expect(
      service.sign(
        { encounterId: ENCOUNTER, noteId: 'note-1', dischargeCondition: 'ALIVE' }, // prettier-ignore
        requester,
      ),
    ).resolves.toMatchObject({ status: 'SIGNED' });
  });

  it('EN-011 rechaza firmar desde una cuenta sin ficha profesional', async () => {
    encounters.practitioner = null;

    await expect(
      service.sign(
        { encounterId: ENCOUNTER, noteId: 'note-1', dischargeCondition: 'ALIVE' }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(PractitionerProfileRequiredError);
  });

  it('EN-025 enmienda creando una versión NUEVA que apunta a la anterior', async () => {
    notes.stored = aNote({
      status: 'SIGNED',
      signedById: PRACTITIONER,
      signedAt: new Date('2026-09-14T15:00:00Z'),
      contentHash: 'a'.repeat(64),
    });

    const corrected = { ...COMPLETE_002, planTratamiento: 'Dieta absoluta' };
    const amended = await service.amend(
      {
        encounterId: ENCOUNTER,
        noteId: 'note-1',
        content: corrected,
        amendmentReason: 'Se anotó el plan de la paciente anterior',
      },
      requester,
    );

    expect(amended.version).toBe(2);
    expect(amended.supersedesId).toBe('note-1');
    expect(amended.amendmentReason).toBe(
      'Se anotó el plan de la paciente anterior',
    );
    // BORN SIGNED: a correction left as a draft would leave the chain with no
    // current signed version at all.
    expect(notes.amendment?.signature.signedById).toBe(PRACTITIONER);
    // AND IT NEVER DISCHARGES: correcting a March note must not touch the
    // state of a March attention.
    expect(notes.amendment?.signature.dischargesTheEncounter).toBe(false);
  });

  it('EN-025 exige el motivo de la enmienda en el SERVICIO, no solo en el DTO', async () => {
    notes.stored = aNote({ status: 'SIGNED' });

    await expect(
      service.amend(
        { encounterId: ENCOUNTER, noteId: 'note-1', content: COMPLETE_002 },
        requester,
      ),
    ).rejects.toBeInstanceOf(AmendmentReasonRequiredError);
  });

  it('EN-025 admite enmendar una atención ya dada de alta', async () => {
    /**
     * ⚠️ DELIBERADO (EN-130): EN-025 no caduca porque la atención avance. Lo
     * que se rechaza tras el alta es contenido NUEVO, no la corrección de lo
     * que ya está escrito — una nota firmada con un error que no se puede
     * corregir es peor que la corrección.
     */
    notes.stored = aNote({ status: 'SIGNED' });
    notes.encounter = anEncounterRead({
      status: 'DISCHARGED',
      endedAt: new Date('2026-09-14T15:00:00Z'),
      dischargeCondition: 'ALIVE',
    });

    await expect(
      service.amend(
        {
          encounterId: ENCOUNTER,
          noteId: 'note-1',
          content: COMPLETE_002,
          amendmentReason: 'Se corrigió la dosis',
        },
        requester,
      ),
    ).resolves.toMatchObject({ version: 2 });
  });

  it('EN-025 rechaza enmendar un borrador: se edita y se firma', async () => {
    await expect(
      service.amend(
        {
          encounterId: ENCOUNTER,
          noteId: 'note-1',
          content: COMPLETE_002,
          amendmentReason: 'Da igual',
        },
        requester,
      ),
    ).rejects.toBeInstanceOf(NoteNotAmendableError);
  });

  it('EN-026 retracta una nota firmada sin reemplazo y sin borrarla', async () => {
    notes.stored = aNote({ status: 'SIGNED' });

    const retracted = await service.retract(
      { encounterId: ENCOUNTER, noteId: 'note-1' },
      requester,
    );

    expect(retracted.status).toBe('ENTERED_IN_ERROR');
    // The content, the signer and the instant survive: the row stays in the
    // history, which is what «no deberá desaparecer» means.
    expect(retracted.content).toEqual(COMPLETE_002);
    // AND IT POINTS AT NOTHING, which is how a client tells a retraction from
    // an amendment.
    expect(retracted.supersedesId).toBeNull();
  });

  it('EN-026 rechaza retractar una versión ya sustituida', async () => {
    notes.stored = aNote({ status: 'SUPERSEDED' });

    await expect(
      service.retract({ encounterId: ENCOUNTER, noteId: 'note-1' }, requester),
    ).rejects.toBeInstanceOf(NoteNotAmendableError);
  });

  it('EN-122 deja UNA fila de bitácora al leer las notas de una atención, no una por nota', async () => {
    await service.listOf(ENCOUNTER, requester);

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      resourceType: 'clinical_note',
      resourceId: ENCOUNTER,
      action: 'READ',
    });
  });
});
