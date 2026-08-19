/**
 * SP-009. The stable code of a specialty, derived from the name somebody typed.
 *
 * WHY NOBODY TYPES IT ANY MORE (ADR-005 §5). The code is an identifier the
 * person filling the form cannot interpret: «no se le pide a nadie que teclee
 * un código que no interpreta». It still exists and is still a public contract
 * — `staff` links practitioners by it, reports carry it, and the MSP seed
 * matches its 22 rows by it — so what changed is WHO WRITES IT, not whether it
 * is there.
 *
 * DERIVED ON CREATION AND NEVER AGAIN (SP-010). See the warning in
 * `SpecialtiesService.updateSpecialty`: re-deriving on a rename would move the
 * identity of the row out from under everything that references it, and fixing
 * a missing accent in «Ginecologia» would be enough to do it.
 *
 * THE RULE, and why it is exactly this one: the derivation has to reproduce the
 * 22 codes already seeded in `prisma/seed-specialties.mts` — a derivation that
 * produced `medicina-familiar-comunitaria` where the catalogue says
 * `medicina-familiar` would hand the same specialty two identities depending on
 * who created it. `specialty-code.spec.ts` walks all 22 and fails if one drifts.
 *   1. fold accents and lowercase — `Ginecología` and `GINECOLOGIA` are one word;
 *   2. anything that is not a letter or a digit separates words;
 *   3. drop the link words, which identify nothing («y», «de», «del»…);
 *   4. keep the first two words that remain.
 *
 * Step 4 is what makes «Medicina de Emergencias y Desastres» come out as
 * `medicina-emergencias`: a code is a handle, not a transcription of the name.
 * Its price is that two long names sharing their first two words derive the
 * same code, and the unique index refuses the second one — deliberately, and
 * `SpecialtyDuplicateError` is written to say so in terms of the NAME, which is
 * the only thing that person wrote.
 */

/**
 * Spanish link words. They carry no identity: «Medicina del Trabajo» and
 * «Medicina de Trabajo» are the same specialty typed twice.
 */
const LINK_WORDS: ReadonlySet<string> = new Set([
  'a',
  'al',
  'con',
  'de',
  'del',
  'e',
  'el',
  'en',
  'la',
  'las',
  'lo',
  'los',
  'o',
  'para',
  'por',
  'u',
  'un',
  'una',
  'y',
]);

/** A handle, not a transcription: see step 4 above. */
const MAX_WORDS = 2;

/** `specialty.code` is `varchar(64)`. */
const MAX_LENGTH = 64;

/**
 * The code for a name. Empty when the name has nothing derivable in it — a
 * name written entirely in a script the code alphabet cannot represent. The
 * function stays TOTAL rather than throwing so the DTO can refuse that name at
 * the boundary, where the answer is a field error and not a 500.
 */
export function specialtyCodeFromName(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);

  const significant = words.filter((word) => !LINK_WORDS.has(word));
  // A name made only of link words is not a specialty, but answering '' to it
  // would refuse something that does have letters in it. Its own words serve.
  const chosen = (significant.length > 0 ? significant : words).slice(
    0,
    MAX_WORDS,
  );

  return chosen.join('-').slice(0, MAX_LENGTH).replace(/-+$/, '');
}
