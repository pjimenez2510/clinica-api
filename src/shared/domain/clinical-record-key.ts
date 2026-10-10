/**
 * D-203 §1 (decided by the author, 10-10-2026). Who authorises and downloads
 * the copy of a clinical record: ONE person, but with the key of the record.
 * Whoever answers the requests about a patient's data (`patient:data-requests`)
 * authorises and downloads the copy only while they ALSO hold `record:read`
 * at the patient's site, and the copy reaches the sites of their `record:read`,
 * never all of them by the other permission alone.
 *
 * Shared because two modules ask it —`privacy` before an answer, `documents`
 * before a download— and no module imports another.
 */

/** The caller's `record:read` scope, as `Principal.sitesFor` resolves it. */
export type RecordReadScope = 'all' | readonly string[];

/**
 * Whether the caller holds the key for a person whose signed attentions were
 * at `patientSites`: `record:read` everywhere, or at one of those sites; and,
 * for a person never attended, `record:read` somewhere. No `record:read` at
 * all is never the key —an empty scope is a denial, not «no filter»—.
 */
export function holdsRecordKey(
  scope: RecordReadScope,
  patientSites: readonly string[],
): boolean {
  if (scope === 'all') return true;
  if (scope.length === 0) return false;
  if (patientSites.length === 0) return true;
  return patientSites.some((site) => scope.includes(site));
}

/** Whether an attention at `siteId` is within the caller's scope. */
export function withinRecordScope(
  scope: RecordReadScope,
  siteId: string,
): boolean {
  return scope === 'all' || scope.includes(siteId);
}
