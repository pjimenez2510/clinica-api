import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  AppointmentNotAttendableError,
  EncounterAppointmentMismatchError,
  EncounterNotFoundError,
  InvalidEncounterTransitionError,
} from '../domain/encounter.errors';
import { subjectStatusAfter } from '../domain/patient-flow';
import type { ClosurePlan } from '../domain/encounter-closure';
import type {
  ChartHistoryQuery,
  EncounterPage,
  EncounterQuery,
  EncounterRepository,
  EncounterView,
  NewEncounter,
  OpenEncountersQuery,
  PatientChartStatus,
  PractitionerIdentity,
  SiteScopeFilter,
  SubjectStatusStamp,
  VitalSignsView,
} from '../domain/encounter.repository';
import type { VitalSigns } from '../domain/vital-signs';

/**
 * Rows in, domain shapes out.
 *
 * Everything Prisma-shaped stops here: the service above never sees a
 * `Prisma.` type, and it never sees a PostgreSQL error either — the ones that
 * mean something to a user are translated by `database-problem.ts` through
 * `encounter.constraints.ts` on the way out.
 */

/**
 * What an attention carries in a response.
 *
 * ⚠️ NO PATIENT NAME, NO REASON, NO DIAGNOSIS, and the absences are the
 * design (EN-124, SC-016). This shape is served by a listing that anybody
 * holding `record:read` over the site can open and that leaves no row in
 * `access_audit` (EN-123). A value that is never loaded cannot leak into a
 * response, a log or a support screenshot — the same line `agenda`'s
 * `ENTRY_SELECT` draws around `reason`.
 */
export const ENCOUNTER_SELECT = {
  id: true,
  siteId: true,
  practitionerId: true,
  patientId: true,
  agendaEntryId: true,
  startedAt: true,
  endedAt: true,
  status: true,
  careModality: true,
  careSetting: true,
  visitSequence: true,
  // EN-008. Written by `trg_encounter_freeze_age` and never recomputed.
  ageYears: true,
  ageMonths: true,
  ageDays: true,
  dischargeCondition: true,
  closedById: true,
  closedAt: true,
  closedBySubstituteReason: true,
  enteredInErrorReason: true,
  enteredInErrorAt: true,
  discontinuedReason: true,
  discontinuedOrigin: true,
  discontinuedAt: true,
} satisfies Prisma.EncounterSelect;

/** The row `ENCOUNTER_SELECT` yields, derived from it so the two cannot drift. */
type EncounterRow = Prisma.EncounterGetPayload<{
  select: typeof ENCOUNTER_SELECT;
}>;

const VITALS_SELECT = {
  encounterId: true,
  weightKg: true,
  heightCm: true,
  headCircumferenceCm: true,
  abdominalCircumferenceCm: true,
  bmi: true,
  systolicBp: true,
  diastolicBp: true,
  heartRate: true,
  respiratoryRate: true,
  temperatureC: true,
  oxygenSaturation: true,
  measuredAt: true,
  heightPosition: true,
  hemoglobinGDl: true,
  hemoglobinCorrectedGDl: true,
  presentingComplaint: true,
  recordedBy: { select: { id: true, firstName: true, lastName: true } },
  correctedBy: { select: { id: true, firstName: true, lastName: true } },
  correctedAt: true,
} satisfies Prisma.EncounterVitalsSelect;

/** The row `VITALS_SELECT` yields; its decimals are still Prisma's `Decimal`. */
type VitalsRow = Prisma.EncounterVitalsGetPayload<{
  select: typeof VITALS_SELECT;
}>;

/**
 * EN-005. The agenda states an attention may still be filed against.
 *
 * ENUMERATED AS WHAT IS REFUSED AND NOT AS WHAT IS ADMITTED, deliberately: the
 * agenda's status union grows — `LEFT_WITHOUT_BEING_SEEN` and
 * `ENTERED_IN_ERROR` arrived in D-A-009 — and a list of ADMITTED states would
 * silently start refusing every new one. What must never hold an attention is
 * a commitment somebody declared did not happen, and those are these four.
 *
 * ⚠️ STRINGS AND NOT THE AGENDA'S TYPE. No module imports another: this
 * adapter reads a column of `agenda_entry` and names the values it refuses,
 * exactly as `agenda` names `encounter IS NULL` from its own side. The two
 * halves of AG-045 meet in the database, never in the import graph.
 */
