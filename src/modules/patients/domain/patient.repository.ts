import type { RestOverlap } from '../../../shared/domain/rest-overlap';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type { PatientAge } from './patient-age';
import type {
  PatientCorrectionRequest,
  PatientCorrectionSnapshot,
} from './patient-corrections';
import type {
  PriorityGroup,
  PriorityGroupOrigin,
  RecordedPriorityGroup,
} from './priority-groups';
import type { RdacaaRequiredField } from './rdacaa-completeness';

/**
 * What the application needs from storage, stated without naming a database.
 *
 * A PORT: the application depends on this, the Prisma adapter implements it.
 * `dependency-cruiser` enforces the direction, and the reason is not purity —
 * it is that the search below is going to be rewritten (trigram today,
 * possibly a dedicated index later) and that rewrite must not reach a single
 * line of business logic.
 */

/** Sex as recorded. Never inferred, never defaulted. */
export type PatientSex = 'MALE' | 'FEMALE' | 'INTERSEX' | 'UNKNOWN';

/** PA-010. `PROVISIONAL` is a marker, not a document: it never makes a chart definitive. */
export type IdentifierType =
  'CEDULA' | 'PASSPORT' | 'REFUGEE_CARD' | 'FOREIGN_ID' | 'PROVISIONAL';

/** PA-010. A document is identified by the whole triple, never by its value alone. */
export interface PatientIdentifier {
  type: IdentifierType;
  /** ISO 3166-1 alpha-3. Two passports may share a number across countries. */
  issuingCountry: string;
  value: string;
}

/**
 * A patient as a list shows them.
 *
 * Deliberately NOT the whole record. A search result appears on screen for
 * every name typed, and shipping the full chart to draw a row would put
 * clinical data in memory nobody asked to see.
 */
export interface PatientSummary {
  id: string;
  /**
   * PA-041. The priority the agenda orders by — `1` prioritised, `2` ordinary
   * — ALREADY CALCULATED, and never the reason.
   *
   * It travels with `patient:read` on purpose: the waiting list needs the
   * ORDER to work, and the reason is health data behind its own audited door
   * (PA-040, AG-073). A listing that carried the reason «porque la pantalla ya
   * lo tiene» would hand the social diagnosis of half the clinic to anybody
   * who can open a waiting list (PA-042, SC-010).
   */
  priority: number;
  mrn: string;
  familyName: string;
  secondFamilyName: string | null;
  givenName: string;
  secondGivenName: string | null;
  sex: PatientSex;
  birthDate: Date;
  birthDateEstimated: boolean;
  deceasedAt: Date | null;
  /**
   * PA-030. DERIVED on every read, never stored.
   *
   * Resolved against the Ecuadorian date, and against the date of DEATH when
   * the chart records one — the age of a dead person does not keep growing.
   * Stored, it would be a fact that expires on a birthday nobody processes.
   */
  age: PatientAge;
  /**
   * PA-032. Which of the data the RDACAA demands are still missing.
   *
   * Empty means complete. It travels on the LISTING too, and it is one of the
   * only two things that do beyond the identity columns: admission works from
   * the list, and a chart it cannot see is incomplete is a chart nobody
   * completes until the Dirección Distrital returns the monthly report.
   */
  rdacaaMissingFields: readonly RdacaaRequiredField[];
  /**
   * The identifier a receptionist would quote. `null` for provisional records.
   *
   * A DEFINITIVE DOCUMENT OR NOTHING (`isDefinitiveDocument`). «Null en las
   * fichas provisionales» is only true if a `PROVISIONAL` marker cannot come
   * out of here: quoting `SN-001` back as the patient's document is how a
   * placeholder ends up typed into a claim.
   */
  primaryIdentifier: PatientIdentifier | null;
}

/**
 * A catalogue concept as the chart shows it back: the wording it was recorded
 * with (PA-026, PA-027, PA-029).
 *
 * ⚠️ READ WITHOUT CHECKING VALIDITY, on purpose and like `CatalogsService.byId`.
 * A parish withdrawn from the DPA must not blank out the address of somebody
 * who has not moved, and an ethnic category INEC reworded must still come back
 * as it was declared.
 */
export interface CatalogConceptReference {
  id: string;
  code: string;
  display: string;
}

