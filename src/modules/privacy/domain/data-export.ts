import type { ExportOmission } from './privacy.repository';

/**
 * PD-041. What the export does NOT carry, said inside the document itself so
 * that nobody reading it mistakes a partial answer for a complete one.
 *
 * D-083 §3, decided by the author: the administrative part now, the clinical
 * record in FHIR R4 in a later delivery, and the two protected data only with
 * their own permission. Each entry is that decision, not a technical limit.
 */
export const EXPORT_OMISSIONS: readonly ExportOmission[] = [
  {
    section: 'clinical_record',
    reason:
      'La historia clínica (atenciones, diagnósticos, notas, signos vitales, alergias, antecedentes, recetas, órdenes, resultados, certificados y referencias) se entrega por otra vía mientras se decide su formato (D-083 §3).',
  },
  {
    section: 'sexual_orientation',
    reason:
      'Tiene permiso propio (PA-058); no se exporta con el permiso de protección de datos (D-083 §3).',
  },
  {
    section: 'priority_groups',
    reason:
      'Los grupos prioritarios y su motivo tienen permiso propio (PA-042); no se exportan con el permiso de protección de datos (D-083 §3).',
  },
  {
    section: 'contacts',
    reason:
      'Los contactos y el representante legal son datos de otras personas; se entregan tras decidir cómo (D-083 §3).',
  },
  {
    section: 'appointments',
    reason: 'Las citas y la lista de espera no se incluyen todavía (D-083 §3).',
  },
  {
    section: 'billing',
    reason:
      'Las cuentas, facturas y notas de crédito no se incluyen todavía (D-083 §3).',
  },
  {
    section: 'record_corrections',
    reason:
      'El histórico de correcciones de la ficha no se incluye todavía (D-083 §3).',
  },
  {
    section: 'access_log',
    reason:
      'Quién consultó la ficha (bitácora de accesos) no se incluye todavía (D-083 §3).',
  },
];

/** PD-040, PD-042. Only these rights are answered with the data itself. */
export const EXPORTABLE_RIGHTS = new Set(['ACCESS', 'PORTABILITY']);