const NOT_ATTENDABLE: readonly string[] = [
  'CANCELLED',
  'NO_SHOW',
  'LEFT_WITHOUT_BEING_SEEN',
  'ENTERED_IN_ERROR',
];

/**
 * The attention's port over PostgreSQL. What it reads of patients, agenda and
 * practitioners it reads from their tables directly, because no module
 * imports another.
 */
@Injectable()
export class PrismaEncounterRepository implements EncounterRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * EN-001, PA-045. The chart's merge state.
   *
   * TWO COLUMNS AND NO MORE: the service only has to know whether the chart
   * opens, and a select that reached for the name would put a patient's
   * identity into a code path that has no reason to hold it.
   */
  async findPatientChart(
    patientId: string,
  ): Promise<PatientChartStatus | null> {
    return this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, mergedIntoId: true },
    });
  }

  /**
   * EN-011, EN-029. The caller's clinical identity.
   *
   * ⚠️ THE ACESS REGISTRATION LIVES ON `app_user`, NOT ON `practitioner` —
   * the schema comment says so: «Cedula and ACESS registration already live on
   * `app_user`, not duplicated». So this reads through the relation rather
   * than looking for a column that does not exist.
   *
   * AN INACTIVE PRACTITIONER ANSWERS `null`, exactly like an account with no
   * profile: a doctor who left the clinic must not be able to sign, and the
   * two answer the same refusal so the endpoint does not become a directory of
   * who is still on the staff.
   */
  async findPractitionerByUser(
    userId: string,
  ): Promise<PractitionerIdentity | null> {
    const row = await this.prisma.practitioner.findFirst({
      where: { userId, active: true },
      select: { id: true, user: { select: { acessExpiresOn: true } } },
    });

    return row === null
      ? null
      : {
          practitionerId: row.id,
          acessExpiresOn: row.user.acessExpiresOn,
        };
  }

  /**
   * EN-003 to EN-008, EN-127. Writes the attention.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * EN-005, AND IT IS THE HALF OF AG-045 THAT WAS MISSING SINCE 12-08-2026
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The adversarial review of the agenda's E2 left the gap written down:
   * annulling re-arbitrates with `encounter IS NULL` inside its own `UPDATE`,
   * so that race is closed to the intra-statement interval — and NOTHING in
   * the database tied the CREATION of an attention to the state of the cita.
   * An attention confirmed just after that `UPDATE` left an annulled
   * appointment holding a registered attention: two facts, both true, that
   * contradict each other.
   *
   * `SELECT … FOR UPDATE` on `agenda_entry` inside the same transaction is
   * what closes it. Whichever of the two transactions takes the row lock
   * first wins outright: the annulment finds an attention and refuses with
   * `AGENDA_ENTRY_HAS_ENCOUNTER`, or this one finds `CANCELLED` and refuses
   * with `APPOINTMENT_NOT_ATTENDABLE`. Exactly one, never both, never neither
   * — which is what the concurrency test asserts, because «at least one fails»
   * is not the assertion and two winners is the defect being hunted.
   *
   * ⚠️ THE PATIENT OF THE CITA IS *NOT* COMPARED HERE. It is
   * `trg_encounter_matches_appointment`, a `BEFORE INSERT OR UPDATE` that
   * Prisma cannot express as a composite foreign key, and it is the strongest
   * guarantee this method has: attending the wrong patient in somebody else's
   * slot writes the act into the wrong history, which is the worst error this
   * system can make. A read-and-compare here would be a second, weaker copy
   * that a concurrent correction could slip past.
   *
   * NO RETRY. A `40001` here means somebody else took the same appointment
   * row, and re-running would find it locked or annulled — the honest answer
   * is the refusal, which whoever is at admissions can act on immediately.
   */
  async open(encounter: NewEncounter): Promise<EncounterView> {
    const row = await this.prisma.$transaction(async (tx) => {
      if (encounter.agendaEntryId !== undefined) {
        /**
         * The lock and the read are ONE statement: `FOR UPDATE` has to be
         * taken in the same statement that reads the status, or a second
         * transaction reads the same status between the two.
         *
         * A row that does not exist yields no rows and is left to the foreign
         * key, which refuses the insert a moment later — answering «no
         * existe» from here would make this endpoint an oracle for guessed
         * appointment identifiers.
         */
        const locked = await tx.$queryRaw<
          { status: string; patient_id: string | null }[]
        >`
          SELECT "status"::text AS status, "patient_id"::text AS patient_id
            FROM "agenda_entry"
           WHERE "id" = ${encounter.agendaEntryId}::uuid
             FOR UPDATE
        `;

        const row = locked[0];
        if (row !== undefined) {
          if (NOT_ATTENDABLE.includes(row.status)) {
            throw new AppointmentNotAttendableError();
          }

          /**
           * EN-004. The same comparison `trg_encounter_matches_appointment`
           * makes, done here so the refusal is a sentence about the cita
           * rather than the trigger's bare `INTEGRITY_RULE_FAILED`.
           *
           * ⚠️ THE TRIGGER IS STILL THE GUARANTEE and this is not a
           * substitute for it: Prisma cannot express a composite foreign key
           * across two tables, and the trigger is what also stops an import,
           * a `psql` and a use case somebody writes without reading this
           * file. What this adds is the message — and it costs nothing,
           * because the row is already read and locked.
           *
           * A BLOCK OF AGENDA LANDS HERE TOO and needs no separate answer: a
           * block has no patient at all (`agenda_entry_patient_coherence`),
           * so «¿es la misma ficha?» answers no.
           */
          if (row.patient_id !== encounter.patientId) {
            throw new EncounterAppointmentMismatchError();
          }
        }
      }

      return tx.encounter.create({
        data: {
          siteId: encounter.siteId,
          practitionerId: encounter.practitionerId,
          patientId: encounter.patientId,
          agendaEntryId: encounter.agendaEntryId,
          startedAt: encounter.startedAt,
          careModality: encounter.careModality,
          careSetting: encounter.careSetting,
          visitSequence: encounter.visitSequence,
          // EN-127. The only state an attention is born in. Stated rather than
          // left to the column default so the row this module writes is
          // readable without opening the schema.
          status: 'OPEN',
        },
        select: ENCOUNTER_SELECT,
      });
    });

    return toEncounterView(row);
  }

  /** EN-121, EN-122. One attention within the caller's scope, or `null`. */
  async findById(query: EncounterQuery): Promise<EncounterView | null> {
    const row = await this.prisma.encounter.findFirst({
      where: { id: query.encounterId, ...siteFilter(query.sites) },
      select: ENCOUNTER_SELECT,
    });
    return row === null ? null : toEncounterView(row);
  }

  /**
   * EN-015. One chart's attentions AND those of the charts it absorbed.
   *
   * ⚠️ `chartScope` AND NOT `patientId`, and this is the read PA-055 was
   * written for. A merge re-points nothing (D-031), so the attentions of the
   * absorbed chart keep their own `patient_id` and are reachable only through
   * the link — a read by the bare id makes half a history disappear the day
   * admissions repairs a duplicate. `patient-chart-scope.spec.ts` walks this
   * file and fails the build over exactly that.
   *
   * NEWEST FIRST. Art. 5 demands chronological order and does not say which
   * end: what a clinician opens is the last attention, and a history of twenty
   * that started at the oldest would need scrolling to reach today's.
   *
   * ⚠️ THE TIE IS BROKEN BY `id` AND THAT IS WHAT MAKES THE PAGES DISJOINT
   * (EN-162). Two attentions of the same instant — the mother seen twice on
   * one morning, an import that landed with the same `started_at` — have no
   * order of their own, so a `LIMIT/OFFSET` over them may serve one of the two
   * on page 1 and the same one again on page 2 while the other is never shown.
   * A total order is the whole of the fix, and it is the same reason the
   * register orders by a second column.
   *
   * ⚠️ THE PREDICATE IS WRITTEN TWICE, ON PURPOSE. Hoisting it into a `const`
   * would hide both reads from `patient-chart-scope.spec.ts`, which looks at
   * the `where` OF A PRISMA CALL: the analyser would stop watching the very
   * two statements that must never lose the chart scope, and the day somebody
   * replaces one with `{ patientId }` nothing would fail. A count that drifted
   * from its page is visible in three lines; a scope that drifts is half a
   * history that «no falla ni avisa».
   */
  async historyOf(query: ChartHistoryQuery): Promise<EncounterPage> {
    // EN-208. By appointment: an annulled-in-error attention is not the
    // attention of that appointment (EN-166), and it is never shown as such.
    const ofAppointment =
      query.agendaEntryId === undefined
        ? {}
        : {
            agendaEntryId: query.agendaEntryId,
            status: { not: 'ENTERED_IN_ERROR' as const },
          };
    const [rows, total] = await Promise.all([
      this.prisma.encounter.findMany({
        where: {
          ...chartScope(query.patientId),
          ...siteFilter(query.sites),
          ...ofAppointment,
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: ENCOUNTER_SELECT,
      }),
      this.prisma.encounter.count({
        where: {
          ...chartScope(query.patientId),
          ...siteFilter(query.sites),
          ...ofAppointment,
        },
      }),
    ]);

    return { items: rows.map(toEncounterView), total };
  }

  /**
   * EN-146. What nobody has closed, oldest first.
   *
   * THE `WHERE` IS THE PREDICATE OF `encounter_still_open_by_practitioner`
   * — `status IN ('OPEN','ON_HOLD')` — and the ordering is its second column,
   * so the planner answers this from the partial index. Partial is what keeps
   * it small BY CONSTRUCTION: rows leave it when they close.
   *
   * OLDEST FIRST because the list exists to show what is being forgotten, and
   * what is being forgotten is the oldest thing on it.
   */
  async listStillOpen(query: OpenEncountersQuery): Promise<EncounterView[]> {
    const rows = await this.prisma.encounter.findMany({
      where: {
        status: { in: ['OPEN', 'ON_HOLD'] },
        ...(query.practitionerId === undefined
          ? {}
          : { practitionerId: query.practitionerId }),
        ...siteFilter(query.sites),
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: ENCOUNTER_SELECT,
    });
    return rows.map(toEncounterView);
  }

  /**
   * EN-009, EN-131, EN-132, EN-139, EN-144, EN-147. One closure, one
   * transaction.
   *
   * READ, DECIDE, WRITE CONDITIONALLY — the shape `agenda.transition` uses,
   * for the same reason: the policy must judge the row AS IT IS inside the
   * transaction, not a read from a moment earlier. `decide` throws to refuse
   * and the transaction aborts with nothing written.
   *
   * THE UPDATE DOES NOT TRUST THE READ. Two people close the same attention at
   * the same moment; both closures approve. The `updateMany` is conditioned on
   * the status that was read, so the loser matches zero rows, re-reads and is
   * refused with the status the WINNER left — the honest 409 rather than a
   * stale acceptance that would overwrite `closed_by_id` with the second
   * person.
   *
   * EN-139 RIDES IN THE SAME TRANSACTION: closing the account is the
   * documented fact that proves the patient left, and a board written after
   * the commit is a board that can disagree with the record.
   */
  async close(
    query: EncounterQuery,
    decide: (encounter: EncounterView) => ClosurePlan,
  ): Promise<EncounterView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.encounter.findFirst({
        where: { id: query.encounterId, ...siteFilter(query.sites) },
        select: ENCOUNTER_SELECT,
      });
      if (!row) throw new EncounterNotFoundError();

      const current = toEncounterView(row);
      const plan = decide(current);

      const updated = await tx.encounter.updateMany({
        where: {
          id: query.encounterId,
          ...siteFilter(query.sites),
          status: current.status,
        },
        data: {
          status: plan.to,
          endedAt: plan.endedAt,
          dischargeCondition: plan.dischargeCondition,
          closedById: plan.closedById,
          closedAt: plan.closedAt,
          closedBySubstituteReason: plan.substituteReason,
        },
      });

      if (updated.count === 0) {
        // Somebody moved it between our read and our write. The refusal names
        // the state THEY left, never the stale one we decided on.
        const now = await tx.encounter.findUniqueOrThrow({
          where: { id: query.encounterId },
          select: { status: true },
        });
        throw new InvalidEncounterTransitionError(now.status, plan.to);
      }

      await stampSubjectStatus(tx, {
        encounterId: query.encounterId,
        fact: 'ACCOUNT_CLOSED',
        now: plan.closedAt,
      });

      const after = await tx.encounter.findUniqueOrThrow({
        where: { id: query.encounterId },
        select: ENCOUNTER_SELECT,
      });
      return toEncounterView(after);
    });
  }

  /**
   * EN-060 to EN-062, EN-067. Writes the ONE set of vital signs.
   *
   * AN UPSERT: `encounter_vitals.encounter_id` is the primary key, so asking
   * twice must not create a second row — which is exactly why the route is a
   * `PUT`. The consequence is worth restating: a second taking OVERWRITES the
   * first and there is no history of the two (EN-067).
   *
   * ⚠️ `bmi` IS NOT IN EITHER BRANCH, and that is EN-061 made structural
   * rather than checked: `trg_encounter_vitals_bmi` writes it on every insert
   * and update of the weight or the height, and a value sent from here would
   * be overwritten in the same statement. The row is read back afterwards so
   * what the caller receives is the number the DATABASE computed.
   *
   * ⚠️ AND THE RANGES ARE NOT CHECKED. `encounter_vitals_ranges_*` refuses 750 kg
   * — and refuses it to an import and to a `psql` too. A copy of the numbers
   * here would be a second, weaker rule that drifts from the one that matters.
   */
  async saveVitals(
    query: EncounterQuery,
    vitals: VitalSigns,
    authorId: string,
  ): Promise<VitalSignsView> {
    const measurements = {
      weightKg: vitals.weightKg,
      heightCm: vitals.heightCm,
      heightPosition: vitals.heightPosition,
      headCircumferenceCm: vitals.headCircumferenceCm,
      abdominalCircumferenceCm: vitals.abdominalCircumferenceCm,
      systolicBp: vitals.systolicBp,
      diastolicBp: vitals.diastolicBp,
      heartRate: vitals.heartRate,
      respiratoryRate: vitals.respiratoryRate,
      temperatureC: vitals.temperatureC,
      oxygenSaturation: vitals.oxygenSaturation,
      hemoglobinGDl: vitals.hemoglobinGDl,
      hemoglobinCorrectedGDl: vitals.hemoglobinCorrectedGDl,
      presentingComplaint: vitals.presentingComplaint,
    };
    const now = new Date();

    const row = await this.prisma.encounterVitals.upsert({
      where: { encounterId: query.encounterId },
      create: {
        encounterId: query.encounterId,
        ...measurements,
        // EN-143. Whoever writes the first taking is who took it.
        recordedById: authorId,
        // EN-060. The instant of the MEASUREMENT, which is not the instant of
        // the typing: nursing weighs at 08:10 and the network returns at 08:40.
        measuredAt: vitals.measuredAt ?? now,
      },
      /**
       * EVERY COLUMN IS WRITTEN ON THE UPDATE, including the ones that arrived
       * `undefined`. A `PUT` replaces the resource: a partial update would let
       * a second taking that omitted the abdominal circumference keep the
       * first taking's figure beside the second taking's weight, and the row
       * would then describe a measurement nobody performed.
       */
      update: {
        ...Object.fromEntries(
          Object.entries(measurements).map(([field, value]) => [
            field,
            value ?? null,
          ]),
        ),
        /**
         * ⚠️ A CORRECTION IS NOT A TAKING (EN-143, D-048). The author and the
         * instant of the taking stay; who corrected it goes beside them.
         * Rewriting `recorded_by` made the doctor who fixed a temperature the
         * author of the weight nursing took (clinical review, 30-09-2026), and
         * the database now refuses it (`trg_encounter_vitals_keeps_its_author`).
         * Per-measure authorship is D-062.
         */
        correctedById: authorId,
        correctedAt: now,
        ...(vitals.measuredAt === undefined
          ? {}
          : { measuredAt: vitals.measuredAt }),
      },
      select: VITALS_SELECT,
    });

    return toVitalsView(row);
  }

  /**
   * EN-068. Block D of one attention.
   *
   * NARROWED BY THE ATTENTION'S OWN SCOPE and not by the vitals table, which
   * has no site of its own: reading through the relation is what keeps an
   * attention of another site from answering its measurements to a caller who
   * cannot open the attention itself.
   */
  async findVitals(query: EncounterQuery): Promise<VitalSignsView | null> {
    const row = await this.prisma.encounterVitals.findFirst({
      where: {
        encounterId: query.encounterId,
        encounter: { ...siteFilter(query.sites) },
      },
      select: VITALS_SELECT,
    });
    return row === null ? null : toVitalsView(row);
  }

  /** EN-135 to EN-139. Moves the board because something was documented. */
  async stampSubjectStatus(stamp: SubjectStatusStamp): Promise<void> {
    await this.prisma.$transaction((tx) => stampSubjectStatus(tx, stamp));
  }
}

