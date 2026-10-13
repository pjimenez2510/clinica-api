import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

/**
 * EV-1. The cases the harness may send to a provider, and nothing else.
 *
 * D-239 §1: no datum of a real patient leaves for any provider until the
 * clauses and zero retention are in place with every one of them. So a case
 * is either invented — written for this harness, versioned in `eval/casos/` —
 * or public: CodiEsp (Miranda-Escalada et al., 2020, CC BY 4.0, Zenodo
 * 3837305), read from its own annotation files and never versioned here.
 * Anything else stops the run before a request is built.
 */
/** Relative to the package root, where `pnpm eval` runs. */
export const CASES_DIR = join(process.cwd(), 'eval', 'casos');

const invented = z.literal('invented', {
  error:
    'Cada caso debe declarar origen «invented»: sólo casos inventados o de CodiEsp',
});

/** One problem as a physician writes it, and its WHO CIE-10 code (`J02.9`, `I10.X`). */
export const cie10CaseSchema = z.object({
  id: z.string().min(1),
  origin: invented,
  phrase: z.string().min(1),
  code: z.string().regex(/^[A-Z]\d{2}\.[0-9X]$/),
});

/** The fields of one prescribed medicine, as the receta reads it. */
export const prescribedSchema = z.object({
  /** The active substance, as the CNMB displays it. */
  substance: z.string().min(1),
  /** The CNMB «Código medicamento» (ATC). */
  cnmbCode: z.string().min(1),
  /** A form of the prescription vocabulary (`TABLET`, `ORAL_SUSPENSION`…). */
  form: z.string().min(1),
  concentration: z.string().min(1),
  dose: z.object({ amount: z.number().positive(), unit: z.string().min(1) }),
  route: z.string().min(1),
  everyHours: z.number().positive().nullable(),
  days: z.number().positive().nullable(),
});
export type Prescribed = z.infer<typeof prescribedSchema>;

/** A dictated prescription and the one medicine it means. */
export const prescriptionCaseSchema = z.object({
  id: z.string().min(1),
  origin: invented,
  dictation: z.string().min(1),
  expected: prescribedSchema,
});

/** A conversation, line by line, and the facts a note of it must keep. */
export const noteCaseSchema = z.object({
  id: z.string().min(1),
  origin: invented,
  lines: z.array(z.string().min(1)).min(2),
  facts: z
    .array(z.object({ section: z.string().min(1), fact: z.string().min(1) }))
    .min(1),
});

/**
 * AS-079 (D2). The Plan of an invented note and the lines «Proponer la
 * receta» must show: the CNMB code and the concentration as the cuadro writes
 * it, or `null` when the written one is not in the cuadro and the line must
 * stay without a presentation (AS-066). Distractors expect nothing.
 */
export const prescriptionNoteCaseSchema = z.object({
  id: z.string().min(1),
  origin: invented,
  plan: z.string().min(1),
  expected: z.array(
    z.object({
      cnmbCode: z.string().min(1),
      concentration: z.string().min(1).nullable(),
    }),
  ),
});

/**
 * AS-114 (D3). The Plan of an invented note —and, in some, what was said
 * aloud— and the exams «Proponer exámenes» must offer, by their code in the
 * invented catalogue (`catalogo-examenes.json`). Distractors expect nothing.
 */
export const examNoteCaseSchema = z.object({
  id: z.string().min(1),
  origin: invented,
  plan: z.string().min(1),
  conversation: z.array(z.string().min(1)).optional(),
  expected: z.array(z.string().min(1)),
});

/**
 * AS-277, SC-102. The Plan of an invented note and, per line, the medicine
 * of the CNMB and every field the receta must fill — said or deducible.
 */
export const prescriptionFieldsCaseSchema = z.object({
  id: z.string().min(1),
  origin: invented,
  plan: z.string().min(1),
  expected: z.array(
    z.object({
      cnmbCode: z.string().min(1),
      form: z.string().min(1),
      concentration: z.string().min(1),
      route: z.string().min(1),
      doseAmount: z.number().positive(),
      doseUnit: z.string().min(1),
    }),
  ),
});

/**
 * AS-277, SC-103. An invented note with a diagnosis that explains its
 * symptoms, and the categories that diagnosis may be coded in.
 */
