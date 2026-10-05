import { Prisma, type PrismaClient } from '@prisma/client';

import { WRITTEN_TEXT_PATTERN } from '../../domain/written-text';

/**
 * D-085 §3. «Was this patient attended?» — answered by the RECORD, once.
 *
 * Any clinical act of a practitioner in the attention counts: a note WITH
 * SOMETHING WRITTEN (draft or signed; an empty note is not one, D-099 §5), a
 * diagnosis, a procedure, a prescription or an order; and, by D-104, a
 * certificate not revoked, a referral or an interconsultation that stands.
 * Vital signs do NOT: they are the preparation,
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
/**
 * D-103, D-104. The referrals and interconsultations that STAND: the same
 * states make the patient attended (here) and keep the attention from being
 * annulled (`liveActsOf`, encounter). One list, so the two answers cannot
 * drift — the 4.ª revisión found them counting different things.
 */
export const STANDING_REFERRAL_STATUSES = [
  'ISSUED',
  'ACCEPTED',
  'COMPLETED',
] as const;
export const STANDING_INTERCONSULTATION_STATUSES = [
  'REQUESTED',
  'ANSWERED',
] as const;

/**
 * The same predicate as SQL, for a query that has to ask it of many
 * attentions at once (BI-190: the old unsettled visits have no ceiling, so
 * eight questions per row would be an N+1 without end). `encounterId` is the
 * expression that names the attention — a parameter or a column.
 *
 * ONE DEFINITION: `hasClinicalAct` asks exactly this, so the two answers
 * cannot drift.
 */
export function clinicalActExists(encounterId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    EXISTS (
      SELECT 1
        FROM clinical_note n,
             jsonb_each(CASE WHEN jsonb_typeof(n.content) = 'object' THEN n.content ELSE '{}'::jsonb END) AS section
       WHERE n.encounter_id = ${encounterId}
         AND jsonb_typeof(section.value) = 'string'
         AND (section.value #>> '{}') ~ ${WRITTEN_TEXT_PATTERN}
    )
    OR EXISTS (SELECT 1 FROM encounter_diagnosis d WHERE d.encounter_id = ${encounterId})
    OR EXISTS (SELECT 1 FROM encounter_procedure p WHERE p.encounter_id = ${encounterId})
    OR EXISTS (SELECT 1 FROM prescription r WHERE r.encounter_id = ${encounterId})
    -- ORD-100. A draft is not an act yet; a discarded one never was.
    OR EXISTS (SELECT 1 FROM service_order o
                WHERE o.encounter_id = ${encounterId} AND o.status::text = 'ISSUED')
    -- D-104: a certificate states there was an attention; a referral and an
    -- interconsultation are clinical decisions about the patient.
    OR EXISTS (SELECT 1 FROM medical_certificate c
                WHERE c.encounter_id = ${encounterId} AND c.revoked_at IS NULL)
    OR EXISTS (SELECT 1 FROM referral f
                WHERE f.encounter_id = ${encounterId}
                  AND f.status::text IN (${Prisma.join(STANDING_REFERRAL_STATUSES)}))
    OR EXISTS (SELECT 1 FROM interconsultation i
                WHERE i.encounter_id = ${encounterId}
                  AND i.status::text IN (${Prisma.join(STANDING_INTERCONSULTATION_STATUSES)}))
  )`;
}

export async function hasClinicalAct(
  client: Prisma.TransactionClient | PrismaClient,
  encounterId: string,
): Promise<boolean> {
  // D-099 §5: a note counts only with something WRITTEN in it. Opening an
  // empty note is not a consultation anybody can answer for. «Written» is the
  // rule of `written-text.ts`, the same one that decides which drafts are
  // signed: only text sections, and blanks are every character `trim`
  // removes — `btrim` alone took a lone Enter for writing (3.ª revisión, G1).
  const [row] = await client.$queryRaw<{ any: boolean }[]>`
    SELECT ${clinicalActExists(Prisma.sql`${encounterId}::uuid`)} AS any
  `;
  return row?.any === true;
}