/**
 * EN-134 to EN-139. Writes the patient's progress onto the agenda entry the
 * attention came from.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT WRITES A COLUMN OF ANOTHER MODULE'S TABLE, AND THAT IS THE DESIGN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EN-134 puts `subject_status` on `agenda_entry` because the patient is in the
 * waiting room BEFORE any attention exists and the walk-in has an agenda row
 * too (AG-029). The facts that MOVE it are all documented here — the vitals
 * opened, the vitals saved, the note opened, the note signed, the account
 * closed. So `agenda` owns the row and this module owns half the verbs, and
 * what crosses the boundary is a port: nothing in this file imports
 * `modules/agenda`, which is the boundary `pnpm arch:check` enforces.
 *
 * IT NEVER MOVES THE PATIENT BACKWARDS (`subjectStatusAfter`): the facts do
 * not arrive in the order the flow imagines — a second evolution note after
 * the consultation was signed, a weight re-saved half an hour later — and
 * assigning the state each fact «produces» would make the patient reappear as
 * `READY` while they are with the doctor.
 *
 * A WALK-IN WITH NO AGENDA ROW IS A NO-OP AND NOT A FAILURE. `agenda_entry_id`
 * is nullable (EN-003) and the board is a convenience: refusing to record the
 * vital signs because there is nowhere to paint them would trade a clinical
 * datum for a tile on a screen.
 */
