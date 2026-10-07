import type { Sheet } from './xlsx';

/**
 * PR-114, PR-115, PR-116. The Cuadro Nacional de Medicamentos Básicos as the
 * MSP publishes it: one row per presentation, 890 rows, 528 «Código
 * medicamento» (the ATC code the cuadro prints).
 *
 * ⚠️ STANDALONE: imported by `prisma/seed-clinical-catalogues.mts` under
 * strip-types, so the only import is a type, which is erased.
 */

/** PR-115. One presentation of the cuadro, as the prescription reads it. */
export interface CnmbPresentation {
  /** The form a choice of this presentation proposes: the first of `forms`. */
  form: string;
  /** The forms of the prescription vocabulary this presentation admits. */
  forms: string[];
  /** The form as the cuadro names it: «Sólido oral». */
  label: string;
  concentration: string;
  route: string;
  /** «Nombre mostrado» of the cuadro. */
  name: string;
  /** The DCI of this row; the same as the medicine's but for seven codes. */
  dci: string;
  prescriptionLevel: string;
  careLevel: string;
  pregnancyRisk: string;
  therapeuticUse: string;
}

/** PR-116. One concept of the CNMB: a «Código medicamento». */
export interface CnmbMedicine {
  code: string;
  display: string;
  atc: string;
  atcClass: string;
  presentations: CnmbPresentation[];
  controlled: boolean;
  /** PR-114. Codes of earlier cuadros that named this medicine. */
  replaces: string[];
  /**
   * PR-114. The active substances of its rows, as allergy keys: the same DCI
   * under another code (acetylsalicylic acid, `B01AC06` and `N02BA01`) is the
   * same substance. Written like `substanceKeyOf` in `prescription`.
   */
  substances: string[];
}

const HEADER = [
  'Codigo medicamento',
  'Codigo ATC',
  'Clasificacion ATC',
  'DCI',
  'Nombre mostrado',
  'Concentracion',
  'Codigo prescripcion',
  'Nivel de prescripcion',
  'Nivel de atencion',
  'Via de administracion',
  'Forma farmaceutica',
  'Uso terapeutico',
  'Riesgo en embarazo',
] as const;

/**
 * D-148. Estupefacientes (Convención Única de 1961, listas I y II) and
 * psicotrópicos (Convenio de 1971, listas III y IV) present in the CNMB 2026.
 * The cuadro does not mark them, and PR-070 must not compose their receta.
 *
 * ⚠️ PENDING A PHARMACIST (D-148). On the safe side: marking one too many
 * sends it to the ACESS pad; marking one too few prints a receta the law does
 * not accept. Tramadol, tapentadol, tiopental and hidrato de cloral are not on
 * the international lists and are left unmarked, as questions in D-148.
 */
export const CONTROLLED_CODES: ReadonlySet<string> = new Set([
  'N01AH01', // fentanilo — 1961, I
  'N01AH06', // remifentanilo — 1961, I
  'N02AA01', // morfina — 1961, I
  'N02AA03', // hidromorfona — 1961, I
  'N02AA05', // oxicodona — 1961, I
  'N02AA59', // codeína — 1961, II
  'N07BC02', // metadona — 1961, I
  'N02AE01', // buprenorfina — 1971, III
  'N03AA02', // fenobarbital — 1971, IV
  'N03AE01', // clonazepam — 1971, IV
  'N05BA01', // diazepam — 1971, IV
  'N05BA06', // lorazepam — 1971, IV
  'N05BA09', // clobazam — 1971, IV
  'N05BA12', // alprazolam — 1971, IV
  'N05CD08', // midazolam — 1971, IV
]);

/**
 * PR-114. The codes of the development cuadro (`DEV-2026-08`) and the CNMB
 * medicine each one was. An allergy recorded against the development concept
 * has to fire when the official one is prescribed. Cetirizina, ranitidina,
 * hidroclorotiazida and glibenclamida are not in the CNMB 2026 and have no
 * successor.
 */
