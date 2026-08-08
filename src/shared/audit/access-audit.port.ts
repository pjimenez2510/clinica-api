/**
 * The record of who looked at what.
 *
 * REQUIRED, NOT OPTIONAL. The LOPDP obliges us to be able to reconstruct who
 * accessed a person's health data and when; the `access_audit` table has
 * carried triggers making it append-only since the first migration, and until
 * now NOTHING WROTE TO IT. An immutable table with no rows proves nothing.
 *
 * A port because the write must not depend on Prisma from the application
 * layer, and because "where the trail is stored" is a decision that will
 * change — a long retention window belongs in cold storage, not in the
 * operational database.
 */
export type AuditAction = 'READ' | 'CREATE' | 'UPDATE' | 'EXPORT' | 'PRINT';

export interface AccessAuditEntry {
  /** Who. The internal user id, NEVER their cedula. */
  userId: string | null;
  /** What kind of thing was touched: `patient`, `encounter`, `certificate`. */
  resourceType: string;
  resourceId: string;
  action: AuditAction;
  /**
   * From where. The IP is personal data under LOPDP; it is stored because it
   * is necessary to investigate improper access, and that purpose is declared
   * in the processing activities register.
   */
  ip?: string;
  userAgent?: string;
}

export interface AccessAuditRecorder {
  /**
   * Writes one entry.
   *
   * MUST NOT throw into the caller's path. A failure to record is serious and
   * has to be alerted on, but refusing to show a doctor a chart because the
   * audit table is unreachable is the wrong trade in a clinic. The adapter
   * logs at error level instead — see its own comment for why that is the
   * lesser evil here and where it would not be.
   */
  record(entry: AccessAuditEntry): Promise<void>;
}

export const ACCESS_AUDIT_RECORDER = Symbol('AccessAuditRecorder');
