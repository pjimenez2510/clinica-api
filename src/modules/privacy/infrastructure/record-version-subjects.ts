import { Prisma } from '@prisma/client';

import type { RecordReadScope } from '../../../shared/domain/clinical-record-key';
import { chartScopeIds } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import type { ExportedVersion } from '../domain/privacy.repository';

import { staffNames, nameOf, type Db } from './privacy-reads';

/**
 * PD-048 (D-131.1, option A). How each versioned table reaches its patient.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A REGISTRY, AND WHY IT LIVES HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `record_version` keeps the previous row of every edit (EN-210) by TABLE and
 * ID, with no `patient_id`: the archive trigger is generic and does not know
 * whose a row is. A data subject's access request that walked only the
 * patient-keyed tables would never find those copies of their health data.
 * So every table with a `record_version_archive` trigger declares, here, the
 * SQL that turns a set of charts into the `resource_id`s of its rows — and
 * `test/integration/privacy-record-versions.spec.ts` compares this map with
 * the triggers the database really has, so a table versioned tomorrow without
 * being declared here fails that test instead of silently staying out.
 *
 * It reads tables this module does not own, by SQL and without importing
 * their modules (ADR-011), like the rest of `privacy-reads.ts`.
 *
 * `omittedBecause` keeps a table OUT of the export with the decision that
 * explains it, the same one `EXPORT_OMISSIONS` cites for the current rows:
 * declared all the same, so the map stays exhaustive and the test meaningful.
 */
export interface VersionedTablePath {
  /**
   * The `record_version.resource_id`s of the rows of this chart AND the ones
   * merged into it (PA-055): `chartScopeIds`, the shared scope.
   */
  resourceIdsOf(chartId: string, sites: RecordReadScope): Prisma.Sql;
  /**
   * PD-067 (D-203 §10). Clinical: its versions leave only from the sites of
   * the caller's `record:read` (`encounter`, by the attention's site) or only
   * with the key of the record (`person`, rows with no site of their own).
   */
  clinical?: 'encounter' | 'person';
  /** `null`: exported. Otherwise, why its versions do not leave. */
  omittedBecause: string | null;
  /**
   * D-140.2. Columns taken out of every version before it leaves: data about
   * SOMEBODY ELSE that the row happens to hold.
   */
  redactedColumns?: readonly string[];
  /**
   * The same for a value INSIDE a `jsonb` column: each key of `column` is a
   * list whose items lose `keys` (EN-093: the risk group of each dose).
   */
  redactedInLists?: Readonly<Record<string, readonly string[]>>;
  /**
   * A versioned table that is nobody's personal data (a price): declared to
   * keep the map exhaustive, it reaches no chart by construction.
   */
  reachesNoPatient?: true;
  /** A redaction that depends on the row itself (PD-066). */
  redactRow?: (data: Record<string, unknown>) => Record<string, unknown>;
}

function omitKeys(
  data: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !keys.includes(key)),
  );
}

