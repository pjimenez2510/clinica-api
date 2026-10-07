import type { Sheet } from './xlsx';

/**
 * EN-233, EN-234. The WHO's CIE-10 tabular list in Spanish, as the DEIS of
 * Chile publishes it — the edition the RDACAA reports against.
 *
 * The file has three sheets and nothing else: no chapters, no groups and no
 * three-character categories. Every code has four characters, and those with
 * no subdivision carry an `X` (`I10X`), which is how the RDACAA expects them.
 *
 * ⚠️ STANDALONE: imported by `prisma/seed-cie10.mts` under strip-types, so the
 * only import is a type, which is erased.
 */

/** Which sheet a code comes from: what it may be used for. */
export type Cie10Use = 'PRINCIPAL' | 'ASTERISK' | 'EXTERNAL_CAUSE';

export interface WhoCie10Row {
  /** As the list writes it, without a dot: `J029`, `I10X`. */
  code: string;
  display: string;
  use: Cie10Use;
}

/**
 * The sheet names of the DEIS file. A sheet not listed here is refused: its
 * codes would come in with a use nobody chose.
 */
const SHEET_USE: Record<string, Cie10Use> = {
  'Códigos, más (cruz o daga)': 'PRINCIPAL',
  'Códigos (asterisco)': 'ASTERISK',
  'Códigos (causa externa)': 'EXTERNAL_CAUSE',
};

/**
 * The 22 chapters of the WHO's CIE-10 (2019 edition onwards), with their
 * Spanish titles. The DEIS list does not carry them, and the code says which
 * one a row belongs to.
 *
 * ⚠️ THE WHO RANGES, NOT THE CLINICAL MODIFICATION'S. The development list
 * came from the US ICD-10-CM and drew `C00-D49`, `E00-E89`, `K00-K95`,
 * `O00-O9A`: the borders move, and a chapter drawn with them would leave
 * `D48.9` or `E90.X` with no chapter at all.
 */
export const WHO_CHAPTERS: readonly {
  code: string;
  from: string;
  to: string;
  display: string;
}[] = [
  ['A00', 'B99', 'Ciertas enfermedades infecciosas y parasitarias'],
  ['C00', 'D48', 'Tumores [neoplasias]'],
  ['D50', 'D89', 'Enfermedades de la sangre y de los órganos hematopoyéticos, y ciertos trastornos que afectan el mecanismo de la inmunidad'], // prettier-ignore
  ['E00', 'E90', 'Enfermedades endocrinas, nutricionales y metabólicas'],
  ['F00', 'F99', 'Trastornos mentales y del comportamiento'],
  ['G00', 'G99', 'Enfermedades del sistema nervioso'],
  ['H00', 'H59', 'Enfermedades del ojo y sus anexos'],
  ['H60', 'H95', 'Enfermedades del oído y de la apófisis mastoides'],
  ['I00', 'I99', 'Enfermedades del sistema circulatorio'],
  ['J00', 'J99', 'Enfermedades del sistema respiratorio'],
  ['K00', 'K93', 'Enfermedades del sistema digestivo'],
  ['L00', 'L99', 'Enfermedades de la piel y del tejido subcutáneo'],
  ['M00', 'M99', 'Enfermedades del sistema osteomuscular y del tejido conjuntivo'], // prettier-ignore
  ['N00', 'N99', 'Enfermedades del sistema genitourinario'],
  ['O00', 'O99', 'Embarazo, parto y puerperio'],
  ['P00', 'P96', 'Ciertas afecciones originadas en el período perinatal'],
  ['Q00', 'Q99', 'Malformaciones congénitas, deformidades y anomalías cromosómicas'], // prettier-ignore
  ['R00', 'R99', 'Síntomas, signos y hallazgos anormales clínicos y de laboratorio, no clasificados en otra parte'], // prettier-ignore
  ['S00', 'T98', 'Traumatismos, envenenamientos y algunas otras consecuencias de causas externas'], // prettier-ignore
  ['V01', 'Y98', 'Causas externas de morbilidad y de mortalidad'],
  ['Z00', 'Z99', 'Factores que influyen en el estado de salud y contacto con los servicios de salud'], // prettier-ignore
  ['U00', 'U85', 'Códigos para propósitos especiales'],
].map(([from, to, display]) => ({
  code: `${from}-${to}`,
  from: from!,
  to: to!,
  display: display!,
}));

/** The chapter a code belongs to, by its first three characters. */
export function chapterOf(code: string): (typeof WHO_CHAPTERS)[number] | null {
  const category = code.replace('.', '').slice(0, 3);
  return (
    WHO_CHAPTERS.find(
      (chapter) => chapter.from <= category && category <= chapter.to,
    ) ?? null
  );
}

/** `J029` → `J02.9`; `I10X` → `I10.X`. */
export function withDot(code: string): string {
  return `${code.slice(0, 3)}.${code.slice(3)}`;
}

/**
 * The rows of the three sheets. The first two rows of each are a title and
 * the column header; a row with no code is a blank line of the sheet.
 */
export function readWhoCie10(sheets: readonly Sheet[]): WhoCie10Row[] {
  const rows: WhoCie10Row[] = [];
  const seen = new Set<string>();

  for (const sheet of sheets) {
    const use = SHEET_USE[sheet.name];
    if (!use) throw new Error(`Hoja desconocida en la CIE-10: «${sheet.name}»`);

    for (const [raw = '', description = ''] of sheet.rows.slice(2)) {
      const code = raw.trim();
      if (code === '') continue;
      if (!/^[A-Z]\d{2}[0-9X]$/.test(code))
        throw new Error(`Código CIE-10 con forma inesperada: «${code}»`);
      if (seen.has(code))
        throw new Error(`El código ${code} aparece dos veces en la lista`);
      if (chapterOf(code) === null)
        throw new Error(
          `El código ${code} no cae en ningún capítulo de la OMS`,
        );
      seen.add(code);
      rows.push({ code, display: description.trim(), use });
    }
  }
  return rows;
}

/**
 * EN-234. For every registered code the new edition does not carry, the codes
 * of the edition that begin like it. Nothing is chosen: a person decides.
 */
export function proposeEquivalents(
  registered: readonly string[],
  available: ReadonlySet<string>,
): { code: string; proposals: string[] }[] {
  const all = [...available].sort();
  return [...new Set(registered)]
    .filter((code) => !available.has(code))
    .sort()
    .map((code) => {
      const prefix = code.replace('.', '');
      return {
        code,
        proposals: all.filter(
          (candidate) =>
            prefix.length <= 4 && candidate.replace('.', '').startsWith(prefix),
        ),
      };
    });
}