/**
 * The residence, with province and canton DERIVED from the code (PA-028).
 *
 * They are prefixes — `left(code,2)` and `left(code,4)` — never columns. Two
 * rows of the INEC file declare a canton their own code contradicts, so a
 * stored canton would report those patients to the ministry in the wrong one
 * without anything failing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NAMES TOO, AND LOOKING THEM UP IS STILL DERIVING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «Provincia 06 · Cantón 0603» is what the screen could print with the codes
 * alone, and it tells nobody anything: a receptionist reads Chimborazo and
 * Guano, not the numbers the ministry files them under. So the DPA catalogue is
 * asked what the DERIVED code is called.
 *
 * That is NOT the same as storing the canton, and PA-028 is untouched: nothing
 * new is written, and the question asked of the catalogue is «what is 0603
 * called», never «which canton does this parish belong to». The two rows of the
 * INEC file whose descriptive column contradicts their own code cannot reach
 * this answer, because their column is not read.
 *
 * `null` when the name cannot be resolved — a parish from an older edition
 * whose canton is no longer in the catalogue. THE CODE STILL TRAVELS: losing
 * the name is a worse screen, losing the code would be a worse record.
 */
export interface ParishReference extends CatalogConceptReference {
  provinceCode: string | null;
  provinceDisplay: string | null;
  cantonCode: string | null;
  cantonDisplay: string | null;
}

/**
 * PA-053. El país de nacionalidad: el código guardado y cómo se llama.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO ES UN `CatalogConceptReference`, Y LA DIFERENCIA ES DELIBERADA.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No lleva `id` porque la ficha NO guarda una fila del catálogo: guarda tres
 * letras, igual que `patient_identifier.issuingCountry`. Dos representaciones
 * del mismo país en la misma base —un `uuid` aquí y un alpha-3 allí— acaban
 * discrepando, y entonces nadie puede cruzar «pacientes venezolanos» con
 * «documentos emitidos en Venezuela».
 *
 * `display` es `null` cuando el catálogo no puede nombrarlo —una edición
 * anterior, un país que se dividió—. EL CÓDIGO SIGUE VIAJANDO: un nombre que
 * falta es una pantalla peor, un código que falta es un registro peor. Mismo
 * criterio que la provincia y el cantón de {@link ParishReference}.
 */
export interface CountryReference {
  /** `ISO 3166-1 alpha-3`, tal como se guardó. */
  code: string;
  display: string | null;
}

/**
 * PA-054. Which charts THIS one absorbed, seen from the survivor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HALF PA-043 WAS MISSING: THE LINK ONLY RAN ONE WAY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PA-043 keeps the absorbed chart pointing at the survivor, and PA-045 makes
 * opening it answer `PATIENT_MERGED` naming where its history went. Both walk
 * the link in the same direction — absorbed → survivor. From the survivor there
 * was nothing at all: neither `PatientDetail` nor the listing row said this
 * chart had absorbed another, and `GET /patients` cannot filter by target. A
 * link that can only be walked one way does not let anybody KNOW there is
 * something on the other side, and knowing is the precondition for following
 * it.
 *
 * WHAT IT IS FOR (D-038, REQ-008): admission merges a patient's two charts
 * correctly. The absorbed one carried her PENICILLIN ALLERGY. The doctor opens
 * the surviving chart, sees no allergy, and prescribes. D-031 decided the
 * history is not re-pointed and is read THROUGH THE LINK; this is what lets a
 * reader find out the link exists.
 *
 * ⚠️ IT DOES NOT SETTLE D-038, and must not be read as doing so. D-038 decides
 * WHO reads through the link — every clinical module, a re-point of allergies
 * only, or one shared query — and all three options need the survivor to know
 * it has absorbed charts. This makes the problem visible; it does not solve it.
 */
export interface AbsorbedCharts {
  /** How many charts this one absorbed. `0` while it absorbed none. */
  total: number;
  /**
   * Their MRNs, oldest merge first, CAPPED at {@link ABSORBED_MRN_LIMIT}.
   *
   * The MRN and not a bare counter: «absorbed 2» names a problem and hands
   * nobody anything to go and look at it with. The MRN is what a person quotes
   * and what gets typed into the register search, so it is what lets somebody
   * REACH the other chart.
   *
   * And nothing else of that chart — no name, no document, no birth date.
   * PA-025 forbids it, and the MRN is precisely the one thing this module
   * already publishes about a chart that is not the one being read: it is what
   * `PATIENT_MERGED` names (PA-045).
   *
   * EMPTY, NEVER `null` and never absent. Three states where the domain has two
   * is how screen bugs are born.
   */
  mrns: readonly string[];
}

/**
 * How many absorbed MRNs travel on a chart before the number alone has to do
 * the talking (PA-054).
 *
 * A real duplicate is one chart, occasionally two. Beyond a handful the list
 * stops being a notice and becomes a wall, and what is actually needed is not a
 * longer list but the unified read D-038 decides. `total` travels alongside so
 * the truncation shows instead of lying by omission.
 */
export const ABSORBED_MRN_LIMIT = 5;

/**
 * PA-057, PA-058. What the gated read of the sexual orientation brings back.
 *
 * TWO FIELDS AND NOT ONE: `mergedIntoMrn` is here because PA-045 covers «toda
 * operación que la nombre», and reading a merged chart has to say where it went
 * instead of quietly answering `null` — which on this field would read as «no
 * se ha registrado» and send somebody to ask the patient again.
 */
