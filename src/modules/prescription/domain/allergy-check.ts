/**
 * PR-060 to PR-067. The one allergy check this system is entitled to make.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE LEVELS, AND ONLY THE FIRST IS OURS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **EXACT MATCH** — the active substance prescribed IS the one the chart
 *     says the patient reacts to. `patient_allergy.substance_concept_id` and
 *     `prescription_item.concept_id` both point at the CNMB, so this is a
 *     COMPARISON OF KEYS: no text, no stemming, no heuristics. Built, and it is
 *     the only one that interrupts.
 *  2. **THERAPEUTIC CLASS** — same ATC group (PR-065). The official CNMB files
 *     every medicine under its ATC code, so this too compares keys: the first
 *     four characters of two codes. It INFORMS and never interrupts. Which
 *     level of the ATC is «the class» is a clinical call (D-183.1): built at
 *     level 3, the therapeutic or pharmacological subgroup.
 *  3. **CROSS-REACTIVITY** — penicillins and cephalosporins and the rest. NOT
 *     BUILT AND NOT SIMULATED (PR-066): it is a commercial knowledge base, and
 *     an approximation of one produces warnings nobody can audit.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE ALERT HAS TO BE PROPORTIONATE, WHICH IS A REQUIREMENT (PR-067)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * In a study of 158 023 allergy warnings, 81 % were overridden — and on audit,
 * more than 96 % of those overrides were clinically correct. An alert that is
 * right one time in twenty does not protect anybody: it teaches the reader to
 * dismiss without looking, and the one they dismiss without looking is the
 * twentieth. So there is exactly ONE blocking alert in this module, it fires
 * almost never, and everything else informs.
 *
 * PURE: two lists in, a list of matches out. No database, no clock.
 */

/** PR-062. One allergy of the chart — and of every chart it absorbed. */
export interface KnownAllergy {
  id: string;
  /**
   * PR-064. The CNMB concept when the allergen is a drug; `null` when it is a
   * food, latex or an insect sting and only free text was recorded.
   *
   * ⚠️ A `null` HERE CAN NEVER MATCH, and that is the design rather than a
   * limitation: level 1 compares keys. Comparing the free text is precisely how
   * false alerts are manufactured — «penicilina» does not match «amoxicilina»,
   * and «polvo» matches «polvo para suspensión oral».
   */
  substanceConceptId: string | null;
  /** What the chart says, for the document (PR-027). Never for matching. */
  substanceText: string;
}

/** One line of the prescription, as the check sees it. */
export interface PrescribedSubstance {
  /** 1-based, because it is what an error message names (PR-032, PR-094). */
  line: number;
  conceptId: string | null;
}

/**
 * PR-060, PR-065, PR-067. One coincidence, addressed by line and by allergy:
 * `EXACT` is the same substance and interrupts the issue; `CLASS` is the same
 * ATC subgroup and only informs.
 */
export interface AllergyAlert {
  line: number;
  allergyId: string;
  /**
   * ⚠️ NO MEDICATION NAME AND NO SUBSTANCE TEXT. The alert travels to the
   * client, and from there to logs and support screenshots; a drug name IS a
   * diagnosis said differently — metformin says diabetes, efavirenz says HIV
   * (PR-094, SC-036). The screen already holds the line it is about, and the
   * allergy is addressed by its identifier so the doctor can open it.
   */
  match: 'EXACT' | 'CLASS';
}

/**
 * PR-060, PR-063, PR-064. Every exact coincidence between what is prescribed
 * and what the chart flags.
 *
 * REFUTED ALLERGIES DO NOT REACH HERE (PR-063): the adapter filters
 * `refuted_at IS NULL` in the same statement that reads them, so «se descartó»
 * is a property of the query rather than a condition somebody has to remember
 * at each call site. Knowing an allergy was ruled out is clinical information
 * in its own right — which is why the row survives — and it is not a
 * contraindication.
 *
 * ONE ALERT PER (LINE, ALLERGY) PAIR: the same substance recorded twice on two
 * merged charts produces two alerts, and collapsing them would hide that the
 * evidence comes from two places.
 */
export function exactAllergyMatches(
  items: readonly PrescribedSubstance[],
  allergies: readonly KnownAllergy[],
  keys: SubstanceKeys = new Map(),
): AllergyAlert[] {
  const alerts: AllergyAlert[] = [];

  for (const item of items) {
    if (item.conceptId === null) continue;
    const itemKeys = keys.get(item.conceptId) ?? [];
    for (const allergy of allergies) {
      if (allergy.substanceConceptId === null) continue;
      const same =
        allergy.substanceConceptId === item.conceptId ||
        (keys.get(allergy.substanceConceptId) ?? []).some((key) =>
          itemKeys.includes(key),
        );
      if (!same) continue;
      alerts.push({ line: item.line, allergyId: allergy.id, match: 'EXACT' });
    }
  }

  return alerts;
}