async function stampSubjectStatus(
  tx: Prisma.TransactionClient,
  stamp: SubjectStatusStamp,
): Promise<void> {
  const encounter = await tx.encounter.findUnique({
    where: { id: stamp.encounterId },
    select: {
      agendaEntry: { select: { id: true, subjectStatus: true } },
    },
  });

  const entry = encounter?.agendaEntry;
  if (!entry) return;

  const next = subjectStatusAfter(stamp.fact, entry.subjectStatus);
  if (next === null) return;

  await tx.agendaEntry.update({
    where: { id: entry.id },
    /**
     * EN-140. The instant travels with the state, and
     * `agenda_entry_subject_status_carries_its_instant` refuses one without
     * the other. What the server publishes is the instant; how long the
     * patient has been in it is presentation, and belongs to `clinica-web`.
     */
    data: { subjectStatus: next, subjectStatusAt: stamp.now },
  });
}

/**
 * EN-121. The caller's resolved scope as a `where` fragment.
 *
 * `'all'` YIELDS NO FILTER AND AN EMPTY LIST NEVER REACHES HERE: `siteScope`
 * in `shared/authorisation` throws `SITE_SCOPE_DENIED` when the caller holds
 * the permission at no site, precisely so that «no filter to apply» can never
 * be spelled as «every site».
 */
