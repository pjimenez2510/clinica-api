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
  return words;
}

/**
 * ORD-147. Whether two typed names are the same person's: word for word,
 * ignoring case, accents, spacing and a leading title.
 *
 * ⚠️ NEVER BY PARTS. «Dr. Pérez» for «Juan Pérez» is not recognised on
 * purpose: matching a surname would give one person's notice to another
 * person with that surname, and the verdict decides whether a value stays on
 * the critical worklist.
 */
export function samePersonName(a: string, b: string): boolean {
  const left = normalised(a);
  return left !== '' && left === normalised(b);
}

/** ORD-062, ORD-147. What judging a notice to oneself needs. */
export interface SelfNoticeQuestion {
  recipientKind: string;
  recipientName: string;
  /** The account that records (or, on an edit, recorded) the notice. */
  recorder: { userId: string; name: string };
  /** The account of the practitioner who placed the order. */
  orderedByUserId: string;
}

/**
 * ORD-062, ORD-147 (D-113 b, D-116 d). A notice to oneself: the ordering
 * practitioner recording «al médico que pidió», or ANY notice whose recipient
 * carries the name of the account that records it, whatever its kind.
 */
export function isSelfNotice(question: SelfNoticeQuestion): boolean {
  if (
    question.recipientKind === 'ORDERING_PRACTITIONER' &&
    question.recorder.userId === question.orderedByUserId
  ) {
    return true;
  }
  return samePersonName(question.recipientName, question.recorder.name);
}