const byPatientId =
  (table: string): VersionedTablePath['resourceIdsOf'] =>
  (chartId) =>
    Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE patient_id IN ${chartScopeIds(chartId)}`;

/**
 * D-140.2. The attentions of the chart that STAND: one annulled as entered in
 * error —«paciente equivocado»— holds another person's data, and neither its
 * versions nor those of what hangs from it leave with this person's export.
 */
const standingEncountersOf = (chartId: string, sites: RecordReadScope) =>
  Prisma.sql`
  SELECT id FROM encounter
   WHERE patient_id IN ${chartScopeIds(chartId)}
     AND status <> 'ENTERED_IN_ERROR'
     AND ${sites === 'all' ? Prisma.sql`true` : Prisma.sql`site_id = ANY(${[...sites]}::uuid[])`}`;

export const VERSIONED_TABLES: Readonly<Record<string, VersionedTablePath>> = {
  // The attention itself (modality and first/subsequent, EN-212).
  encounter: {
    resourceIdsOf: standingEncountersOf,
    omittedBecause: null,
    clinical: 'encounter',
  },
  // One row per attention, archived by `encounter_id` (EN-210).
  encounter_vitals: {
    resourceIdsOf: standingEncountersOf,
    omittedBecause: null,
    clinical: 'encounter',
  },
  // EN-052. One row per attention, archived by `encounter_id` (EN-210).
  encounter_dental_index: {
    resourceIdsOf: standingEncountersOf,
    omittedBecause: null,
    clinical: 'encounter',
  },
  // EN-249. Blocks G, H and I of the RDACAA: one row per attention each,
  // archived by `encounter_id`. Block J (HIV) is NOT versioned here: it has
  // its own table of versions, out of the export (EN-095).
  encounter_obstetric: {
    resourceIdsOf: standingEncountersOf,
    omittedBecause: null,
    clinical: 'encounter',
  },
  encounter_nutrition: {
    resourceIdsOf: standingEncountersOf,
    omittedBecause: null,
    clinical: 'encounter',
  },
  // REQ-115. The risk group can say «lives with HIV» or «sex worker» (the
  // adult hepatitis B, EN-093): out of every version that leaves, whatever
  // the vaccine, so its absence tells nothing. Since D-195.8 it is each
  // dose's (`doses[].riskGroup`); the versions archived before still carry
  // the attention's `risk_group`, so both go.
  encounter_vaccination: {
    resourceIdsOf: standingEncountersOf,
    omittedBecause: null,
    clinical: 'encounter',
    redactedColumns: ['risk_group'],
    redactedInLists: { doses: ['riskGroup'] },
  },
  // EN-096. Whether supplements were prescribed: nothing about anybody else.
  encounter_supplement: {
    resourceIdsOf: standingEncountersOf,
    omittedBecause: null,
    clinical: 'encounter',
  },
  encounter_diagnosis: {
    resourceIdsOf: (chartId, sites) => Prisma.sql`
      SELECT d.id FROM encounter_diagnosis d
       WHERE d.encounter_id IN (${standingEncountersOf(chartId, sites)})`,
    omittedBecause: null,
    clinical: 'encounter',
  },
  // EN-244. A corrected procedure: the tariff code, how many times, the note.
  encounter_procedure: {
    resourceIdsOf: (chartId, sites) => Prisma.sql`
      SELECT p.id FROM encounter_procedure p
       WHERE p.encounter_id IN (${standingEncountersOf(chartId, sites)})`,
    omittedBecause: null,
    clinical: 'encounter',
  },
  // Notice → result → report → order → attention. Who was told, and the note
  // about them (often a relative's name or number), are another person's
  // data: they do not leave (D-140.2).
  critical_result_notice: {
    resourceIdsOf: (chartId, sites) => Prisma.sql`
      SELECT n.id FROM critical_result_notice n
        JOIN observation_result o ON o.id = n.observation_result_id
        JOIN diagnostic_report r ON r.id = o.report_id
        JOIN service_order s ON s.id = r.service_order_id
       WHERE s.encounter_id IN (${standingEncountersOf(chartId, sites)})`,
    omittedBecause: null,
    clinical: 'encounter',
    redactedColumns: ['recipient_name', 'note'],
  },
  patient_allergy: {
    resourceIdsOf: byPatientId('patient_allergy'),
    omittedBecause: null,
    clinical: 'person',
  },
  patient_history: {
    resourceIdsOf: byPatientId('patient_history'),
    omittedBecause: null,
    clinical: 'person',
  },
  patient_allergy_absence: {
    resourceIdsOf: byPatientId('patient_allergy_absence'),
    omittedBecause: null,
    clinical: 'person',
  },
  patient_priority_group: {
    resourceIdsOf: byPatientId('patient_priority_group'),
    omittedBecause:
      'Los grupos prioritarios y su motivo tienen permiso propio (PA-042); tampoco salen sus versiones (D-083 §3).',
  },
  // PD-066 (D-203 §9). Another person's cedula does not leave with this
  // person's export; and of an authority, only its name and the number of its
  // letter — never the text of what it asked.
  data_subject_request: {
    resourceIdsOf: byPatientId('data_subject_request'),
    omittedBecause: null,
    redactRow: (data) =>
      data.requested_by === 'AUTHORITY'
        ? omitKeys(data, ['description'])
        : omitKeys(data, ['requester_document']),
  },
  // AG-051, AG-162. The appointment moved or corrected in place. A version
  // from before the patient was corrected belongs to the patient booked BY
  // MISTAKE: neither that identifier nor the free texts written for that
  // visit leave (review, M-2; D-141.4). What remains — hours, practitioner,
  // channel — is what the export owes about the appointment.
  agenda_entry: {
    resourceIdsOf: byPatientId('agenda_entry'),
    omittedBecause: null,
    redactedColumns: [
      'patient_id',
      'reason',
      'cancellation_note',
      'emergency_note',
      'board_note',
      'coverage_check_skipped_reason',
      'left_without_being_seen_reason',
      'entered_in_error_reason',
    ],
  },
  // BI-195 (fix/menos-preguntas-caja). A charge corrected before it was
  // invoiced: charge → patient account → patient. It is the patient's own
  // record of what was charged and is exported like the rest (LOPDP art. 13,
  // right of access); nothing in the row is about somebody else.
  charge_item: {
    resourceIdsOf: (chartId) => Prisma.sql`
      SELECT c.id FROM charge_item c
        JOIN patient_account a ON a.id = c.account_id
       WHERE a.patient_id IN ${chartScopeIds(chartId)}`,
    omittedBecause: null,
  },
  // BI-215 (D-142.2, fix/corregir-factura). The account's previous payer,
  // price list or status: the patient's own record of who was to pay.
  patient_account: {
    resourceIdsOf: byPatientId('patient_account'),
    omittedBecause: null,
  },
  // BI-217 (D-093 B). The receiver of an invoice the SRI returned, before
  // caja corrected it. The receiver may be ANOTHER person — whoever deducts
  // the expense (BI-082) — so who it named does not leave (D-140.2); what
  // remains says that the invoice was corrected and when.
  invoice: {
    resourceIdsOf: (chartId) => Prisma.sql`
      SELECT i.id FROM invoice i
        JOIN patient_account a ON a.id = i.account_id
       WHERE a.patient_id IN ${chartScopeIds(chartId)}`,
    omittedBecause: null,
    redactedColumns: [
      'buyer_identification_type',
      'buyer_identification',
      'buyer_name',
      'buyer_email',
    ],
  },
  // BI-230 (fix/administracion-sencilla). A price corrected in place is
  // configuration, nobody's personal data: declared so the map stays
  // exhaustive, with a path that reaches no chart.
  price: {
    resourceIdsOf: () => Prisma.sql`SELECT NULL::uuid AS id WHERE false`,
    omittedBecause:
      'Un precio es configuración de la clínica: no es dato de ningún paciente.',
    reachesNoPatient: true,
  },
  // AG-064. The outcome of a call about this patient's waiting-list entry.
  waitlist_contact_attempt: {
    resourceIdsOf: (chartId) => Prisma.sql`
      SELECT a.id FROM waitlist_contact_attempt a
        JOIN waitlist_entry w ON w.id = a.waitlist_entry_id
       WHERE w.patient_id IN ${chartScopeIds(chartId)}`,
    omittedBecause: null,
  },
};

/**
 * PD-048. Every saved version of the rows of this chart and its absorbed ones,
 * table by table and in version order, with who replaced it and when.
 * `includeOmitted` is for the test that proves each path reaches its patient;
 * the export leaves it off.
 */
export async function recordVersionsOfChart(
  db: Db,
  chartId: string,
  options: {
    includeOmitted?: boolean;
    /**
     * PD-067 (D-203 §10). The caller's `record:read` scope, and whether it
     * holds the key of the person's record (`holdsRecordKey`). Absent: all.
     */
    recordScope?: RecordReadScope;
    holdsKey?: boolean;
  } = {},
): Promise<ExportedVersion[]> {
  const sites = options.recordScope ?? 'all';
  const holdsKey = options.holdsKey ?? true;
  const rows: {
    resource_type: string;
    resource_id: string;
    version: number;
    data: unknown;
    changed_by: string;
    changed_at: Date;
  }[] = [];
  // One after another: a transaction is one connection.
  for (const [table, path] of Object.entries(VERSIONED_TABLES)) {
    if (path.omittedBecause !== null && !options.includeOmitted) continue;
    if (path.clinical === 'person' && !holdsKey) continue;
    if (
      path.clinical === 'encounter' &&
      sites !== 'all' &&
      sites.length === 0
    ) {
      continue;
    }
    rows.push(
      ...(await db.$queryRaw<typeof rows>`
        SELECT resource_type, resource_id::text AS resource_id, version, data,
               changed_by::text AS changed_by, changed_at
          FROM record_version
         WHERE resource_type = ${table}
           AND resource_id IN (${path.resourceIdsOf(chartId, sites)})
         ORDER BY resource_id, version`),
    );
  }

  const names = await staffNames(
    db,
    rows.map((row) => row.changed_by),
  );
  return rows.map((row) => ({
    table: row.resource_type,
    resourceId: row.resource_id,
    version: row.version,
    changedAt: row.changed_at.toISOString(),
    changedBy: nameOf(names, row.changed_by),
    data: redact(row.data, VERSIONED_TABLES[row.resource_type]),
  }));
}

/**
 * D-140.2, REQ-115. The version without the columns about somebody else, nor
 * the protected values inside its lists.
 */
function redact(data: unknown, path: VersionedTablePath | undefined): unknown {
  if (!path || data === null || typeof data !== 'object') return data;
  if (path.redactRow) {
    data = path.redactRow(data as Record<string, unknown>);
  }
  const columns = path.redactedColumns ?? [];
  const inLists = path.redactedInLists ?? {};
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>)
      .filter(([column]) => !columns.includes(column))
      .map(([column, value]) => {
        const keys = inLists[column];
        if (!keys || !Array.isArray(value)) return [column, value];
        return [
          column,
          value.map((item: unknown) =>
            item !== null && typeof item === 'object'
              ? Object.fromEntries(
                  Object.entries(item as Record<string, unknown>).filter(
                    ([key]) => !keys.includes(key),
                  ),
                )
              : item,
          ),
        ];
      }),
  );
}
