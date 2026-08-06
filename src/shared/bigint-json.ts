/**
 * Teaches `JSON.stringify` how to serialise a `BigInt`.
 *
 * WHY THIS IS NEEDED: PostgreSQL `bigserial` columns come back from Prisma as
 * `BigInt` — `AccessAudit.id`, `ObservationResult.id`, `PatientMerge.id`,
 * `AgendaStatusHistory.id`. `JSON.stringify` throws
 * `TypeError: Do not know how to serialize a BigInt` on them, so the first
 * endpoint that returns one answers a generic 500 with nothing pointing at the
 * cause. For the audit log, that is the endpoint the SPDP asks to see.
 *
 * WHY A STRING AND NOT A NUMBER: above 2^53 a JavaScript number loses precision
 * silently, and these are identifiers. An id that comes back subtly different
 * from the one stored is worse than an error — it is a wrong record with no
 * symptom.
 *
 * WHY PATCHING A GLOBAL PROTOTYPE IS ACCEPTABLE HERE: the alternative is
 * converting at every boundary, which is the same decision taken once per
 * developer per endpoint, forever, and forgotten once. It is imported
 * explicitly in `main.ts` rather than as a side effect of some barrel, so the
 * patch is visible where the process starts.
 */

interface BigIntWithJson {
  toJSON?: () => string;
}

export function enableBigIntSerialisation(): void {
  (BigInt.prototype as BigIntWithJson).toJSON = function toJSON(
    this: bigint,
  ): string {
    return this.toString();
  };
}
