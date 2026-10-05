/**
 * EN-200 to EN-205, D-124. The consultation note as the clinic shapes it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS THE CLINIC'S AND WHAT IS THE LAW'S
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Art. 6 of the A.M. 00115-2021 fixes WHAT the note contains (EN-020); it does
 * not fix what a section is called on screen, what help it shows or in which
 * order a paediatrician writes. So the six minimum sections keep their KEY —
 * which is what `content` stores and what the signature checks — and are
 * always required, while their title, help and order are the clinic's. Any
 * further section is the clinic's entirely, and its key is minted here so a
 * renamed section never orphans what was written under it.
 *
 * PURE: the key of a new section is derived from the ones already used, not
 * drawn at random, so the same input always publishes the same template.
 */

import {
  BACKGROUND_SECTION,
  backgroundSnapshotIn,
  coversBackgroundSection,
} from './background-snapshot';
import { CLINICAL_FORMS } from './clinical-note';
import {
  NoteContentIncompleteError,
  NoteTemplateInvalidError,
  UnknownClinicalFormError,
} from './encounter.errors';

export type NoteSectionKind = 'TEXT' | 'CHOICE';

export interface NoteSection {
  /** The key inside `content`. Fixed for the minimum; `extraN` otherwise. */
  key: string;
  title: string;
  help: string;
  kind: NoteSectionKind;
  /** Only for `CHOICE`: the admitted values, in display order. */
  options: readonly string[];
  required: boolean;
  /** EN-201. One of the six of EN-020: cannot be removed nor made optional. */
  minimum: boolean;
}

/** What an administrator sends: a section without the derived flags. */
export interface NoteSectionInput {
  /** Absent for a section added now; present to keep an existing one. */
  key?: string;
  title: string;
  help: string;
  kind: NoteSectionKind;
  options?: readonly string[];
  required: boolean;
}

export interface NoteTemplate {
  /** `null` for the built-in template, which is not a row. */
  id: string | null;
  formCode: string;
  /** `null` for the clinic's own; the specialty's otherwise (D-124). */
  specialtyId: string | null;
  /** `0` for the built-in template. */
  version: number;
  sections: readonly NoteSection[];
}

/**
 * EN-020. The six prose sections of the 002, with the title and help the
 * screen showed before any clinic changed them. The order is the order of the
 * consultation: the motive is what the patient says on sitting down and the
 * plan is what is decided on standing up.
 */
const MINIMUM_002: readonly NoteSection[] = [
  {
    key: 'motivoConsulta',
    title: 'Motivo de consulta',
    help: 'En las palabras del paciente.',
  },
  {
    key: BACKGROUND_SECTION,
    title: 'Antecedentes personales, patológicos y familiares',
    // EN-207. The allergies and history recorded above are part of the note;
    // the prose is for what does not fit in them.
    help: 'Lo que no esté entre las alergias y los antecedentes registrados.',
  },
  {
    key: 'enfermedadActual',
    title: 'Enfermedad o problema actual',
    help: 'Desde cuándo, cómo evolucionó, qué lo mejora o lo empeora.',
  },
  {
    key: 'revisionOrganosSistemas',
    title: 'Revisión de órganos y sistemas',
    help: 'Lo que se preguntó, incluido lo que resultó normal.',
  },
  {
    key: 'examenFisico',
    title: 'Examen físico regional',
    help: 'Los hallazgos de la exploración.',
  },
  {
    key: 'planTratamiento',
    title: 'Plan de tratamiento',
    help: 'Indicaciones, control y qué hacer si empeora.',
  },
].map((section) => ({
  ...section,
  kind: 'TEXT' as const,
  options: [],
  required: true,
  minimum: true,
}));

export const MINIMUM_002_KEYS: readonly string[] = MINIMUM_002.map(
  (section) => section.key,
);

/** Titles for the built-in sections of the forms without a template. */
const BUILT_IN_TITLES: Readonly<
  Record<string, { title: string; help: string }>
> = {
  evolucion: {
    title: 'Evolución',
    help: 'Qué cambió desde la última nota y qué se indica.',
  },
};

/** The forms whose template a clinic may change. Only the 002. */
export const TEMPLATED_FORMS: readonly string[] = ['002'];

/**
 * EN-200. The template a form has when no version was ever published.
 *
 * The 002 has its six; any other registered form takes its mandatory
 * sections from `CLINICAL_FORMS` — the evolution note keeps one narrative and
 * no template. A form nobody registered is REFUSED, never validated as if it
 * were another.
 */
export function builtInTemplate(formCode: string): NoteTemplate {
  if (formCode === '002') {
    return { id: null, formCode, specialtyId: null, version: 0, sections: MINIMUM_002 }; // prettier-ignore
  }
  const form = CLINICAL_FORMS.find((each) => each.code === formCode);
  if (!form) {
    throw new UnknownClinicalFormError(
      CLINICAL_FORMS.map((known) => `${known.code}@${known.version}`),
    );
  }
  return {
    id: null,
    formCode,
    specialtyId: null,
    version: 0,
    sections: form.mandatorySections.map((key) => ({
      key,
      title: BUILT_IN_TITLES[key]?.title ?? key,
      help: BUILT_IN_TITLES[key]?.help ?? '',
      kind: 'TEXT' as const,
      options: [],
      required: true,
      minimum: true,
    })),
  };
}

const MAX_SECTIONS = 30;
const MAX_TITLE = 80;
const MAX_HELP = 300;
const MAX_OPTIONS = 20;
const MAX_OPTION = 80;
const OWN_KEY = /^extra([1-9][0-9]{0,3})$/;

/** `extra7` → 7; anything else → 0. */
export const ownKeyIndex = (key: string | undefined): number =>
  Number(OWN_KEY.exec(key ?? '')?.[1] ?? 0);

