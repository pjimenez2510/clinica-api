/**
 * EN-020, EN-200. The six sections of the built-in 002, by the key they are
 * stored under in `clinical_note.content` and the title the screen gives them.
 *
 * SHARED because two modules read them and no module imports another: the
 * note's own template (`encounter`, `MINIMUM_002`) and the summary of the
 * attention (`documents`, DOC-111), which prints a note signed without a
 * published template under these titles. `note-template.spec.ts` checks the
 * two lists say the same.
 */
export const FORM_002_BUILT_IN_SECTIONS: readonly {
  key: string;
  title: string;
  /** AS-088. The help the screen shows, which the draft takes as guidance. */
  help: string;
}[] = [
  { key: 'motivoConsulta', title: 'Motivo de consulta', help: 'En las palabras del paciente.' }, // prettier-ignore
  { key: 'antecedentes', title: 'Antecedentes personales, patológicos y familiares', help: 'Lo que no esté entre las alergias y los antecedentes registrados.' }, // prettier-ignore
  { key: 'enfermedadActual', title: 'Enfermedad o problema actual', help: 'Desde cuándo, cómo evolucionó, qué lo mejora o lo empeora.' }, // prettier-ignore
  { key: 'revisionOrganosSistemas', title: 'Revisión de órganos y sistemas', help: 'Lo que se preguntó, incluido lo que resultó normal.' }, // prettier-ignore
  { key: 'examenFisico', title: 'Examen físico regional', help: 'Los hallazgos de la exploración.' }, // prettier-ignore
  { key: 'planTratamiento', title: 'Plan de tratamiento', help: 'Indicaciones, control y qué hacer si empeora.' }, // prettier-ignore
];
