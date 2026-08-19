import { Prisma } from '@prisma/client';

/**
 * What happens to a person's PLACE IN THE QUEUE when two of her charts are
 * merged (PA-060, D-041 option B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROBLEM, IN ONE SCENE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > Rosa enrols on the waiting list in March. In August admissions notices she
 * > has two charts and merges them — correctly. From that moment her enrolment
 * > hangs off the absorbed chart, and the queue never proposes it again.
 *
 * The merge is an administrative act; the queue is a SHARE-OUT of a scarce
 * thing. Today the first silently costs her the second: she is called after
 * everybody who enrolled in April, May and June. AG-061 promises the turn goes
 * by ORDER OF ARRIVAL OF THE PERSON, and a chart is not a person.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY READING THROUGH THE LINK IS NOT ENOUGH HERE, THOUGH IT IS EVERYWHERE ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PA-055 resolves «the chart and the ones it absorbed» for everything that is
 * only READ: allergies, contacts, priority groups, appointments. An enrolment
 * is not only read — IT TURNS INTO AN APPOINTMENT, and there the link stops
 * working:
 *
 *   - booking for the absorbed chart is refused (AG-027, `PATIENT_MERGED`);
 *   - `trg_waitlist_entry_conversion_consented` demands the linked appointment
 *     be of the SAME `patient_id` as the entry, so the survivor's appointment
 *     does not serve either.
 *
 * Proposing it would be offering a slot nobody can take, and leaving it in the
 * queue competing for every freed slot without ever being able to win one.
 * That is why D-041 chose (B) and not the scope of PA-055.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS LIVES IN `shared` AND NOT IN EITHER MODULE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `waitlist_entry` belongs to `agenda`; the merge belongs to `patients`; NO
 * MODULE IMPORTS FROM ANOTHER MODULE. `pnpm arch:check` reads imports, so
 * `patients` writing `agenda`'s table with its own inline SQL would pass the
 * check and cross the boundary through the back door — which is worse than a
 * caught violation, because nothing would ever say so.
 *
 * The same shape as `patient-chart-scope.ts`, and for the same reason: «what
 * happens to the enrolments when two charts merge» is not a rule OF either
 * side. It is a rule about the seam, and it belongs where both can read it.
 *
 * A PORT OF `patients` IMPLEMENTED IN `agenda` WAS THE OTHER ANSWER, and it
 * costs more than it buys here. Everything below has to run INSIDE the merge's
 * own transaction — «una fusión que mueve media cosa no puede existir» — so
 * the port would have to carry a `Prisma.TransactionClient` through
 * `patients/domain`, which is precisely the ORM that layer may not name, and
 * be wired from outside both modules to avoid the import it is there to
 * prevent. Two indirections and a leaked ORM handle to express one sentence
 * that is neither module's. A function that takes the open transaction says
 * the same thing and can be read in one sitting.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND D-031 IS UNTOUCHED: NOT ONE ROW IS RE-POINTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No `patient_id` changes here. The absorbed chart's entries stay exactly
 * where they were written, which is what keeps `linkedRecords` (PA-049)
 * honest: it counts what STAYED, and after this it still counts the same rows.
 * What the merge adds is a NEW row on the survivor carrying the ORIGINAL
 * `created_at`, and undoing the merge takes that row away again.
 */

/**
 * AG-067, and the predicate of the partial index
 * `waitlist_entry_open_candidates`, written where the merge has to state it.
 *
 * ONLY THE OPEN ONES ARE CARRIED, and the three that are not are each a
 * deliberate no:
 *
 *   - `SCHEDULED` already got its slot, and the appointment it produced is
 *     read from the survivor through the scope (PA-055). Enrolling again for
 *     something already given would put the same person in the queue twice.
 *   - `EXPIRED` and `CANCELLED` are dead. Recreating one on the survivor WITH
 *     ITS ORIGINAL SENIORITY is exactly what `trg_waitlist_entry_closure_final`
 *     exists to make impossible — «una entrada cerrada no vuelve a competir por
 *     un cupo» — and going around a trigger through another table is still
 *     going around it.
 *
 * It cannot be imported from `agenda/domain/waitlist.ts` (`OPEN_WAITLIST_STATUSES`)
 * because `shared` importing a module is the boundary this file exists to keep.
 * It is a literal in SQL, next to the sentence that explains it.
 */
