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
  /** The account that recorded it. */
  notifiedBy: { id: string };
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
  /** No notice on this value closes it yet. */
  due: boolean;
  /**
   * The version is the standing one. A replaced one is kept in the answer so
   * the call made while it still stood can be recorded (ORD-062, ORD-144);
   * only a standing one waits on the worklist.
   */
  standing: boolean;
  /**
   * ORD-153 (D-156.1). An earlier version was told to the patient or their
   * representative: only a notice to one of the two closes it.
   */
  patientRequired: boolean;
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

/** ORD-153. Told to the patient or to whoever answers for them. */
const toPatient = (notice: StatedNotice): boolean =>
  notice.recipientKind === 'PATIENT' ||
  notice.recipientKind === 'REPRESENTATIVE';

/**
 * ORD-143, ORD-156 (D-156.4). Whether a value reads differently from the one
 * somebody was told about. Told a value that was NOT critical —itself the
 * notice of a correction—, only a change of flag counts: 95 told, corrected
 * to 97, is still normal and the report's record is enough. A value without a
 * flag (no range applied, a text) has no «side»: judged by what is written,
 * the safe side.
 */
function readsDifferently(told: StatedResult, now: StatedResult): boolean {
  if (
    !isCritical(told.abnormalFlag) &&
    told.abnormalFlag !== null &&
    now.abnormalFlag !== null
  ) {
    return told.abnormalFlag !== now.abnormalFlag;
  }
  return !sameReading(told, now);
}

/** A report chain is bounded by construction; this only stops a corrupt one. */
const MAX_CHAIN = 100;

/**
 * ORD-143. For every result of the order that corrects a value somebody was
 * told about, what it corrects and whether the correction still waits for its
 * notice —the STANDING ones are the worklist—.
 *
 * Entered when an earlier version of the same determination has a notice
 * given —a notice to oneself included: the practitioner who noted the 25 may
 * have acted on it— and the value is not critical and reads differently from
 * the last version told. A value rewritten the same (the laboratory corrected
 * the potassium) changes nothing anybody knew.
 *
 * ⚠️ A CORRECTION STILL WAITING IS INHERITED (revisión, grave). If the last
 * version told is itself a correction whose notice never closed it —the
 * practitioner noted the 95 for themselves while the patient was told the
 * 25—, a later version that rewrites the 95 does not make it «already told»:
 * it carries the same pending correction, of the same 25.
 *
 * Closed by a notice given on the value to the patient or their
 * representative when an earlier one went to them (ORD-153); otherwise by
 * one that is not a notice to oneself; or
 * by one to oneself when every notice given before was too, BY THE SAME
 * ACCOUNT —only that practitioner ever knew, and their own record is the one
 * that matters; another colleague noting it for themselves tells them
 * nothing—.
 */
export function notifiedCorrections(
  versions: readonly StatedVersion[],
): Map<string, NotifiedCorrection> {
  const byId = new Map(versions.map((version) => [version.id, version]));
  const found = new Map<string, NotifiedCorrection>();
  const judged = new Set<string>();

  /** Judges a version after every version it replaced (memoised). */
  const judge = (version: StatedVersion, depth = 0): void => {
    if (judged.has(version.id) || depth > MAX_CHAIN) return;
    judged.add(version.id);
    if (version.supersedesId === null) return;
    const previous = byId.get(version.supersedesId);
    if (previous) judge(previous, depth + 1);

    // The versions it replaced, newest first.
    const earlier: StatedVersion[] = [];
    let next = previous;
    while (next && earlier.length < MAX_CHAIN) {
      earlier.push(next);
      next = next.supersedesId ? byId.get(next.supersedesId) : undefined;
    }

    for (const result of version.results) {
      if (isCritical(result.abnormalFlag)) continue;
      const before = earlier.flatMap((older) => {
        const same = older.results.find(
          (each) => each.analyteDisplay === result.analyteDisplay,
        );
        return same ? [{ version: older, result: same }] : [];
      });
      const last = before.find(({ result: each }) => each.notices.some(given));
      if (!last) continue;
      // A told version that is itself a correction still waiting: inherited.
      const pending = found.get(last.result.id);
      const inherited = pending?.due === true ? pending : undefined;
      if (!inherited && !readsDifferently(last.result, result)) continue;

      const earlierNotices = before
        .flatMap(({ result: each }) => each.notices.filter(given))
        .sort((a, b) => a.notifiedAt.getTime() - b.notifiedAt.getTime());
      // ORD-153 (D-156.1). The patient who heard of the 25 has to hear of
      // the 95: a call to the on-call doctor does not tell them.
      const patientRequired = earlierNotices.some(
        (notice) => toPatient(notice) && !notice.selfNotice,
      );
      const closed = result.notices.some(
        (notice) =>
          given(notice) &&
          (patientRequired
            ? toPatient(notice) && !notice.selfNotice
            : !notice.selfNotice ||
              earlierNotices.every(
                (n) => n.selfNotice && n.notifiedBy.id === notice.notifiedBy.id,
              )),
      );

      found.set(result.id, {
        resultId: result.id,
        told: inherited?.told ?? {
          valueNumeric: last.result.valueNumeric,
          valueCode: last.result.valueCode,
          valueText: last.result.valueText,
          unit: last.result.unit,
          abnormalFlag: last.result.abnormalFlag,
          observedAt: last.result.observedAt,
        },
        earlierNotices,
        // The told version was replaced, so the instant exists; the fallback
        // only keeps a corrupt chain from printing a blank.
        correctedAt:
          inherited?.correctedAt ??
          last.version.supersededRecordedAt ??
          result.observedAt,
        due: !closed,
        standing: version.supersededById === null,
        patientRequired,
      });
    }
  };

  for (const version of versions) judge(version);
  return found;
}