export const symptomsCaseSchema = z.object({
  id: z.string().min(1),
  origin: invented,
  sections: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        text: z.string().min(1),
      }),
    ) // prettier-ignore
    .min(1),
  diagnosis: z.array(z.string().regex(/^[A-Z]\d{2}$/)).min(1),
});

const chartEntrySchema = z.object({
  kind: z.enum(['none', 'allergy', 'history']),
  /** A word the substance or the description holds, folded. */
  key: z.string().min(1).optional(),
  history: z.enum(['PERSONAL', 'FAMILY']).optional(),
  relative: z.string().min(1).optional(),
});

/**
 * AS-277, SC-104. An invented conversation and what it must propose for the
 * chart; `optional`, what may be proposed or not without counting as invented.
 */
export const chartCaseSchema = z.object({
  id: z.string().min(1),
  origin: invented,
  lines: z.array(z.string().min(1)).min(2),
  expected: z.array(chartEntrySchema),
  optional: z.array(chartEntrySchema).optional(),
});

const SCHEMAS = {
  cie10: cie10CaseSchema,
  prescription: prescriptionCaseSchema,
  prescriptionNote: prescriptionNoteCaseSchema,
  examNote: examNoteCaseSchema,
  note: noteCaseSchema,
  prescriptionFields: prescriptionFieldsCaseSchema,
  symptoms: symptomsCaseSchema,
  chart: chartCaseSchema,
} as const;
type Kind = keyof typeof SCHEMAS;

export type Cie10Case = z.infer<typeof cie10CaseSchema>;
export type PrescriptionCase = z.infer<typeof prescriptionCaseSchema>;
export type NoteCase = z.infer<typeof noteCaseSchema>;
export type PrescriptionNoteCase = z.infer<typeof prescriptionNoteCaseSchema>;
export type ExamNoteCase = z.infer<typeof examNoteCaseSchema>;
export type PrescriptionFieldsCase = z.infer<
  typeof prescriptionFieldsCaseSchema
>;
export type SymptomsCase = z.infer<typeof symptomsCaseSchema>;
export type ChartCase = z.infer<typeof chartCaseSchema>;
export type ChartEntry = z.infer<typeof chartEntrySchema>;

export interface CaseSet<Case> {
  file: string;
  /** EV-7. Which version of the cases a result was measured on. */
  sha256: string;
  cases: Case[];
}

const sha256 = (content: string | Buffer) =>
  createHash('sha256').update(content).digest('hex');

/** EV-1. Reads one file of cases; a case outside the rules stops everything. */
export function loadCaseFile<K extends Kind>(
  path: string,
  kind: K,
): CaseSet<z.infer<(typeof SCHEMAS)[K]>> {
  const content = readFileSync(path, 'utf8');
  const parsed = z
    .object({ cases: z.array(SCHEMAS[kind]).min(1) })
    .safeParse(JSON.parse(content));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Casos rechazados en ${path} (${issue?.path.join('.')}): ${issue?.message} — revise el origen y la forma de cada caso`,
    );
  }
  const ids = parsed.data.cases.map((c) => c.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Casos con id repetido en ${path}`);
  }
  return {
    file: path,
    sha256: sha256(content),
    cases: parsed.data.cases,
  };
}

/** The invented sets the repository versions. */
export function loadInventedCases(dir = CASES_DIR) {
  return {
    cie10: loadCaseFile(join(dir, 'cie10-propios.json'), 'cie10'),
    prescription: loadCaseFile(join(dir, 'receta.json'), 'prescription'),
    prescriptionNote: loadCaseFile(
      join(dir, 'receta-notas.json'),
      'prescriptionNote',
    ),
    examNote: loadCaseFile(join(dir, 'examenes-notas.json'), 'examNote'),
    note: loadCaseFile(join(dir, 'nota.json'), 'note'),
    /** SC-091. Consultations the draft's prompt was never tuned on. */
    noteHeldOut: loadCaseFile(join(dir, 'nota-reservada.json'), 'note'),
    /** AS-277: SC-102, SC-103 and SC-104. */
    prescriptionFields: loadCaseFile(join(dir, 'receta-campos.json'), 'prescriptionFields'), // prettier-ignore
    symptoms: loadCaseFile(join(dir, 'sintomas.json'), 'symptoms'),
    chart: loadCaseFile(join(dir, 'ficha.json'), 'chart'),
  };
}

