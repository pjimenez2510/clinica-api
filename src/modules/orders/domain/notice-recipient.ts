/**
 * Who a notice of a critical value went to, judged against people the system
 * knows: the account that records it and the practitioner who placed the
 * order (ORD-146, ORD-147).
 *
 * PURE: names in, a verdict out.
 */

/**
 * A courtesy title at the START of a typed name. «Dr. Juan Pérez» is the
 * person whose account says «Juan Pérez»; the title is how a nurse writes it,
 * not part of who it is.
 */
const LEADING_TITLE =
  /^(dr|dra|doctor|doctora|lcdo|lcda|lic|licdo|licda|enf|obst|ing|sr|sra|srta)\.?(\s+|$)/;

/** A name as two people would write it alike, or `''` for none. */
function normalised(name: string): string {
  let words = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  // Only one title, and only in front: «Dr. Dra.» is not a name anybody types.
  words = words.replace(LEADING_TITLE, '');
  // ORD-157. «Pérez, Juan» is «Juan Pérez»: punctuation separates words.
  return words
    .replace(/[.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words of a normalised name, in a canonical order. */
const wordsOf = (name: string): string =>
  normalised(name).split(' ').filter(Boolean).sort().join(' ');

/**
 * ORD-147, ORD-157 (D-156.5). Whether two typed names are the same person's:
 * the SAME WORDS in any order —«Pérez Andrade Juan», as the cédula writes it,
 * is «Juan Pérez Andrade»—, ignoring case, accents, spacing and a leading
 * title. Every word counts as many times as it is written.
 *
 * ⚠️ NEVER BY PARTS. «Dr. Pérez» for «Juan Pérez» is not recognised on
 * purpose: matching a surname would give one person's notice to another
 * person with that surname, and the verdict decides whether a value stays on
 * the critical worklist.
 */
export function samePersonName(a: string, b: string): boolean {
  const left = wordsOf(a);
  return left !== '' && left === wordsOf(b);
}

/** ORD-062, ORD-147. What judging a notice to oneself needs. */
export interface SelfNoticeQuestion {
  recipientKind: string;
  recipientName: string;
  /** The account that records (or, on an edit, recorded) the notice. */
  recorder: { userId: string; name: string };
  /** The account of the practitioner who placed the order. */
  orderedByUserId: string;
  /** ORD-148. Who made the call, when it was not the recorder. */
  callerName?: string | null;
}

/**
 * ORD-062, ORD-147 (D-113 b, D-116 d). A notice to oneself: the ordering
 * practitioner recording «al médico que pidió», or ANY notice whose recipient
 * carries the name of the account that records it, whatever its kind.
 *
 * ORD-155 (D-156.3). When SOMEBODY ELSE made the call (ORD-148), it is judged
 * with the caller and not with the recorder: the practitioner who writes «the
 * nurse phoned me» was told something by the nurse. Only a caller who is
 * their own recipient told nobody anything.
 */
export function isSelfNotice(question: SelfNoticeQuestion): boolean {
  // A caller that is only a title («Dr.») names nobody: judged as if absent.
  const caller = question.callerName?.trim();
  if (
    caller &&
    wordsOf(caller) !== '' &&
    !samePersonName(caller, question.recorder.name)
  ) {
    // prettier-ignore
    return samePersonName(question.recipientName, caller);
  }
  if (
    question.recipientKind === 'ORDERING_PRACTITIONER' &&
    question.recorder.userId === question.orderedByUserId
  ) {
    return true;
  }
  return samePersonName(question.recipientName, question.recorder.name);
}

/** ORD-062, ORD-146. A notice as the critical worklist judges it. */
export interface WorklistNotice {
  outcome: string;
  selfNotice: boolean;
  recipientKind: string;
  namesOrderingPractitioner: boolean;
  notifiedById: string;
  notifiedAt: Date;
}

const toOneselfByOrderer = (notice: WorklistNotice, orderer: string) =>
  notice.outcome === 'NOTIFIED' &&
  notice.selfNotice &&
  notice.notifiedById === orderer;

/**
 * ORD-146 (D-116 a). The practitioner who placed the order recorded a notice
 * to themselves: they know, and the notice is now due to the patient. Only
 * THEIR notice to themselves: a colleague noting it for themselves tells the
 * ordering practitioner nothing (revisión).
 */
export function selfNoticedByOrderer(
  notices: readonly WorklistNotice[],
  ordererUserId: string,
): boolean {
  return notices.some((notice) => toOneselfByOrderer(notice, ordererUserId));
}

/**
 * ORD-062, ORD-146. Whether the notices of a critical value take it off the
 * worklist: a notice given that is not a notice to oneself — except one to
 * the practitioner who placed the order AFTER they had noted it themselves
 * («sí, ya lo sé» tells them nothing). One given to them BEFORE still counts:
 * they were told then (D-116 a: «tras un autoaviso»).
 *
 * The SAME judgement is written in SQL in `criticalChains` (which version a
 * correction starts its new notice after); the integration suite holds the
 * two to the same cases.
 */
export function closesCriticalWorklist(
  notices: readonly WorklistNotice[],
  ordererUserId: string,
): boolean {
  return notices.some((notice) => {
    if (notice.outcome !== 'NOTIFIED' || notice.selfNotice) return false;
    const toOrderer =
      notice.recipientKind === 'ORDERING_PRACTITIONER' ||
      notice.namesOrderingPractitioner;
    if (!toOrderer) return true;
    return !notices.some(
      (own) =>
        toOneselfByOrderer(own, ordererUserId) &&
        own.notifiedAt.getTime() <= notice.notifiedAt.getTime(),
    );
  });
}
