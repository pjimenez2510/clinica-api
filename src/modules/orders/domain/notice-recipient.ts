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

/** The words of a normalised name. */
const wordsOf = (name: string): string[] =>
  normalised(name).split(' ').filter(Boolean);

/**
 * ORD-147, ORD-157, ORD-174 (D-168 §4). Whether a typed name NAMES a person:
 * EVERY word of the person's name is in it, in any order —«Pérez Andrade
 * Juan», as the cédula writes it, names «Juan Pérez Andrade»—, ignoring case,
 * accents, punctuation and a leading title, and each word as many times as
 * the person's name has it. Words of more do not hide the person: «Carmen
 * Salazar Pilco» names the account «Carmen Salazar». In doubt the value stays
 * on the worklist, which is the safe error.
 *
 * ⚠️ NEVER BY PARTS. «Dr. Salazar» for «Carmen Salazar» does not name her:
 * matching a surname would give one person's notice to another person with
 * that surname, and the verdict decides whether a value stays on the critical
 * worklist.
 */
export function namesPerson(written: string, person: string): boolean {
  const wanted = wordsOf(person);
  if (wanted.length === 0) return false;
  const available = wordsOf(written);
  for (const word of wanted) {
    const at = available.indexOf(word);
    if (at === -1) return false;
    available.splice(at, 1);
  }
  return true;
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
  // A caller that is only a title («Dr.») names nobody: judged as if absent;
  // and one whose name carries the account's is the account (ORD-174).
  const caller = question.callerName?.trim();
  if (
    caller &&
    wordsOf(caller).length > 0 &&
    !namesPerson(caller, question.recorder.name)
  ) {
    return namesPerson(question.recipientName, caller);
  }
  if (
    question.recipientKind === 'ORDERING_PRACTITIONER' &&
    question.recorder.userId === question.orderedByUserId
  ) {
    return true;
  }
  return namesPerson(question.recipientName, question.recorder.name);
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