export function siteFilter(sites: SiteScopeFilter): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}

/** An `encounter` row as the domain reads it. */
export function toEncounterView(row: EncounterRow): EncounterView {
  return {
    id: row.id,
    siteId: row.siteId,
    practitionerId: row.practitionerId,
    patientId: row.patientId,
    agendaEntryId: row.agendaEntryId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    status: row.status,
    careModality: row.careModality,
    careSetting: row.careSetting,
    visitSequence: row.visitSequence,
    ageYears: row.ageYears,
    ageMonths: row.ageMonths,
    ageDays: row.ageDays,
    dischargeCondition: row.dischargeCondition,
    closedById: row.closedById,
    closedAt: row.closedAt,
    closedBySubstituteReason: row.closedBySubstituteReason,
    // The CHECKs of `encounter_annulment_and_interruption` make each group
    // all-or-nothing, so one column standing for the group is enough.
    annulment:
      row.enteredInErrorReason !== null && row.enteredInErrorAt !== null
        ? { reason: row.enteredInErrorReason, at: row.enteredInErrorAt }
        : null,
    interruption:
      row.discontinuedReason !== null &&
      row.discontinuedOrigin !== null &&
      row.discontinuedAt !== null
        ? {
            reason: row.discontinuedReason,
            origin: row.discontinuedOrigin,
            at: row.discontinuedAt,
          }
        : null,
  };
}

