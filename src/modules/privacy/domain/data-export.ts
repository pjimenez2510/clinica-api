import type { ExportOmission } from './privacy.repository';

/**
 * PD-041. What the export does NOT carry, said inside the document itself so
 * that nobody reading it mistakes a partial answer for a complete one.
 *
 * ⚠️ PROVISIONAL — D-083 §3. Each entry is a decision the author has not taken
 * yet, not a technical limit.
 */
export const EXPORT_OMISSIONS: readonly ExportOmission[] = [
  {
    section: 'clinical_record',
    reason:
      'La historia clínica (atenciones, diagnósticos, notas, signos vitales, alergias y antecedentes) se entrega por otra vía mientras se decide su formato (D-083 §3).',
  },
  {
    section: 'sexual_orientation',
    reason:
      'Tiene permiso propio (PA-058); no se exporta con el permiso de protección de datos (D-083 §3).',
  },
  {
    section: 'priority_group_reasons',
    reason:
      'El motivo de prioridad tiene permiso propio (PA-042); no se exporta con el permiso de protección de datos (D-083 §3).',
  },
];

/** PD-040, PD-042. Only these rights are answered with the data itself. */
export const EXPORTABLE_RIGHTS = new Set(['ACCESS', 'PORTABILITY']);
