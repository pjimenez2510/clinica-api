import type { DocumentKind } from './document-kind';
import type {
  DocumentSubject,
  PatientIdentity,
  PractitionerIdentity,
} from './document-source';

/**
 * DOC-038. The fictitious content a template preview is painted with.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE PREVIEW IS A REAL DOCUMENT WITH INVENTED CONTENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The preview is painted by THE SAME generator that issues: an HTML imitation
 * would be the browser printing D-095 retired, and what the administrator saw
 * would not be what comes out. So the identity — logo, name, colour, footer —
 * is the clinic's real one, and only the CONTENT is made up, and says so on
 * every line a pharmacist could mistake for a real prescription.
 *
 * Nothing here is a person: the cédula carries a computed check digit and the
 * names say «MUESTRA».
 */

/** Printed wherever a sample could be mistaken for a real document. */
export const SAMPLE_MARK = 'MUESTRA SIN VALIDEZ';

/**
 * The sample's verification code. Its QR leads to the public page, which
 * answers that no document has it — which is the truth.
 */
export const SAMPLE_CODE = 'MUESTRA';

const patient: PatientIdentity = {
  fullName: 'MUESTRA PACIENTE Ejemplo',
  identifier: '1710034065',
  ageYears: 42,
  ageMonths: 3,
};

const practitioner: PractitionerIdentity = {
  fullName: 'MUESTRA PROFESIONAL Ejemplo',
  acessRegistration: 'ACESS-0000-0000',
  mspCode: null,
  seal: null,
  signature: null,
};

const diagnoses = [
  { code: 'I10', display: 'Hipertensión esencial (primaria)' },
] as const;

/**
 * One sample subject of the given class, issued at `issuedAt` — the instant
 * comes in, as every instant in this layer does.
 */
export function sampleSubject(
  kind: DocumentKind,
  issuedAt: Date,
): DocumentSubject {
  switch (kind) {
    case 'PRESCRIPTION':
      return {
        kind,
        data: {
          subjectId: 'sample',
          siteId: 'sample',
          status: 'ACTIVE',
          issuedAt,
          city: 'Quito',
          verificationCode: SAMPLE_CODE,
          patient,
          diagnoses,
          allergies: ['Penicilina'],
          prescriber: practitioner,
          lines: [
            {
              genericName: 'Enalapril',
              presentation: 'Tableta',
              concentration: '10 mg',
              routeCode: 'PO',
              quantity: 30,
              doseText: '1 tableta',
              frequencyText: 'cada 24 horas',
              durationDays: 30,
              instructions: 'Tome 1 tableta cada mañana. No la suspenda.',
              offFormularyJustification: null,
            },
          ],
        },
      };
    case 'SERVICE_ORDER':
      return {
        kind,
        data: {
          subjectId: 'sample',
          siteId: 'sample',
          requestedAt: issuedAt,
          category: 'LABORATORY',
          priority: 'ROUTINE',
          clinicalNoteText: SAMPLE_MARK,
          patient,
          diagnoses,
          orderedBy: practitioner,
          items: [{ display: 'Creatinina sérica', status: 'REQUESTED' }],
        },
      };
    case 'MEDICAL_CERTIFICATE':
      return {
        kind,
        data: {
          subjectId: 'sample',
          siteId: 'sample',
          type: 'ATTENDANCE',
          issuedAt,
          restFrom: null,
          restTo: null,
          includeDiagnosis: true,
          diagnoses,
          body: `${SAMPLE_MARK}. Certifico que la persona fue atendida en esta fecha.`,
          verificationCode: SAMPLE_CODE,
          revokedAt: null,
          patient,
          issuedBy: practitioner,
        },
      };
    case 'INVOICE_RIDE':
      return {
        kind,
        data: {
          subjectId: 'sample',
          siteId: 'sample',
          documentNumber: '000-000-000000000',
          accessKey: null,
          status: 'DRAFT',
          issuedAt,
          authorisedAt: null,
          buyerIdentificationType: 'CEDULA',
          buyerIdentification: '1710034065',
          buyerName: SAMPLE_MARK,
          buyerEmail: null,
          lines: [
            {
              code: 'MUESTRA',
              description: 'Consulta de medicina general',
              quantity: '1',
              unitPrice: '0.00',
              discount: '0.00',
              total: '0.00',
            },
          ],
          subtotalTaxed: '0.00',
          subtotalUntaxed: '0.00',
          discountTotal: '0.00',
          taxTotal: '0.00',
          total: '0.00',
        },
      };
  }
}
