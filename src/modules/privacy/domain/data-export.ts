import type { DataRequestParty } from './data-request-party';
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
      'La historia clínica vigente (atenciones, diagnósticos, notas, signos vitales, alergias, antecedentes, recetas, órdenes, resultados, certificados y referencias) no va en este archivo: se entrega como copia certificada en PDF, registrando la solicitud como copia de la historia clínica (D-083 §3, D-198). Si se corrigió algo de las atenciones, signos vitales, diagnósticos, datos de embarazo, lactancia, vacunas o suplementos, alergias, antecedentes o avisos de resultados críticos, sus versiones anteriores sí van, de las sedes donde quien genera el archivo puede abrir la historia clínica; las de los avisos, sin el nombre ni la nota de la persona avisada, y las de las vacunas, sin el grupo de riesgo (D-131.1, D-140.2, D-195, D-203 §10).',
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

/**
 * PD-056. To whom the copy is handed, as the answer says it: the holder, or
 * the third party with their name (PD-052 makes it required for a copy).
 */
function recipientOf(party: DataRequestParty, name: string | null): string {
  const named = (role: string) => (name ? `${role}, ${name}` : role);
  switch (party) {
    case 'HOLDER':
      return 'al paciente';
    case 'REPRESENTATIVE':
      return named('a su representante legal');
    case 'ATTORNEY':
      return named('a su apoderado');
    case 'AUTHORIZED_PERSON':
      return named('a la persona que autorizó');
    case 'AUTHORITY':
      return name
        ? `a la autoridad que la pide, ${name}`
        : 'a la autoridad que la pide';
    case 'DECEASED_RELATIVE':
      return named('al familiar del paciente fallecido');
  }
}

/**
 * PD-056 (D-198 §1, D-188 §3). The answer proposed for a request of the copy
 * of the clinical record: that its delivery is authorised, to whom, what the
 * copy carries (DOC-118) and what it does not —the violence screening, which
 * leaves only after a professional reviews it—. Editable, like PD-049.
 */
export function clinicalRecordCopyProposal(facts: {
  requestedBy: DataRequestParty;
  requesterName: string | null;
}): string {
  return [
    `Se autoriza la entrega de la copia certificada de la historia clínica, en PDF, ${recipientOf(facts.requestedBy, facts.requesterName)}.`,
    'Lleva cada atención con nota de consulta firmada: la nota, los signos vitales, los diagnósticos, la receta, los exámenes pedidos y los certificados.',
    'No lleva el tamizaje de violencia, que sólo se entrega después de que lo revise un profesional.',
    'Quien la recibe responde de su confidencialidad.',
  ].join('\n');
}