/**
 * An `encounter_vitals` row as the domain reads it.
 *
 * ⚠️ THE DECIMALS BECOME NUMBERS HERE AND NOWHERE ELSE. `Decimal` is Prisma's
 * type and it must not cross into the domain, which imports no ORM. Weight,
 * height and temperature are measurements with one to three decimal places —
 * `Decimal(6,3)`, `Decimal(5,1)`, `Decimal(4,1)` — so a double represents
 * every value the columns admit exactly enough for a clinical reading. MONEY
 * WOULD NOT BE CONVERTED THIS WAY and no money passes through this module.
 */
function toVitalsView(row: VitalsRow): VitalSignsView {
  const decimal = (value: Prisma.Decimal | null): number | undefined =>
    value === null ? undefined : value.toNumber();

  return {
    encounterId: row.encounterId,
    weightKg: decimal(row.weightKg),
    heightCm: decimal(row.heightCm),
    headCircumferenceCm: decimal(row.headCircumferenceCm),
    abdominalCircumferenceCm: decimal(row.abdominalCircumferenceCm),
    // EN-061. Computed by `trg_encounter_vitals_bmi`; `null` while either the
    // weight or the height is missing, which is the row saying so rather than
    // this function deciding it.
    bmi: row.bmi === null ? null : row.bmi.toNumber(),
    systolicBp: row.systolicBp ?? undefined,
    diastolicBp: row.diastolicBp ?? undefined,
    heartRate: row.heartRate ?? undefined,
    respiratoryRate: row.respiratoryRate ?? undefined,
    temperatureC: decimal(row.temperatureC),
    oxygenSaturation: row.oxygenSaturation ?? undefined,
    heightPosition: row.heightPosition ?? undefined,
    hemoglobinGDl: decimal(row.hemoglobinGDl),
    hemoglobinCorrectedGDl: decimal(row.hemoglobinCorrectedGDl),
    presentingComplaint: row.presentingComplaint ?? undefined,
    measuredAt: row.measuredAt,
    recordedBy: personOf(row.recordedBy),
    correctedBy: personOf(row.correctedBy),
    correctedAt: row.correctedAt,
  };
}

/** EN-143. An account as the screen names it, or `null` when there is none. */
function personOf(
  user: { id: string; firstName: string; lastName: string } | null,
): { id: string; name: string } | null {
  return user === null
    ? null
    : { id: user.id, name: `${user.firstName} ${user.lastName}` };
}