export interface SexualOrientationRead {
  /** Set when this chart was absorbed by another (PA-043, PA-045). */
  mergedIntoMrn: string | null;
  /** `null` means nobody has recorded it yet, which is a legitimate answer. */
  orientation: CatalogConceptReference | null;
}

/**
 * The whole chart, as its own screen shows it. The sexual orientation is not
 * here: it is read through `findSexualOrientation`, under its own permission
 * (PA-058).
 */
export interface PatientDetail extends PatientSummary {
  phone: string | null;
  email: string | null;
  bloodType: string | null;
  residenceAddressLine: string | null;
  /** PA-061. Corrected, never asked at registration. */
  employerName: string | null;
  jobTitle: string | null;
  /** PA-026. Self-declared by the patient, chosen from a catalogue. */
  ethnicity: CatalogConceptReference | null;
  /** PA-027. */
  nationality: CatalogConceptReference | null;
  /**
   * PA-056. The people of column 14, third step of the chain.
   *
   * ⚠️ AND THE SEXUAL ORIENTATION OF COLUMN 7 IS NOT HERE, which is the visible
   * half of PA-058. It is special category data under the LOPDP and is read
   * through `findSexualOrientation` behind a permission of its own. Adding it
   * to this interface would remove that door with nothing failing.
   */
  people: CatalogConceptReference | null;
  /** PA-029. A datum DISTINCT from sex; neither is derived from the other. */
  genderIdentity: CatalogConceptReference | null;
  /**
   * PA-053. Which COUNTRY the patient is from, resolved to its name.
   *
   * ⚠️ NOT `nationality` above. That one is the RDACAA's nationality or
   * indigenous people — Kichwa, Shuar, Awa — a field the ministry's form only
   * enables when the ethnic self-identification is indigenous. This one is what
   * lets a chart say somebody is Venezuelan, which in Ecuador is a large part
   * of the daily demand. Both are needed and they are not the same question.
   *
   * ONLY ON THE CHART, never on the listing: PA-021 fires on every letter
   * typed, and naming the country costs a query.
   */
  countryOfNationality: CountryReference | null;
  /** PA-028. INEC DPA parish, with its province and canton derived. */
  residenceParish: ParishReference | null;
  /**
   * PA-009. The mother's chart.
   *
   * The whole point of the link is finding a newborn BEFORE they have a
   * document of their own, which is why the listing can filter by it: a link
   * nobody can traverse is a column, not a way of finding anyone.
   */
  motherPatientId: string | null;
  isProvisional: boolean;
  identifiers: readonly PatientIdentifier[];
  /** Set once a duplicate is resolved. The record stays, it does not vanish. */
  mergedIntoMrn: string | null;
  /**
   * PA-054. The link read BACKWARDS: which charts this one absorbed.
   *
   * ONLY ON THE CHART, never on the listing (PA-021). A search fires on every
   * letter typed and no result row needs this; paying a subquery per row for it
   * would put the cost on the hottest path of the module. Here it rides along
   * with the joins the chart already pays for.
   *
   * A chart that WAS absorbed never has absorbed charts of its own, and that is
   * not luck: PA-046 refuses the chain in both directions, so this is one hop
   * and nobody has to walk anything.
   */
  absorbedCharts: AbsorbedCharts;
  createdAt: Date;
}

/**
 * Por qué columna se ordena.
 *
 * UNA LISTA CERRADA, no el nombre de columna que llegue. La ordenación acaba
 * concatenada en SQL, así que aceptar texto libre es una inyección esperando
 * a ocurrir; y además obliga a decidir explícitamente qué es ordenable, que es
 * una decisión de producto y no un detalle de la tabla.
 */
export type PatientSortField = 'name' | 'mrn' | 'birthDate';
export type SortDirection = 'asc' | 'desc';

/** One page of the patient search, with the ordering picked from a closed list. */
export interface PatientSearchCriteria {
  sortBy: PatientSortField;
  sortDirection: SortDirection;
  /** Free text: name fragments, or an identifier typed in full. */
  query?: string;
  page: number;
  pageSize: number;
  /** Merged records are hidden unless explicitly asked for. */
  includeMerged: boolean;
  /**
   * PA-009. Only the charts whose mother is this one.
   *
   * COMBINES with the text search rather than replacing it: it is a filter,
   * and a newborn twenty minutes old is found by their mother precisely
   * because there is nothing else to type.
   */
  motherId?: string;
}

/** `total` counts every match, not just this page's items. */
export interface PatientPage {
  items: readonly PatientSummary[];
  total: number;
}

/**
 * A registration. No MRN: it comes from the database sequence inside the
 * insert (PA-001). At most one identifier, and none at all is a legitimate
 * registration (PA-003).
 */