/**
 * PR-114. The keys of one substance, by CNMB concept id: its code and the codes
 * it replaces.
 *
 * ⚠️ WHY KEYS AND NOT IDS ALONE. The CNMB is versioned: every edition creates
 * new concepts, so the amoxicillin an allergy was recorded against and the one
 * prescribed after the next load have DIFFERENT ids and the SAME code. Compared
 * by id, the first load of the official cuadro would have silenced every
 * allergy recorded before it. The code is still a key — no text, no stemming —
 * and `replaces` carries the codes of an edition that named the medicine
 * otherwise (`ENALAPRIL` of the development cuadro is `C09AA02`).
 */
export type SubstanceKeys = ReadonlyMap<string, readonly string[]>;

/**
 * PR-114. The key of an active substance: its DCI without accents, case or
 * extra spaces. The CNMB files one substance under several codes (acetylsalicylic
 * acid is `B01AC06` at 100 mg and `N02BA01` at 500 mg; metronidazole three
 * times), and an allergy to it is an allergy to all of them. The importer
 * writes the same key in `attributes.substances` (`catalogs/import/cnmb.ts`).
 */
export function substanceKeyOf(dci: string): string {
  const plain = dci
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return `dci:${plain}`;
}

/**
 * PR-114. The keys of one CNMB concept: its code, the codes it replaces and
 * the active substances it declares — or, when it declares none (the
 * development cuadro), the substance its name is. No blanks, no repeats.
 */
export function substanceKeysOf(concept: {
  code: string;
  display: string;
  attributes: unknown;
}): string[] {
  const attributes =
    typeof concept.attributes === 'object' && concept.attributes !== null
      ? (concept.attributes as { replaces?: unknown; substances?: unknown })
      : {};
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === 'string' && item !== '',
        )
      : [];
  const substances = strings(attributes.substances);
  return [
    ...new Set([
      concept.code,
      ...strings(attributes.replaces),
      ...(substances.length > 0
        ? substances
        : [substanceKeyOf(concept.display)]),
    ]),
  ];
}

/**
 * PR-065. A complete ATC code: anatomical group, two digits, two letters, two
 * digits (`J01CA04`). Anything else — the development cuadro's `ENALAPRIL`, a
 * DCI key — has no class to read, and a code that is not one is never cut.
 */
const ATC_SUBSTANCE = /^[A-Z]\d{2}[A-Z]{2}\d{2}$/;

/**
 * PR-065, D-183.1. The therapeutic class of a key: level 3 of the ATC, its
 * first four characters (`J01C`, the beta-lactam penicillins). `null` for a
 * key that is not a complete ATC code.
 */
export function therapeuticClassOf(key: string): string | null {
  return ATC_SUBSTANCE.test(key) ? key.slice(0, 4) : null;
}

function classesOf(conceptId: string, keys: SubstanceKeys): Set<string> {
  return new Set(
    (keys.get(conceptId) ?? []).flatMap((key) => {
      const atcClass = therapeuticClassOf(key);
      return atcClass === null ? [] : [atcClass];
    }),
  );
}

/**
 * PR-065. Every line whose medicine shares the ATC class of a drug the chart
 * flags, AND IS NOT ALREADY AN EXACT MATCH: the same pair said twice would be
 * the louder alert diluted by the softer one.
 *
 * ⚠️ NOT CROSS-REACTIVITY (PR-066). A cephalosporin after a penicillin
 * allergy is `J01D` against `J01C`: different classes, no alert. Which
 * cephalosporins cross-react is what a commercial knowledge base sells, and
 * the ATC does not say it.
 *
 * Same input as `exactAllergyMatches`, same refusal to compare text: an
 * allergy recorded only as text, or a line outside the cuadro, has no code
 * and therefore no class.
 */
export function therapeuticClassMatches(
  items: readonly PrescribedSubstance[],
  allergies: readonly KnownAllergy[],
  keys: SubstanceKeys,
): AllergyAlert[] {
  const exact = new Set(
    exactAllergyMatches(items, allergies, keys).map(
      (alert) => `${alert.line}:${alert.allergyId}`,
    ),
  );
  const alerts: AllergyAlert[] = [];

  for (const item of items) {
    if (item.conceptId === null) continue;
    const itemClasses = classesOf(item.conceptId, keys);
    if (itemClasses.size === 0) continue;
    for (const allergy of allergies) {
      if (allergy.substanceConceptId === null) continue;
      if (exact.has(`${item.line}:${allergy.id}`)) continue;
      const shared = [...classesOf(allergy.substanceConceptId, keys)].some(
        (atcClass) => itemClasses.has(atcClass),
      );
      if (!shared) continue;
      alerts.push({ line: item.line, allergyId: allergy.id, match: 'CLASS' });
    }
  }

  return alerts;
}
