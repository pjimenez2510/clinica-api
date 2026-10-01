import type { Prisma, PrismaClient } from '@prisma/client';

import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type {
  ChartLookup,
  ConsentTextView,
  Requester,
  StaffName,
} from '../domain/privacy.repository';

/** A client or a transaction: the reads below run in either. */
export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Reads of tables this module does NOT own — `patient`, `app_user` — stated
 * here and nowhere else, without importing the modules that own them
 * (ADR-011; same pattern as `documents/infrastructure/prisma-document-source.reader.ts`).
 */

/** PD-015. */
export async function chartLookup(
  db: Db,
  patientId: string,
): Promise<ChartLookup> {
  const chart = await db.patient.findUnique({
    where: { id: patientId },
    select: { mergedIntoId: true },
  });
  if (!chart) return { status: 'missing' };
  if (!chart.mergedIntoId) return { status: 'active' };
  const survivor = await db.patient.findUniqueOrThrow({
    where: { id: chart.mergedIntoId },
    select: { mrn: true },
  });
  return { status: 'merged', survivingMrn: survivor.mrn };
}

/**
 * The chart and every chart merged into it (PA-055). A merge re-points
 * nothing, so reading `patient_id = X` alone returns half of a merged chart.
 */
export async function chartIds(db: Db, patientId: string): Promise<string[]> {
  const rows = await db.patient.findMany({
    where: { OR: [{ id: patientId }, { mergedIntoId: patientId }] },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Staff names by id. Never the cedula: a screen names people, it does not identify them. */
export async function staffNames(
  db: Db,
  ids: Iterable<string | null>,
): Promise<Map<string, StaffName>> {
  const wanted = [...new Set([...ids].filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: wanted } },
    select: { id: true, firstName: true, lastName: true },
  });
  return new Map(
    users.map((user) => [
      user.id,
      { id: user.id, fullName: `${user.firstName} ${user.lastName}` },
    ]),
  );
}

export function nameOf(names: Map<string, StaffName>, id: string): StaffName {
  return names.get(id) ?? { id, fullName: '—' };
}

/** A patient as a list of requests names them: number of record and name. */
export async function patientNames(
  db: Db,
  ids: Iterable<string>,
): Promise<Map<string, { mrn: string; fullName: string }>> {
  const rows = await db.patient.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: {
      id: true,
      mrn: true,
      givenName: true,
      secondGivenName: true,
      familyName: true,
      secondFamilyName: true,
    },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        mrn: row.mrn,
        fullName: [
          row.familyName,
          row.secondFamilyName,
          row.givenName,
          row.secondGivenName,
        ]
          .filter(Boolean)
          .join(' '),
      },
    ]),
  );
}

export const CONSENT_TEXT_SELECT = {
  id: true,
  version: true,
  body: true,
  publishedAt: true,
  publishedBy: true,
} satisfies Prisma.ConsentTextVersionSelect;

export function toTextView(
  row: Prisma.ConsentTextVersionGetPayload<{
    select: typeof CONSENT_TEXT_SELECT;
  }>,
  names: Map<string, StaffName>,
): ConsentTextView {
  return {
    id: row.id,
    version: row.version,
    body: row.body,
    publishedAt: row.publishedAt,
    publishedBy: nameOf(names, row.publishedBy),
  };
}

/**
 * One row of `access_audit`, written INSIDE the caller's transaction (PD-006,
 * PD-017, PD-037, PD-043). Not through `AccessAuditRecorder`: its contract is
 * to log and never throw, and these acts must fail closed — a consent or an
 * export with no trail row must not exist. Same as `resetMfa` (AU-035).
 *
 * Identifiers only, never `before`/`after`: the base refuses a payload for
 * these resource types (`access_audit_payload_only_for_declared_resources`).
 */
export async function writeTrail(
  tx: Prisma.TransactionClient,
  entry: {
    resourceType:
      | 'consent_text_version'
      | 'patient_consent'
      | 'data_subject_request'
      | 'patient';
    resourceId: string;
    action: 'CREATE' | 'UPDATE' | 'EXPORT';
  },
  requester: Requester,
): Promise<void> {
  await tx.accessAudit.create({
    data: {
      userId: requester.userId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      action: entry.action,
      ip: requester.ip,
      userAgent: requester.userAgent?.slice(0, 512),
    },
  });
}

/** A `DATE` column as the clinical date it stores. */
export function toClinicalDate(value: Date): ClinicalDate {
  return value.toISOString().slice(0, 10) as ClinicalDate;
}

/** A clinical date as the `DATE` column takes it. */
export function fromClinicalDate(value: ClinicalDate): Date {
  return new Date(`${value}T00:00:00Z`);
}
