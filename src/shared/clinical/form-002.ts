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
}[] = [
  { key: 'motivoConsulta', title: 'Motivo de consulta' },
  { key: 'antecedentes', title: 'Antecedentes personales, patológicos y familiares' }, // prettier-ignore
  { key: 'enfermedadActual', title: 'Enfermedad o problema actual' },
  { key: 'revisionOrganosSistemas', title: 'Revisión de órganos y sistemas' },
  { key: 'examenFisico', title: 'Examen físico regional' },
  { key: 'planTratamiento', title: 'Plan de tratamiento' },
];