export interface NewPatient {
  familyName: string;
  secondFamilyName?: string;
  givenName: string;
  secondGivenName?: string;
  sex: PatientSex;
  birthDate: Date;
  birthDateEstimated: boolean;
  phone?: string;
  email?: string;
  residenceAddressLine?: string;
  bloodType?: string;
  /**
   * The four references the RDACAA needs, ALL OPTIONAL (D-028).
   *
   * Optional at registration and mandatory when the first encounter is closed,
   * which belongs to `encounter`. The norm demands them «en cada consulta»,
   * not at registration, and refusing a chart at three in the morning with a
   * newborn in the room is what REQ-009 forbids. The chart says what is
   * missing instead (PA-032).
   */
  ethnicityConceptId?: string;
  nationalityConceptId?: string;
  /** PA-056. Only admissible on a Kichwa indigenous nationality. */
  peopleConceptId?: string;
  /** PA-057. Only admissible from ten years of age. */
  sexualOrientationConceptId?: string;
  residenceParishConceptId?: string;
  genderIdentityConceptId?: string;
  /**
   * PA-053. El país de nacionalidad, `ISO 3166-1 alpha-3`.
   *
   * OPCIONAL como los cuatro de arriba (D-028) y **fuera del indicador de
   * ficha incompleta** (PA-032): REQ-022 no lo pide, y marcar una ficha como
   * incompleta por un dato que el ministerio no exige convierte el indicador
   * en ruido que admisión aprende a ignorar.
   */
  countryOfNationalityCode?: string;
  motherPatientId?: string;
  identifier?: PatientIdentifier;
}

/**
 * A stored concept plus WHICH CATALOGUE it came from (PA-026 to PA-029).
 *
 * The system code is the half that matters when validating: a parish id sent
 * as an ethnicity exists, and accepting it would put a DPA row in the ethnic
 * self-identification of the monthly report. `patients` resolves this itself
 * instead of calling `catalogs`, because no module imports another.
 */
export interface CatalogReference {
  id: string;
  systemCode: string;
  code: string;
  display: string;
  validFrom: ClinicalDate;
  /** `null` means still in force. */
  validTo: ClinicalDate | null;
}

/** The chart as a correction finds it (PA-031). */
export interface PatientCorrectionState {
  /**
   * Set when the chart was merged into another. A merged chart is not
   * corrected — the caller is told where it went (PA-045).
   */
  mergedIntoMrn: string | null;
  values: PatientCorrectionSnapshot;
}

/**
 * What a correction actually did (PA-031).
 *
 * `changed` IS NOT COSMETIC. A request that re-sends the values already stored
 * changes nothing and must leave nothing behind — not a history row, which the
 * plan already refuses to produce, and NOT AN AUDIT ENTRY EITHER. `access_audit`
 * is append-only and never purged, so an `UPDATE` row for a mutation that did
 * not happen is a permanent claim that the chart was modified, with no history
 * row anywhere able to say what changed. The caller cannot work this out on its
 * own: only the transaction that read the locked snapshot knows.
 */