export const DEVELOPMENT_CODES: Readonly<Record<string, string>> = {
  PARACETAMOL: 'N02BE01',
  IBUPROFENO: 'M01AE01',
  AMOXICILINA: 'J01CA04',
  'AMOXICILINA-CLAVULANICO': 'J01CR02',
  AZITROMICINA: 'J01FA10',
  CEFALEXINA: 'J01DB01',
  CIPROFLOXACINO: 'J01MA02',
  'TRIMETOPRIMA-SULFAMETOXAZOL': 'J01EE01',
  METRONIDAZOL: 'P01AB01',
  NITROFURANTOINA: 'J01XE01',
  LORATADINA: 'R06AX13',
  SALBUTAMOL: 'R03AC02',
  PREDNISONA: 'H02AB07',
  DEXAMETASONA: 'H02AB02',
  OMEPRAZOL: 'A02BC01',
  METOCLOPRAMIDA: 'A03FA01',
  'SALES-REHIDRATACION': 'A07CA',
  ALBENDAZOL: 'P02CA03',
  ENALAPRIL: 'C09AA02',
  LOSARTAN: 'C09CA01',
  AMLODIPINO: 'C08CA01',
  ATORVASTATINA: 'C10AA05',
  METFORMINA: 'A10BA02',
  'INSULINA-NPH': 'A10AC01',
  LEVOTIROXINA: 'H03AA01',
  'ACIDO-FOLICO': 'B03BB01',
  'SULFATO-FERROSO': 'B03AA07',
  'CARBONATO-CALCIO': 'A12AA04',
  'ACIDO-ACETILSALICILICO': 'B01AC06',
  DICLOFENACO: 'M01AB05',
  TRAMADOL: 'N02AX02',
  MORFINA: 'N02AA01',
};

/** Lower case, no accents: «Sólido» and «solido» are one form. */
const plain = (value: string) =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** PR-114. `dci:` and the DCI without accents, case or extra spaces. */
export function substanceKey(dci: string): string {
  return `dci:${plain(dci).replace(/\s+/g, ' ').trim()}`;
}

/**
 * PR-115. The forms of the prescription vocabulary a form of the cuadro
 * admits, the proposed one first. The cuadro says «Sólido oral»; the receta
 * says tableta or cápsula, and either is the cuadro's.
 *
 * A form with no counterpart in the vocabulary (intratraqueal, intravesical,
 * intrauterino, rectal líquido) admits none: a line in it is outside the
 * cuadro. A qualified form —liberación prolongada, sublingual, lipídica— maps
 * to its own form and to no other, so the receta says it.
 */
export function vocabularyFormsOf(label: string, route: string): string[] {
  const form = plain(label);
  const via = plain(route);

  if (form.startsWith('solido oral')) {
    if (form.includes('polvo')) return ['POWDER_FOR_ORAL_SUSPENSION'];
    if (form.includes('granul')) return ['GRANULES'];
    // The qualified forms are what the receta has to say, and only that.
    if (form.includes('liberacion prolongada')) return ['EXTENDED_RELEASE_TABLET']; // prettier-ignore
    if (form.includes('sublingual')) return ['SUBLINGUAL_TABLET'];
    if (form.includes('dispersable')) return ['DISPERSIBLE_TABLET'];
    if (form.includes('gastroresistente')) return ['GASTRORESISTANT_CAPSULE'];
    if (form.includes('capsula')) return ['CAPSULE'];
    return ['TABLET', 'COATED_TABLET', 'CHEWABLE_TABLET', 'CAPSULE'];
  }
  if (form.startsWith('liquido oral')) {
    if (form.includes('jarabe/gotas')) return ['SYRUP', 'ORAL_DROPS'];
    if (form.includes('gotas')) return ['ORAL_DROPS'];
    if (form.includes('solucion bucal')) return ['ORAL_SOLUTION'];
    return ['ORAL_SUSPENSION', 'SYRUP', 'ORAL_SOLUTION', 'ORAL_DROPS'];
  }
  if (form.startsWith('liquido parenteral')) return ['INJECTABLE_SOLUTION'];
  if (form.startsWith('solido parenteral')) {
    if (form.includes('implante')) return ['SUBDERMAL_IMPLANT'];
    if (form.includes('lipidic')) return ['LIPID_POWDER_FOR_INJECTION'];
    if (form.includes('nanoparticula')) return ['NANOPARTICLE_POWDER_FOR_INJECTION']; // prettier-ignore
    if (form.includes('liberacion prolongada')) return ['EXTENDED_RELEASE_INJECTION']; // prettier-ignore
    return ['POWDER_FOR_INJECTION'];
  }
  if (form.startsWith('semisolido cutaneo'))
    return ['CREAM', 'OINTMENT', 'GEL'];
  if (form.startsWith('liquido cutaneo')) return ['LOTION'];
  if (form.startsWith('solido cutaneo'))
    return form.includes('parche') ? ['TRANSDERMAL_PATCH'] : [];
  if (form.startsWith('liquido oftalmico')) return ['EYE_DROPS'];
  if (form.startsWith('semisolido oftalmico')) return ['EYE_OINTMENT'];
  if (form.startsWith('liquido para inhalacion')) {
    if (via.startsWith('n -')) return ['NASAL_SPRAY'];
    if (via.includes('nebuliz')) return ['NEBULISER_SOLUTION', 'INHALER'];
    return ['INHALER', 'NEBULISER_SOLUTION'];
  }
  if (form.startsWith('solido para inhalacion')) return ['INHALER'];
  if (form.startsWith('semisolido vaginal')) return ['VAGINAL_CREAM'];
  if (form.startsWith('solido vaginal')) return ['VAGINAL_OVULE'];
  if (form.startsWith('solido rectal')) return ['SUPPOSITORY'];
  return [];
}