const examCatalogueSchema = z.object({
  exams: z
    .array(
      z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        category: z.enum(['LABORATORY', 'IMAGING']),
      }),
    )
    .min(1),
});

/**
 * AS-114 (D3). The invented catalogue of a clinic the exams are offered
 * from, with its version (EV-7): no row of any database.
 */
export function loadExamCatalogue(dir = CASES_DIR) {
  const file = join(dir, 'catalogo-examenes.json');
  const content = readFileSync(file, 'utf8');
  const { exams } = examCatalogueSchema.parse(JSON.parse(content));
  if (new Set(exams.map((each) => each.code)).size !== exams.length) {
    throw new Error(`Exámenes con código repetido en ${file}`);
  }
  return {
    file,
    sha256: sha256(content),
    // In the reader's order (by name): the numbers the model sees are the
    // product's (code review of 12-10-2026, 4).
    exams: exams
      .map((exam) => ({ serviceId: exam.code, ...exam }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es') || a.code.localeCompare(b.code)), // prettier-ignore
  };
}

export interface CodiEspRow {
  article: string;
  phrase: string;
  /** As CodiEsp writes it: CIE-10-ES, lower case, with a dot (`n39.0`). */
  code: string;
}

const CODIESP_FILES = ['train/train', 'dev/dev'].map(
  (prefix) => `${prefix}_annotations_task3_processed.tsv`,
);

/**
 * EV-1. The diagnosis phrases of CodiEsp-X (task 3): an expert marked each
 * phrase of a published case report and gave it its code. Only `DIAGNOSTICO`
 * rows; procedures are another catalogue.
 */
export interface CodiEspRead {
  rows: CodiEspRow[];
  /** One digest of both files, for the result. */
  sha256: string;
  /** Each file's own digest, as `shasum -a 256` prints it. */
  files: Record<string, string>;
}

export function readCodiEsp(dir: string): CodiEspRead {
  const paths = CODIESP_FILES.map((file) => join(dir, file));
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `No es una carpeta de CodiEsp (train_dev): falta ${missing.join(', ')}`,
    );
  }
  const contents = paths.map((path) => readFileSync(path, 'utf8'));
  const rows = contents.flatMap((content) =>
    content
      .trim()
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([, label]) => label === 'DIAGNOSTICO')
      .map(([article = '', , code = '', phrase = '']) => ({
        article,
        phrase: phrase.trim(),
        code: code.trim(),
      })),
  );
  return {
    rows,
    sha256: sha256(contents.join('\n')),
    files: Object.fromEntries(
      CODIESP_FILES.map((file, i) => [file, sha256(contents[i]!)]),
    ),
  };
}

/**
 * EV-1. The two annotation files of CodiEsp train+dev (Zenodo 3837305) as the
 * author keeps them (`TESIS/PROYECTO/analisis/crudos/codiesp/train_dev`,
 * read 11-10-2026). Any other content under the same names is not CodiEsp,
 * and its phrases are not sent anywhere.
 */
export const CODIESP_SHA256: Readonly<Record<string, string>> = {
  'train/train_annotations_task3_processed.tsv':
    '569d6e165749960bbad43aa6d2271071cc736622a944087d39655776ce9b19c8',
  'dev/dev_annotations_task3_processed.tsv':
    '24f5d4f3df9dd0db09fff7dd984c0158ee7e40a6630a4187d568c000d14715d8',
};

/** EV-1. CodiEsp by its content: a folder that only has its file names stops the run. */
export function verifyCodiEsp(
  read: CodiEspRead,
  expected: Readonly<Record<string, string>> = CODIESP_SHA256,
): CodiEspRead {
  const differ = Object.entries(expected).filter(
    ([file, digest]) => read.files[file] !== digest,
  );
  if (differ.length > 0) {
    throw new Error(
      `No es el CodiEsp conocido (Zenodo 3837305): el SHA-256 de ${differ.map(([file]) => file).join(' y ')} no coincide. Sólo se envían casos inventados o de CodiEsp`,
    );
  }
  return read;
}