export interface AppliedCorrection {
  patient: PatientDetail;
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Duplicate resolution (P4: PA-043 to PA-049, REQ-010)
// ---------------------------------------------------------------------------

/**
 * Who a chart is and whether it was absorbed, WITHOUT OPENING IT (PA-045).
 *
 * SEPARATE FROM `findById` for the same reason `exists` is: opening a chart is
 * the accountable act that writes an audit row (PA-022), and asking «is this
 * one merged?» opens nothing. It carries the MRN because that is the only
 * thing `PATIENT_MERGED` is allowed to publish — an internal number, never a
 * name or a document.
 */
export interface PatientMergeState {
  id: string;
  mrn: string;
  /** MRN of the surviving chart. `null` while the chart is whole. */
  mergedIntoMrn: string | null;
}

/**
 * PA-049, D-031. What happens to the absorbed chart's records: NOTHING MOVES.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COUNTS ARE THE ANSWER, NOT DECORATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * D-031 settled the expensive question of this delivery on 16-08-2026: the
 * surviving chart READS THROUGH THE LINK and not a single child row is
 * re-pointed. Re-pointing would unify the history and make the merge
 * irreversible in practice — undoing it would mean remembering which rows had
 * moved, and an appointment created AFTER the merge must not travel back.
 *
 * The schema already did this without anybody deciding it, so PA-049 is about
 * making it VERIFIABLE: the merge answers with how much of the absorbed chart
 * stayed on it, and a test asserts both the answer and that the rows are still
 * there. A guarantee nobody can observe is a comment.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY TABLE THAT HANGS OFF THE CHART, AND WHY THE LIST IS THE WHOLE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This started as three counters — appointments, encounters, documents — and
 * three counters saying «nothing moved» is worse than no counter at all: the
 * person merging reads it as the complete answer and never learns that THE
 * ALLERGY LIST stayed on the old chart. Prescribing reads allergies by
 * `patient_id`, so a survivor that «reads through the link» and a prescriber
 * that does not is the one way D-031 can hurt somebody.
 *
 * So the list is walked against `schema.prisma`, not from memory: every table
 * carrying a FK to `patient` is either counted here or deliberately excluded
 * below.
 *
 * DELIBERATELY NOT COUNTED, and each for its own reason:
 *
 *   - `patient_identifier` — the documents of the absorbed chart are the one
 *     thing a merge is FOR, and they are not «what stayed behind».
 *   - `patient_change_history` and `patient_merge` — trails ABOUT the chart,
 *     not records of care. They describe the very operation being reported.
 *   - `patient.mother_patient_id` — a column on ANOTHER chart pointing here,
 *     not a row of this one. Counting it would silently change the field from
 *     «what hangs off this chart» to «what references it».
 */
export interface LinkedRecordCounts {
  /** `agenda_entry` rows still pointing at the absorbed chart. */
  appointments: number;
  /** `encounter` rows. */
  encounters: number;
  /**
   * Clinical documents issued to the chart: medical certificates and
   * referrals, which are the two that hang off the patient directly today.
   * Notes, prescriptions and reports hang off an encounter and travel with it.
   */
  documents: number;
  /**
   * `patient_allergy`. THE ONE THAT MADE THIS LIST GROW: an allergy left on the
   * absorbed chart is invisible to anybody prescribing against the survivor.
   */
  allergies: number;
  /** `patient_contact`: who to call, and who may consent. */
  contacts: number;
  /** `patient_priority_group`, which is what orders the waiting room. */
  priorityGroups: number;
  /**
   * `waitlist_entry` rows still hanging off the absorbed chart.
   *
   * ⚠️ STILL THE SAME ROWS AFTER PA-060, and that is what keeps this object
   * honest: re-enrolling on the survivor (D-041 B) creates a NEW row over
   * there and re-points nothing here, so this counter answers exactly what it
   * always answered — how many rows OF THE ABSORBED CHART stayed put.
   */
  waitlistEntries: number;
}

/**
 * One row of the merge event log, as the API answers it (PA-043, PA-044,
 * PA-047).
 *
 * The MRNs of BOTH charts travel: the absorbed one because printed documents
 * still quote it, and the surviving one because that is where everything is
 * read from now on. Nothing else of either patient does.
 */
export interface PatientMergeEvent {
  /**
   * `patient_merge.id`, AS A STRING. It is a `bigint`, and JSON has no integer
   * wide enough to be trusted with one.
   */
  mergeId: string;
  event: 'MERGE' | 'UNDO';
  sourcePatientId: string;
  sourceMrn: string;
  targetPatientId: string;
  targetMrn: string;
  performedAt: Date;
  linkedRecords: LinkedRecordCounts;
}

/**
 * What the database did with a merge, TOLD AS A FACT AND NOT AS AN ERROR.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY AN OUTCOME AND NOT AN EXCEPTION FROM THE ADAPTER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rule lives in ONE place — `trg_patient_merge_not_chained`, which also
 * locks the target row so two simultaneous merges cannot build a chain between
 * them — so the application must not repeat it: a second check in TypeScript
 * would drift and give false confidence. What the application DOES own is what
 * the caller is told, and that decision needs to know which operation was
 * asked for. So the adapter reports which chart the database refused, and the
 * service names the error.
 */
export type MergeOutcome =
  | {
      status: 'MERGED';
      event: PatientMergeEvent;
      /**
       * PA-062. Pairs of rests, neither revoked, one of them a maternity
       * rest, that the merge brought together overlapping.
       */
      restOverlaps: RestOverlap[];
    }
  | {
      /**
       * PA-045. The SOURCE chart is already merged, so there is nothing to
       * merge — there is a chart to open somewhere else.
       *
       * ═════════════════════════════════════════════════════════════════════
       * THIS IS THE OUTCOME OF THE DOUBLE CLICK, AND IT IS NOT A COURTESY
       * ═════════════════════════════════════════════════════════════════════
       *
       * `trg_patient_merge_not_chained` only raises when the target CHANGES,
       * so re-sending the SAME merge writes the same value and passes clean.
       * Two `MERGE` rows for one merge is a trail nothing can repair: undoing
       * closes the newer one and leaves the older one open FOR EVER, on a
       * chart that is whole, in an append-only table. The repository takes
       * `FOR UPDATE` on the source before the snapshot and reports this
       * instead — the same defence the trigger already uses on the target.
       *
       * A DIFFERENT CODE FROM `WOULD_CHAIN`, and the `SPEC.md` is explicit
       * about why: a merged SOURCE answers `PATIENT_MERGED` with the MRN of
       * its survivor, because what the desk has to do is open that chart.
       * `PATIENT_ALREADY_MERGED` is the target's — or the source's only when
       * it already absorbed others — and there what the desk has to do is
       * undo the other merge first.
       */
      status: 'SOURCE_MERGED';
      /** Where its history is now. Never null: the link is a FK. */
      survivingMrn: string;
    }
  | {
      status: 'WOULD_CHAIN';
      /** Which of the two charts is the one already involved in a merge. */
      chart: 'source' | 'target';
      /** Where that chart's history went, when the link says so. */
      survivingMrn: string | null;
    };

/**
 * What the database did with an undo (PA-047, PA-048).
 *
 * `IDENTIFIER_CLAIMED` is the whole reason this is an outcome. PostgreSQL
 * refuses through `patient_identifier_active_unique` — the SAME index a
 * duplicate registration hits — so the constraint map answers
 * `DUPLICATE_IDENTIFIER` about a document the caller never touched. Only the
 * caller knows the operation was an undo, so only the caller can say
 * `MERGE_UNDO_CONFLICT`.
 *
 * ⚠️ AND NOTHING IS LEFT HALF-UNDONE. The transaction rolls back whole: the
 * chart stays merged with every document still out of the index. A reversion
 * that failed midway would leave it neither merged nor entire.
 */
export type UndoMergeOutcome =
  | { status: 'UNDONE'; event: PatientMergeEvent }
  | {
      /**
       * PA-047. The merge this call meant to undo is no longer open.
       *
       * TWO SIMULTANEOUS UNDOS is where this comes from: both read the chart
       * as merged and both find the SAME open merge row. The arbiter is
       * `patient_merge_undone_once`, and the loser used to leave through the
       * generic unique-violation map as `DUPLICATE_VALUE` — a code that is
       * not in this module's table and that says nothing at the desk. What
       * the loser has to be told is what anyone undoing twice is told:
       * `MERGE_NOT_FOUND`, because what does not exist is the EVENT.
       */
      status: 'ALREADY_UNDONE';
    }
  | {
      status: 'IDENTIFIER_CLAIMED';
      /** The CLASS of document — `CEDULA`, `PASSPORT` — never its value. */
      identifierType: string;
      /** The live chart holding it now. An MRN and nothing else. */
      holderMrn: string;
    };

/**
 * One recorded assessment, as the application reads it back (PA-033, PA-038,
 * PA-039).
 *
 * The period is two CALENDAR DATES and not two instants: whether a pregnancy
 * still counts is a question about a day, and an instant would make the answer
 * depend on the hour it was asked.
 */
export interface PriorityGroupRecord {
  id: string;
  /**
   * PA-040, PA-055. LA FICHA EN LA QUE ESTA VALORACIÓN ESTÁ ESCRITA, que tras
   * una fusión NO es la que se pidió por la URL.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ESTÁ AQUÍ PARA QUE LA BITÁCORA PUEDA NOMBRAR LO QUE DE VERDAD SE LEYÓ
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * D-031 deja los grupos prioritarios en la ficha absorbida y PA-055 hace que
   * la superviviente los lea por el enlace. Sin este campo, el servicio sólo
   * conoce el id de la URL, así que la fila de `access_audit` nombra la
   * SUPERVIVIENTE mientras revela un dato de salud escrito en la ABSORBIDA — y
   * «¿quién leyó por qué era prioritaria la ficha A?» se queda sin ninguna fila
   * que nombre a `A` (REQ-110).
   *
   * ⚠️ NO SALE EN NINGUNA RESPUESTA. `toResponse` mapea campo a campo y éste no
   * está: PA-025 no publica datos de una ficha ajena, y lo único que este
   * módulo publica de una absorbida es su MRN (PA-054, PA-045).
   */
  chartId: string;
  group: PriorityGroup;
  startsOn: ClinicalDate;
  endsOn: ClinicalDate | null;
  origin: PriorityGroupOrigin;
  evidenceDocument: string | null;
  /** PA-039. Who recorded it and when. */
  recordedById: string;
  recordedAt: Date;
  closedById: string | null;
  closedAt: Date | null;
}

/** A priority group being recorded; `recordedById` is the session's user, set by the service. */
export interface NewPriorityGroup {
  patientId: string;
  group: PriorityGroup;
  startsOn: ClinicalDate;
  endsOn: ClinicalDate | null;
  origin: PriorityGroupOrigin;
  evidenceDocument: string | null;
  recordedById: string;
}

/** The two columns the ORDER depends on, and nothing that says why. */
export interface PatientPriorityInput {
  birthDate: ClinicalDate;
  recorded: readonly RecordedPriorityGroup[];
}

/** AG-073. What the chart needs to know of the appointment it is opened from. */
export interface AgendaEntryContext {
  /** `null` for a block, which has nobody. */
  patientId: string | null;
  siteId: string;
}

// The port described at the top of this file.
export interface PatientRepository {
  search(criteria: PatientSearchCriteria): Promise<PatientPage>;
  findById(id: string): Promise<PatientDetail | null>;
  /**
   * PA-009. Whether the chart exists AND was not absorbed by a merge.
   *
   * SEPARATE FROM `findMergeState` because the answer is all the mother link
   * needs and it must NOT carry the surviving MRN: a newborn pointed at a
   * chart that has been merged away disappears from
   * `GET /patients?motherId=<survivor>` — the only way there is of finding
   * them before they have a document — while the link still looks checked. A
   * merged chart is not deleted (PA-043), so «existe» says yes.
   */
  existsUnmerged(id: string): Promise<boolean>;
  /**
   * Every recorded assessment of one patient, in force or not.
   *
   * NOT FILTERED BY DATE HERE. Whether a period counts is a domain decision
   * (`isPeriodInForce`), and pushing it into SQL would put the rule in two
   * places — the one that has to be corrected the day «hasta el 15» stops
   * including the 15th. Closed rows come back too: they are the answer to
   * «¿por qué esta persona tuvo prioridad en marzo?» (PA-037).
   */
  listPriorityGroups(
    patientId: string,
  ): Promise<readonly PriorityGroupRecord[]>;
  addPriorityGroup(record: NewPriorityGroup): Promise<PriorityGroupRecord>;
  /**
   * Sets the end date of a record. NEVER deletes it (PA-037).
   *
   * Returns `null` when the record does not exist or belongs to another
   * patient, so the caller answers the same thing in both cases.
   */
  closePriorityGroup(input: {
    patientId: string;
    recordId: string;
    endsOn: ClinicalDate;
    closedById: string;
  }): Promise<PriorityGroupRecord | null>;
  /**
   * A stored catalogue concept, with the system it belongs to.
   *
   * ⚠️ NO VALIDITY FILTER HERE. Whether a concept may be CHOSEN today is a
   * decision of the application (PA-026 to PA-029); whether it can be SHOWN
   * has no date at all. Pushing the period into this query would give one
   * answer to two questions, and the losing one is a parish withdrawn from the
   * DPA blanking out the address of somebody who has not moved.
   */
  findConceptReference(id: string): Promise<CatalogReference | null>;
  /**
   * PA-057, PA-058. The chart's sexual orientation, on its own.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * A READ OF ITS OWN BECAUSE THE DOOR IS ITS OWN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * One column, and still not part of `findById`: it is special category data
   * under the LOPDP, and `PatientDetail` is served to everybody holding
   * `patient:read` — reception and billing included. The split is the same one
   * PA-040 and PA-042 make for the reason behind a priority: the chart carries
   * what everyone needs, and this carries what needs a key.
   *
   * `undefined` means the chart does not exist or is not visible; a chart with
   * no orientation recorded answers `{ orientation: null }`, because «nobody
   * asked yet» is a legitimate answer for whoever holds the permission.
   */
  findSexualOrientation(
    patientId: string,
  ): Promise<SexualOrientationRead | undefined>;
  /**
   * AG-073. The appointment a chart is being opened from: whose it is and at
   * which site. `null` when there is no such entry.
   *
   * READ HERE AND NOT ASKED OF `agenda`, because no module imports another
   * (`arch:check`); it is one indexed row by primary key, the same way the
   * agenda reads the patient's name for its day listing (AG-109). What it
   * returns is only what the check needs — never the reason, never the time.
   */
  findAgendaEntryContext(entryId: string): Promise<AgendaEntryContext | null>;
  /**
   * El mismo concepto, buscado POR CÓDIGO dentro de un sistema (PA-053).
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * POR QUÉ NO BASTA `findConceptReference`, Y POR QUÉ NO SE IMPORTA `catalogs`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * La ficha guarda el país como TRES LETRAS y no como el `uuid` de una fila,
   * por lo mismo que `patient_identifier.issuing_country`. Comprobar que `VEN`
   * existe es entonces una búsqueda por código, no por id. Es la misma consulta
   * que ya hacía este puerto con una clave distinta, así que se extiende el
   * camino que hay en vez de llamar a `catalogs`: ningún módulo importa de otro
   * (`arch:check` lo rechaza), y por eso los errores de referencia viven en
   * `shared`.
   *
   * ⚠️ SIN FILTRO DE VIGENCIA, igual que su hermana: si el código puede
   * ELEGIRSE hoy lo decide la aplicación, y si puede MOSTRARSE no depende de
   * ninguna fecha. Un código puede tener varias filas —un país renombrado tiene
   * una por release—, y lo que vuelve es la MÁS RECIENTE: es la que dice si el
   * país sigue vigente hoy, que es la pregunta de quien está registrando.
   */
  findConceptReferenceByCode(
    systemCode: string,
    code: string,
  ): Promise<CatalogReference | null>;
  /**
   * Every correctable field as it stands, already in its text form (PA-031).
   *
   * IN TEXT because that is how `patient_change_history` stores both sides,
   * and comparing what is stored with what was requested through the same
   * formatting rule is what makes "unchanged" mean the same thing on both.
   */
  findCorrectionState(id: string): Promise<PatientCorrectionState | null>;
  /**
   * Applies a correction and its trail AS ONE TRANSACTION (PA-031).
   *
   * ⚠️ THE UPDATE AND THE HISTORY ROWS ARE NOT TWO OPERATIONS. A chart changed
   * with no trail is exactly what REQ-113 cannot live with, and a trail of a
   * change that did not happen is worse. The two value columns are derived from
   * the same plan that produces the update, so they cannot disagree.
   *
   * ⚠️ WHAT ARRIVES IS THE REQUEST, NOT A PLAN, and that is the guarantee.
   * «Desde qué valor» can only be told by the snapshot the WRITE saw. Computed
   * from a read taken earlier and outside the transaction, two desks correcting
   * the same surname both record the value they read, and the history claims
   * twice that the previous value was the original one — a chain that cannot be
   * reconstructed, which is precisely what PA-031 sells.
   * `patient_change_history_value_changed` does not notice: the two values
   * differ. The adapter therefore locks the row, reads the snapshot INSIDE the
   * transaction and plans there.
   *
   * Returns `null` when the chart vanished between reading and writing, and
   * throws `PatientMergedError` when the merge landed in the same window.
   */
  correct(input: {
    patientId: string;
    changedById: string;
    requested: PatientCorrectionRequest;
  }): Promise<AppliedCorrection | null>;
  /**
   * PA-015. Adds a document to an existing chart and stops it being
   * provisional, IN THE SAME TRANSACTION.
   *
   * It never creates a chart. Registering the newborn again the day the cedula
   * arrives is precisely the duplicate REQ-010 then has to merge.
   */
  addIdentifier(input: {
    patientId: string;
    identifier: PatientIdentifier;
  }): Promise<PatientDetail | null>;
  /** Used to refuse a duplicate before the database has to. */
  findByIdentifier(
    identifier: PatientIdentifier,
  ): Promise<PatientSummary | null>;
  /**
   * The MRN is NOT a parameter: the caller cannot know it and must not choose
   * it. It is issued from a sequence inside the same transaction as the row.
   */
  create(patient: NewPatient): Promise<PatientDetail>;
  /**
   * PA-045. Whether the chart was absorbed, and by whom, without opening it.
   *
   * `null` when it does not exist. Every route of this module asks it before
   * acting: a merged chart is refused with `PATIENT_MERGED` naming the
   * surviving MRN, which is not a 404 — the history existed.
   */
  findMergeState(id: string): Promise<PatientMergeState | null>;
  /**
   * PA-043, PA-044. Merges the source chart into the target AS ONE
   * TRANSACTION: the link, the instant and the append-only row with author,
   * reason and snapshot.
   *
   * ⚠️ THE TWO ARE NOT TWO OPERATIONS. A chart pointed at another with no row
   * explaining why is the merge REQ-010 cannot audit; a row describing a merge
   * that did not happen is worse. And the absorbed chart is never deleted
   * (PA-043).
   */
  merge(input: {
    sourcePatientId: string;
    targetPatientId: string;
    reason: string;
    performedById: string;
  }): Promise<MergeOutcome>;
  /**
   * PA-047. The merge of this chart that is still standing, if there is one.
   *
   * BY THE LINK AND NOT BY DATES. `patient_merge_undone_once` makes «is this
   * merge undone?» an exact lookup; guessing from timestamps stops working the
   * day the same pair is merged, undone and merged again — and stops working
   * for ever, on the question of whether two clinical records are joined.
   */
  findOpenMerge(sourcePatientId: string): Promise<{ mergeId: string } | null>;
  /**
   * PA-047, PA-048. Undoes a merge: the chart becomes whole again and a NEW
   * row records who undid it, when and why.
   *
   * NEVER AN EDIT of the merge row. `patient_merge` is append-only for real
   * since 17-08-2026, and a table that is append-only «except this column» is a
   * convention somebody has to remember rather than a guarantee.
   */
  undoMerge(input: {
    sourcePatientId: string;
    mergeId: string;
    reason: string;
    performedById: string;
  }): Promise<UndoMergeOutcome>;
}

/** Injection token. The application never names the adapter. */
export const PATIENT_REPOSITORY = Symbol('PatientRepository');
