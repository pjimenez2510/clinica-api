/**
 * EN-104, EN-243. The sections of the forms an ACT writes —the 053 of a
 * referral, the 007 of an interconsultation—, by the key they are stored under
 * in `clinical_note.content` and the title the screen and the paper give them,
 * in the order of the paper.
 *
 * SHARED because two modules read them and no module imports another: the
 * note's built-in template (`encounter`) and the PDF of the form
 * (`documents`). One list, so the screen and the paper cannot drift.
 */
export interface ActFormSection {
  key: string;
  title: string;
}

/** Form 053: referral, derivation, counter-referral and reverse referral. */
export const FORM_053_SECTIONS: readonly ActFormSection[] = [
  { key: 'tipo', title: 'Tipo' },
  { key: 'establecimientoDestino', title: 'Establecimiento de destino' },
  { key: 'especialidad', title: 'Especialidad' },
  { key: 'prioridad', title: 'Prioridad' },
  { key: 'motivo', title: 'Motivo' },
  { key: 'resumen', title: 'Resumen del cuadro clínico' },
  { key: 'diagnosticos', title: 'Diagnósticos' },
  { key: 'respondeA', title: 'Responde a' },
];

/** Form 007: the interconsultation requested. */
export const FORM_007_SECTIONS: readonly ActFormSection[] = [
  { key: 'tipo', title: 'Tipo' },
  { key: 'especialidad', title: 'Especialidad' },
  { key: 'motivo', title: 'Motivo' },
  { key: 'cuadroClinico', title: 'Cuadro clínico y pregunta' },
  { key: 'diagnosticos', title: 'Diagnósticos' },
];

/** The sections of an act's form, by its code; `null` for any other form. */
export function actFormSections(
  formCode: string,
): readonly ActFormSection[] | null {
  if (formCode === '053') return FORM_053_SECTIONS;
  if (formCode === '007') return FORM_007_SECTIONS;
  return null;
}