const normalised = (text: string) => text.trim().toLocaleLowerCase('es');

/**
 * EN-201, EN-202. The sections of a version about to be published, or a
 * refusal naming what is wrong. The order of the input is the order of the
 * note.
 */
export function publishableSections(
  formCode: string,
  input: readonly NoteSectionInput[],
  /**
   * EN-202. The highest `extraN` ANY version of this template ever used: a
   * removed section's key is never handed to a new one, or `content.extra2`
   * would mean two things in two notes.
   */
  highestOwnKeyEverUsed = 0,
): NoteSection[] {
  if (!TEMPLATED_FORMS.includes(formCode)) {
    throw new NoteTemplateInvalidError(
      'formCode',
      'Este formulario no tiene plantilla configurable',
    );
  }
  if (input.length > MAX_SECTIONS) {
    throw new NoteTemplateInvalidError(
      'sections',
      `La nota admite como máximo ${MAX_SECTIONS} secciones`,
    );
  }

  const minimumByKey = new Map(MINIMUM_002.map((s) => [s.key, s]));
  const seenKeys = new Set<string>();
  const seenTitles = new Set<string>();
  let nextOwn =
    Math.max(highestOwnKeyEverUsed, ...input.map((s) => ownKeyIndex(s.key))) +
    1;

  const sections = input.map((raw, index): NoteSection => {
    const field = `sections.${index}`;
    const title = raw.title.trim();
    const help = raw.help.trim();
    const minimum = raw.key ? minimumByKey.get(raw.key) : undefined;

    if (raw.key && !minimum && !OWN_KEY.test(raw.key)) {
      throw new NoteTemplateInvalidError(`${field}.key`, 'Sección desconocida');
    }
    const key = raw.key ?? `extra${nextOwn++}`;
    if (seenKeys.has(key)) {
      throw new NoteTemplateInvalidError(
        `${field}.key`,
        `La sección «${minimum?.title ?? title}» está repetida`,
      );
    }
    seenKeys.add(key);

    if (title === '' || title.length > MAX_TITLE) {
      throw new NoteTemplateInvalidError(
        `${field}.title`,
        `El título es obligatorio y admite hasta ${MAX_TITLE} caracteres`,
      );
    }
    if (seenTitles.has(normalised(title))) {
      throw new NoteTemplateInvalidError(
        `${field}.title`,
        `Ya hay una sección llamada «${title}»`,
      );
    }
    seenTitles.add(normalised(title));
    if (help.length > MAX_HELP) {
      throw new NoteTemplateInvalidError(
        `${field}.help`,
        `La ayuda admite hasta ${MAX_HELP} caracteres`,
      );
    }

    if (minimum && (raw.kind !== 'TEXT' || !raw.required)) {
      throw new NoteTemplateInvalidError(
        `${field}.required`,
        `«${minimum.title}» es parte del contenido mínimo de la nota: es texto y obligatoria`,
      );
    }

    const options =
      raw.kind === 'CHOICE' ? choiceOptions(field, raw.options ?? []) : [];

    return {
      key,
      title,
      help,
      kind: raw.kind,
      options,
      required: raw.required,
      minimum: Boolean(minimum),
    };
  });

  const absent = MINIMUM_002.find((section) => !seenKeys.has(section.key));
  if (absent) {
    throw new NoteTemplateInvalidError(
      'sections',
      `Falta «${absent.title}»: es parte del contenido mínimo de la nota y no se puede quitar`,
    );
  }

  return sections;
}

function choiceOptions(field: string, raw: readonly string[]): string[] {
  const options = raw.map((option) => option.trim());
  const distinct = new Set(options.map(normalised));
  if (
    options.length < 2 ||
    options.length > MAX_OPTIONS ||
    distinct.size !== options.length ||
    options.some((option) => option === '' || option.length > MAX_OPTION)
  ) {
    throw new NoteTemplateInvalidError(
      `${field}.options`,
      `Una lista lleva de 2 a ${MAX_OPTIONS} opciones distintas, de hasta ${MAX_OPTION} caracteres`,
    );
  }
  return options;
}

/**
 * EN-205, EN-207. Every required section of the note's own template written,
 * and every list holding one of its options.
 *
 * WHITESPACE IS NOT CONTENT. And «antecedentes» counts as written when the
 * background snapshot already holds an allergy or a history entry (D-125).
 */
export function assertNoteComplete(
  template: Pick<NoteTemplate, 'sections' | 'formCode'>,
  content: Readonly<Record<string, unknown>>,
): void {
  const background = backgroundSnapshotIn(content);
  const missing: string[] = [];
  const invalid: string[] = [];

  /**
   * EN-201. The minimum of the 002 is demanded EVEN IF the stored template
   * lacks one of its sections — a row written outside `publish`, or a
   * minimum that grows after a template was published. The template decides
   * titles and order; art. 6 decides what cannot be missing.
   */
  const declared = new Set(template.sections.map((section) => section.key));
  const minimumNotDeclared =
    template.formCode === '002'
      ? MINIMUM_002.filter((section) => !declared.has(section.key))
      : [];

  for (const section of [...template.sections, ...minimumNotDeclared]) {
    const value = content[section.key];
    const text = typeof value === 'string' ? value.trim() : '';

    if (text === '') {
      const covered =
        section.key === BACKGROUND_SECTION &&
        coversBackgroundSection(background);
      if (section.required && !covered) missing.push(section.key);
      continue;
    }
    if (section.kind === 'CHOICE' && !section.options.includes(text)) {
      invalid.push(section.key);
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    throw new NoteContentIncompleteError(missing, invalid);
  }
}