/**
 * PR-116. The name of a medicine whose rows carry more than one DCI.
 *
 * A spelling variant (`Ondansetron`, `Ondansetrón`) is one name: the accented
 * one. When one DCI begins all the others (`Haloperidol`, `Haloperidol
 * decanoato`) it is the name. Otherwise they are different products under one
 * code and the name says both. Each presentation keeps its own DCI.
 */
function displayOf(dcis: readonly string[]): string {
  const accented = (value: string) => value.normalize('NFD') !== value;
  const distinct: string[] = [];
  for (const dci of dcis) {
    const same = distinct.findIndex((known) => plain(known) === plain(dci));
    if (same < 0) distinct.push(dci);
    else if (accented(dci) && !accented(distinct[same]!)) distinct[same] = dci;
  }
  if (distinct.length === 1) return distinct[0]!;
  const base = distinct.find((candidate) =>
    distinct.every(
      (other) =>
        other === candidate || plain(other).startsWith(`${plain(candidate)} `),
    ),
  );
  return base ?? [...distinct].sort().join(' / ');
}

/** PR-116. The medicines of the cuadro, in the order the file lists them. */
export function readCnmb(sheet: Sheet): CnmbMedicine[] {
  const [header, ...rows] = sheet.rows;
  HEADER.forEach((name, index) => {
    if ((header?.[index] ?? '').trim() !== name)
      throw new Error(
        `El CNMB no tiene la columna esperada «${name}» en la posición ${index + 1}`,
      );
  });

  const byCode = new Map<string, { row: string[]; dci: string }[]>();
  for (const raw of rows) {
    const row = HEADER.map((_, index) => (raw[index] ?? '').trim());
    const code = row[0]!;
    if (code === '') continue;
    byCode.set(code, [...(byCode.get(code) ?? []), { row, dci: row[3]! }]);
  }

  return [...byCode.entries()].map(([code, entries]) => {
    const display = displayOf(entries.map((entry) => entry.dci));
    const presentations: CnmbPresentation[] = [];
    const seen = new Set<string>();
    for (const { row } of entries) {
      const [, , , dci, name, concentration, , level, care, route, label, use, risk] = row; // prettier-ignore
      const key = [dci, concentration, label, route].map((v) => plain(v!)).join('|'); // prettier-ignore
      // The cuadro repeats one row verbatim (rifampicina + isoniazida).
      if (seen.has(key)) continue;
      seen.add(key);
      const forms = vocabularyFormsOf(label!, route!);
      presentations.push({
        form: forms[0] ?? '',
        forms,
        label: label!,
        concentration: concentration!,
        route: route!,
        name: name!,
        dci: dci === display ? display : dci!,
        prescriptionLevel: level!,
        careLevel: care!,
        pregnancyRisk: risk!,
        therapeuticUse: use!,
      });
    }
    const [first] = entries;
    return {
      code,
      display,
      atc: first!.row[1]!,
      atcClass: first!.row[2]!,
      presentations,
      controlled: CONTROLLED_CODES.has(code),
      substances: [...new Set(entries.map((entry) => substanceKey(entry.dci)))],
      replaces: Object.entries(DEVELOPMENT_CODES)
        .filter(([, successor]) => successor === code)
        .map(([development]) => development),
    };
  });
}
