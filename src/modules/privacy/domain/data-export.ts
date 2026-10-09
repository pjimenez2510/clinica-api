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
      'La historia clínica vigente (atenciones, diagnósticos, notas, signos vitales, alergias, antecedentes, recetas, órdenes, resultados, certificados y referencias) se entrega por otra vía mientras se decide su formato (D-083 §3). Si se corrigió algo de las atenciones, signos vitales, diagnósticos, datos de embarazo, lactancia o vacunas, alergias, antecedentes o avisos de resultados críticos, sus versiones anteriores sí van; las de los avisos, sin el nombre ni la nota de la persona avisada (D-131.1, D-140.2).',
  },
  {
    section: 'sexual_orientation',
    reason:
      'La orientación sexual tiene permiso propio (PA-058); no se exporta con el permiso de protección de datos (D-083 §3).',
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
    reason:
      'Las citas, pasadas y futuras, y la lista de espera no se incluyen todavía; si se movió o corrigió alguna cita o una llamada de la lista de espera, sus versiones anteriores sí van, las de las citas sin su motivo ni sus notas (D-098 §7, D-164.3).',
  },
  {
    section: 'billing',
    reason:
      'Las cuentas, cargos, facturas y notas de crédito no se incluyen todavía; si se corrigió alguna cuenta, cargo o factura, sus versiones anteriores sí van, las de las facturas sin los datos de quien las recibió (D-098 §7, D-164.3).',
  },
  {
    section: 'record_corrections',
    reason:
      'El histórico de correcciones de los datos de identificación de la ficha no se incluye todavía (D-098 §7).',
  },
  {
    section: 'access_log',
    reason:
      'Quién consultó la ficha (bitácora de accesos) no se incluye todavía (D-098 §7).',
  },
];

/** `(D-083 §3)`, `(D-098 §7, D-164.3)`: references for the file's reader. */
const DECISION_REFERENCE = /\s*\((?:[A-Z]{1,3}-\d{2,3}[^)]*)\)/g;

/** `\`versions\`` names a field of the file; a letter quotes it. */
const FIELD_NAME = /`([^`]+)`/g;

/**
 * PD-049 (D-164.2). The paragraph proposed as the answer to an access or
 * portability request: what the file leaves out and why, one line per section
 * and in the file's order, so that what the data subject was told stays in
 * the request's record (PD-033). Built from the SAME list the file carries in
 * `omitted` — never a second copy that could drift from it — without the
 * decision codes, which are the file reader's and not the data subject's.
 */
export function answerProposal(omissions: readonly ExportOmission[]): string {
  return [
    'El archivo con sus datos no lo incluye todo:',
    ...omissions.map(
      ({ reason }) =>
        `- ${reason.replace(DECISION_REFERENCE, '').replace(FIELD_NAME, '«$1»').trim()}`,
    ),
  ].join('\n');
}

/** PD-040, PD-042. Only these rights are answered with the data itself. */
export const EXPORTABLE_RIGHTS = new Set(['ACCESS', 'PORTABILITY']);
