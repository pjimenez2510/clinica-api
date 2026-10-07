import type { AbnormalFlag } from './analyte';

/**
 * ORD-143 (D-115). A correction of a value somebody was already told about.
 *
 * PURE: the reports of ONE order in, a verdict per standing result out. The
 * worklist, the reading of the order and the recording of the notice all ask
 * this one function, so the three cannot disagree about which corrections
 * still have to be communicated.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUIEN ACTUÓ SOBRE EL 25 TIENE QUE SABER QUE ERA FALSO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The patient was told of a glucose of 25 —maybe went to the emergency
 * room— and the laboratory corrects it to 95. The 95 is not critical and
 * entered no worklist: nothing asked anybody to say the 25 was wrong. It is
 * art. 39 in reverse.
 *
 * ⚠️ A CORRECTION THAT IS STILL CRITICAL IS NOT HANDLED HERE: it waits on the
 * critical worklist, which asks for a new notice (ORD-145), and that notice is
 * the same record.
 */

/** One notice as the rule needs it. */
export interface StatedNotice {
  recipientKind: string;
  recipientName: string;
  notifiedAt: Date;
  outcome: string;
  selfNotice: boolean;
}

/** One value as a version of a report states it. */
export interface StatedResult {
  id: string;
  analyteDisplay: string;
  valueNumeric: number | null;
  valueCode: string | null;
  valueText: string | null;
  unit: string | null;
  abnormalFlag: AbnormalFlag | null;
  observedAt: Date;
  notices: readonly StatedNotice[];
}

/** One version of a report, with the correction that replaced it. */
export interface StatedVersion {
  id: string;
  supersedesId: string | null;
  supersededById: string | null;
  /** When the correction that replaced this version was RECORDED. */
  supersededRecordedAt: Date | null;
  results: readonly StatedResult[];
}

/** ORD-143. What a standing value corrects, and whether that is still due. */
export interface NotifiedCorrection {
  /** The standing result. */
  resultId: string;
  /** The last earlier version somebody was told about. */
  told: Omit<StatedResult, 'id' | 'analyteDisplay' | 'notices'>;
  /** Every notice given (`NOTIFIED`) of an earlier version, oldest first. */
  earlierNotices: readonly StatedNotice[];
  /** When the correction that replaced the told version was recorded. */
  correctedAt: Date;
  /** No notice on the standing value closes it yet. */
  due: boolean;
}

const isCritical = (flag: AbnormalFlag | null): boolean =>
  flag === 'CRITICAL_LOW' || flag === 'CRITICAL_HIGH';

const given = (notice: StatedNotice): boolean => notice.outcome === 'NOTIFIED';

/** The same reading: value and unit. The flag follows from them. */
function sameReading(a: StatedResult, b: StatedResult): boolean {
  return (
    a.valueNumeric === b.valueNumeric &&
    a.valueCode === b.valueCode &&
    a.valueText === b.valueText &&
    a.unit === b.unit
  );
}

/** A report chain is bounded by construction; this only stops a corrupt one. */
const MAX_CHAIN = 100;

/**
 * ORD-143. For every STANDING result of the order that corrects a value
 * somebody was told about, what it corrects and whether the correction still
 * waits for its notice.
 *
 * Entered when an earlier version of the same determination has a notice
 * given —a notice to oneself included: the practitioner who noted the 25 may
 * have acted on it— and the standing value is not critical and reads
 * differently from the last version told. A value rewritten the same (the
 * laboratory corrected the potassium) changes nothing anybody knew.
 *
 * Closed by a notice given on the standing value that is not a notice to
 * oneself; or by one to oneself when every notice given before was too —only
 * that practitioner ever knew, and their own record is the one that matters.
 */
export function notifiedCorrections(
  versions: readonly StatedVersion[],
): Map<string, NotifiedCorrection> {
  const byId = new Map(versions.map((version) => [version.id, version]));
  const found = new Map<string, NotifiedCorrection>();

  for (const standing of versions) {
    if (standing.supersededById !== null || standing.supersedesId === null) {
      continue;
    }
    // The versions it replaced, newest first.
    const earlier: StatedVersion[] = [];
    let next = byId.get(standing.supersedesId);
    while (next && earlier.length < MAX_CHAIN) {
      earlier.push(next);
      next = next.supersedesId ? byId.get(next.supersedesId) : undefined;
    }

    for (const result of standing.results) {
      if (isCritical(result.abnormalFlag)) continue;
      const before = earlier.flatMap((version) => {
        const same = version.results.find(
          (each) => each.analyteDisplay === result.analyteDisplay,
        );
        return same ? [{ version, result: same }] : [];
      });
      const told = before.find(({ result: each }) => each.notices.some(given));
      if (!told || sameReading(told.result, result)) continue;

      const earlierNotices = before
        .flatMap(({ result: each }) => each.notices.filter(given))
        .sort((a, b) => a.notifiedAt.getTime() - b.notifiedAt.getTime());
      const onlyToOneself = earlierNotices.every((n) => n.selfNotice);
      const closed = result.notices.some(
        (notice) => given(notice) && (!notice.selfNotice || onlyToOneself),
      );

      found.set(result.id, {
        resultId: result.id,
        told: {
          valueNumeric: told.result.valueNumeric,
          valueCode: told.result.valueCode,
          valueText: told.result.valueText,
          unit: told.result.unit,
          abnormalFlag: told.result.abnormalFlag,
          observedAt: told.result.observedAt,
        },
        earlierNotices,
        // The told version was replaced, so the instant exists; the fallback
        // only keeps a corrupt chain from printing a blank.
        correctedAt: told.version.supersededRecordedAt ?? result.observedAt,
        due: !closed,
      });
    }
  }
  return found;
}
