import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * D-085 §3. «Was this patient attended?» — answered by the RECORD, once.
 *
 * Any clinical act of a practitioner in the attention counts: a note WITH
 * SOMETHING WRITTEN (draft or signed; an empty note is not one, D-099 §5), a
 * diagnosis, a procedure, a prescription or an order. Vital signs do NOT: they are the preparation,
 * and a patient who leaves after them was not seen by the doctor (D-081 §2).
 *
 * IN `shared` BECAUSE THREE MODULES ASK IT and no module imports another: the
 * agenda, before writing «se fue sin ser atendido» (AG-148); the attention's
 * exits, to decide where the appointment ends (AG-149); and billing, to decide
 * whether an interrupted attention proposes the consultation (D-085 §4). Three
 * copies of this predicate would be three answers the day a new kind of act
 * appears — and the one that forgot it would write «no atendido» over a
 * prescription.
 *
 * Takes any client, so a caller already inside a transaction asks with its
 * own snapshot and locks.
 */
export async function hasClinicalAct(
  client: Prisma.TransactionClient | PrismaClient,
  encounterId: string,
): Promise<boolean> {
  // D-099 §5: a note counts only with something WRITTEN in it. Opening an
  // empty note is not a consultation anybody can answer for.
  const [written] = await client.$queryRaw<{ any: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM clinical_note n,
             jsonb_each_text(CASE WHEN jsonb_typeof(n.content) = 'object' THEN n.content ELSE '{}'::jsonb END) AS section
       WHERE n.encounter_id = ${encounterId}::uuid
         AND btrim(section.value) <> ''
    ) AS any
  `;
  if (written?.any) return true;

  const counts = await Promise.all([
    client.encounterDiagnosis.count({ where: { encounterId } }),
    client.encounterProcedure.count({ where: { encounterId } }),
    client.prescription.count({ where: { encounterId } }),
    client.serviceOrder.count({ where: { encounterId } }),
  ]);
  return counts.some((count) => count > 0);
}
