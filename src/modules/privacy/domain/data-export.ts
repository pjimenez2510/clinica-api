import type { ExportOmission } from './privacy.repository';

/**
 * PD-041. What the export does NOT carry, said inside the document itself so
 * that nobody reading it mistakes a partial answer for a complete one.
 *
 * The first three are D-083 §3, decided by the author: the clinical record in
 * FHIR R4 in a later delivery, and the protected data only with their own
 * permission. The rest are D-098 §7, open: administrative data not exported
 * yet. Each entry is a decision, not a technical limit, and cites it.
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
      'Los contactos y el representante legal son datos de otras personas; se entregan tras decidir cómo (D-098 §7).',
  },
  {
    section: 'mother_link',
    reason:
      'El vínculo con la ficha de la madre del recién nacido es dato de otra persona; se entrega tras decidir cómo (D-098 §7).',
  },
  {
    section: 'appointments',
    reason: 'Las citas y la lista de espera no se incluyen todavía (D-098 §7).',
  },
  {
    section: 'billing',
    reason:
      'Las cuentas, facturas y notas de crédito no se incluyen todavía (D-098 §7).',
  },
  {
    section: 'record_corrections',
    reason:
      'El histórico de correcciones de la ficha no se incluye todavía (D-098 §7).',
  },
  {
    section: 'access_log',
    reason:
      'Quién consultó la ficha (bitácora de accesos) no se incluye todavía (D-098 §7).',
  },
];

/** PD-040, PD-042. Only these rights are answered with the data itself. */
export const EXPORTABLE_RIGHTS = new Set(['ACCESS', 'PORTABILITY']);