const OPEN_STATUSES = Prisma.sql`('WAITING', 'CONTACTED')`;

/** The snapshot key the merge trail records this under (PA-044, PA-060). */
const RE_ENROLLED_KEY = 'reEnrolledWaitlistEntryIds';

/**
 * PA-060. The absorbed chart's open enrolments, re-created on the survivor
 * WITH THE ORIGINAL DATE OF ENROLMENT. Returns the ids created.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `created_at` IS COPIED, AND IT IS THE WHOLE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AG-061 breaks ties by seniority and reads it off `created_at`. A row born
 * with `now()` would be a correct merge that quietly moves the person to the
 * back of the queue, which is the defect D-041 names. The column has a
 * `DEFAULT` rather than a trigger, so stating the value is all it takes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY *NOT* COPIED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE CONTACT TRAIL. `waitlist_contact_attempt` is append-only by trigger
 * (AG-064): rows copied into it could never be removed, so undoing the merge
 * would be impossible — and a call is a fact about a call, not about a queue
 * position. The new row therefore starts with no attempts of its own, and
 * `status` is `WAITING` rather than the original `CONTACTED`, because
 * `CONTACTED` on an entry nobody has ever called is a lie in the one table
 * that has to be able to answer «¿por qué el cupo se lo llevó ella?». The
 * visible consequence is that the site's cap (AG-066) starts over for the new
 * entry; it errs towards calling the person once more, which is the direction
 * D-041 chose, and the alternative errs towards an entry that can never be
 * undone.
 *
 * A LAPSED RANGE IS COPIED TOO, and that is not an oversight: adding
 * `preferred_to >= current_date` would be a second copy of AG-065 written in
 * SQL — where no unit test can reach it and where `current_date` resolves in
 * the SESSION's zone, the exact bug `clinical_date_in_ecuador_timezone` had to
 * correct once. The sweep that already runs at the head of every waiting-list
 * use case expires it, on the Ecuadorian date, like any other.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND NOT TWICE FOR THE SAME SLOT: `NOT EXISTS`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * If the survivor ALREADY has an open enrolment stating the same site, the
 * same practitioner, the same service type and the same preferred range, no
 * copy is made. Those five columns are the entire content of an enrolment
 * (AG-060), so two entries agreeing on all of them are the same request: any
 * slot compatible with one is compatible with the other, and both in the queue
 * would be one person competing twice for one slot — the opposite of a fair
 * share-out. The absorbed row simply stays where it is, dormant.
 *
 * EQUAL AND NOT OVERLAPPING. A wider or narrower range is a DIFFERENT request
 * — it names days the other does not — and dropping it would silently discard
 * days the person asked for.
 *
 * ⚠️ AND THE SURVIVOR'S OWN ROW IS NOT BACKDATED. When it is the newer of the
 * two, the person keeps the place that chart already had rather than the older
 * one. Rewriting `created_at` on a row the merge did not create would make the
 * column mean two different things — when the row was written, and when the
 * person joined the queue — and would need a second thing to undo. It is
 * written down here rather than decided in silence: it is the one case where
 * this file does not fully restore seniority, and it is bounded (she is
 * already in the queue for exactly this).
 */
