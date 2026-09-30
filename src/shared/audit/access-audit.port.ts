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
/**
 * What was done.
 *
 * Four of these are the CRUD-shaped verbs every module writes. `MFA_RESET` is
 * not, and it earns the exception: AU-035 makes the trail the requirement
 * rather than a side effect, because the permission behind that act lets
 * somebody take over another person's account. Recorded as `UPDATE` it would
 * be indistinguishable from renaming the same account, so the audit question
 * «¿a quién le han reiniciado el segundo factor, y quién?» would have no
 * answer — which is the only thing making the permission safe to grant.
 *
 * `access_audit.action` is a `varchar(32)` with no CHECK, so widening this
 * union is the whole change.
 *
 * ⚠️ `MFA_RESET` IS ALSO THE ONE ACTION THAT DOES NOT TRAVEL THROUGH THIS PORT.
 * Because the entry is the requirement rather than a side effect, it is written
 * inside the reset's own transaction — see
 * `PrismaAccountAdminRepository.resetMfa` — so a reset that cannot be recorded
 * does not happen. It is listed here because the shape and the vocabulary are
 * the same trail; what differs is the failure policy, and that is stated on
 * `record` below.
 */
export type AuditAction =
  'READ' | 'CREATE' | 'UPDATE' | 'EXPORT' | 'PRINT' | 'MFA_RESET';

/**
 * A resource as it stood, in the shape the DOMAIN uses — never the ORM row.
 *
 * `Record<string, unknown>` because from here it is a JSON object and nothing
 * more. What a caller must hand over is the domain view it already returns to
 * its own callers: an ORM row drags whatever columns were added since, and
 * `createdAt`/`updatedAt` in particular are noise, since the instant of the
 * change is the audit row's own `occurredAt`.
 */
export type AuditSnapshot = Readonly<Record<string, unknown>>;

/**
 * One row of `access_audit`, the append-only trail the LOPDP obliges us to
 * keep. Carries identifiers only: never a cedula, and never a clinical snapshot
 * (see `before`).
 */
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
  /**
   * D-017, AG-097, CF-066. What the mutation replaced and what it left.
   *
   * ⚠️ ONLY SOME RESOURCE TYPES MAY CARRY THESE, AND THE BASE IS WHAT SAYS SO.
   * `access_audit_payload_only_for_declared_resources` refuses a row whose
   * `resource_type` is not on the whitelist and whose payload is not null.
   * Today the list is exactly `'configuration'`. Clinical resource types are
   * deliberately absent: this table exists to watch who reads a chart, it is
   * append-only and it is never purged, so a chart's contents landing in it
   * could never be corrected, minimised or removed.
   *
   * So passing these for a clinical resource is not a convention violation
   * that reviewers might catch — PostgreSQL refuses the INSERT, and because a
   * failure to record does not throw (see `record`), the entry would simply be
   * LOST. Widening the whitelist is a decision about personal data, taken in
   * `../clinica-docs/DECISIONES-PENDIENTES.md`, not a schema tweak.
   *
   * Absent on a read, on a creation (`before`) and on a deletion (`after`).
   */
  before?: AuditSnapshot;
  after?: AuditSnapshot;
}

/**
 * The write side of the trail. Its failure policy — log, never throw — is the
 * contract; see `record`.
 */
export interface AccessAuditRecorder {
  /**
   * Writes one entry.
   *
   * MUST NOT throw into the caller's path. A failure to record is serious and
   * has to be alerted on, but refusing to show a doctor a chart because the
   * audit table is unreachable is the wrong trade in a clinic. The adapter
   * logs at error level instead — see its own comment for why that is the
   * lesser evil here and where it would not be.
   *
   * WHICH IS WHY AN ACT THAT MUST FAIL CLOSED DOES NOT COME THROUGH HERE. The
   * policy is a property of this port, not something a caller can opt out of,
   * so `MFA_RESET` (AU-035) writes its entry inside its own transaction
   * instead. An EXPORT or a PRINT of clinical data, when they exist, must do
   * the same.
   */
  record(entry: AccessAuditEntry): Promise<void>;
}

export const ACCESS_AUDIT_RECORDER = Symbol('AccessAuditRecorder');