export async function reEnrolOpenWaitlistEntries(
  tx: Prisma.TransactionClient,
  charts: { absorbedChartId: string; survivingChartId: string },
): Promise<string[]> {
  const created = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO waitlist_entry (
      patient_id, site_id, practitioner_id, service_type_id,
      preferred_from, preferred_to, created_at, updated_at
    )
    SELECT ${charts.survivingChartId}::uuid,
           waiting.site_id,
           waiting.practitioner_id,
           waiting.service_type_id,
           waiting.preferred_from,
           waiting.preferred_to,
           waiting.created_at,
           now()
      FROM waitlist_entry AS waiting
     WHERE waiting.patient_id = ${charts.absorbedChartId}::uuid
       AND waiting.status IN ${OPEN_STATUSES}
       AND NOT EXISTS (
             SELECT 1
               FROM waitlist_entry AS standing
              WHERE standing.patient_id = ${charts.survivingChartId}::uuid
                AND standing.status IN ${OPEN_STATUSES}
                AND standing.site_id = waiting.site_id
                AND standing.practitioner_id IS NOT DISTINCT FROM waiting.practitioner_id
                AND standing.service_type_id IS NOT DISTINCT FROM waiting.service_type_id
                AND standing.preferred_from = waiting.preferred_from
                AND standing.preferred_to = waiting.preferred_to
           )
    RETURNING id::text AS id
  `;

  return created.map((row) => row.id);
}

/**
 * PA-060, PA-047. Undoing the merge undoes the re-enrolment.
 *
 * BY ID, FROM THE MERGE'S OWN TRAIL, exactly as the identifiers come back
 * (`movedIdentifierIds`): deducing which rows to remove from their shape would
 * be guessing, and the row it would guess wrong about is an enrolment the
 * survivor made on her own account afterwards. Ids never guess. Nothing has to
 * be done to the absorbed chart's originals — they never moved, and clearing
 * `merged_into_id` is what puts them back in the queue, with nobody having to
 * remember anything (PA-055).
 *
 * ⚠️ TWO STATEMENTS, BECAUSE A COPY CAN HAVE A LIFE OF ITS OWN BY NOW.
 *
 *  1. A copy NOBODY EVER CALLED is DELETED. It is a row the merge invented, so
 *     removing it leaves the queue exactly as it stood before — the honest
 *     meaning of «se revierte».
 *  2. A copy WITH CONTACT ATTEMPTS is CANCELLED instead. That trail is
 *     append-only (AG-064) and `ON DELETE RESTRICT` on
 *     `waitlist_contact_attempt` would refuse the delete anyway: the database
 *     is the one deciding here, not a habit. A call that happened is not
 *     erased because a merge was reversed; the entry simply stops competing,
 *     and the original wakes up on the chart that is whole again.
 *
 * A copy already `SCHEDULED` is touched by neither: it has attempts (a
 * conversion needs a recorded acceptance), and
 * `trg_waitlist_entry_closure_final` refuses to reopen or re-close what is
 * closed. It keeps pointing at the appointment somebody really was given —
 * undoing a merge means we now believe these are two people, and the
 * appointment belongs to the one who was called.
 */
export async function undoWaitlistReEnrolment(
  tx: Prisma.TransactionClient,
  entryIds: readonly string[],
): Promise<void> {
  if (entryIds.length === 0) return;

  const ids = [...entryIds];

  await tx.$executeRaw`
    DELETE FROM waitlist_entry AS copied
     WHERE copied.id = ANY(${ids}::uuid[])
       AND NOT EXISTS (
             SELECT 1
               FROM waitlist_contact_attempt AS called
              WHERE called.waitlist_entry_id = copied.id
           )
  `;

  await tx.$executeRaw`
    UPDATE waitlist_entry
       SET status = 'CANCELLED',
           updated_at = now()
     WHERE id = ANY(${ids}::uuid[])
       AND status IN ${OPEN_STATUSES}
  `;
}

/**
 * PA-060. Which entries this merge created, read back from its trail row.
 *
 * DEFENSIVE FOR THE SAME REASON AS `movedIdentifierIdsOf`: `jsonb` has no
 * schema, and merges recorded before this key existed have none. Anything that
 * is not a list of strings means «none were created», which leaves those older
 * merges exactly as they were — undoable, with nothing to take back.
 */
export function reEnrolledWaitlistEntryIdsOf(
  snapshot: Prisma.JsonValue | null,
): string[] {
  if (typeof snapshot !== 'object' || snapshot === null) return [];
  if (Array.isArray(snapshot)) return [];

  const created = snapshot[RE_ENROLLED_KEY];
  if (!Array.isArray(created)) return [];

  return created.filter((id): id is string => typeof id === 'string');
}

/**
 * The same key on the way in, so the writer and the reader cannot drift.
 *
 * A snapshot fragment rather than a bare array: `patient_merge.source_snapshot`
 * is append-only and never purged, so what goes into it is spread by the one
 * function that names the key.
 */
export function reEnrolledWaitlistEntrySnapshot(
  entryIds: readonly string[],
): Prisma.JsonObject {
  return { [RE_ENROLLED_KEY]: [...entryIds] };
}
