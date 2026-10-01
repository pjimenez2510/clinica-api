import { composeForm117 } from '../../../shared/domain/form-117/form-117';

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
  contactPhone: '0990000000',
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
          sequenceNumber: 1,
          verificationCode: SAMPLE_CODE,
          warningSigns: `${SAMPLE_MARK}. Dolor de cabeza intenso.`,
          nonPharmacologicalAdvice:
            'Reduzca la sal y camine treinta minutos al día.',
          patient,
          diagnoses,
          allergies: ['Penicilina'],
          prescriber: practitioner,
          lines: [
            {
              genericName: 'Enalapril',
              presentation: 'Tableta',
              concentration: '10 mg',
              routeCode: 'ORAL',
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
          number: 1,
          verificationCode: SAMPLE_CODE,
          requestedAt: issuedAt,
          category: 'LABORATORY',
          priority: 'ROUTINE',
          clinicalNoteText: SAMPLE_MARK,
          patient,
          diagnoses,
          orderedBy: practitioner,
          items: [
            {
              code: 'MUESTRA',
              display: 'Creatinina sérica',
              specimen: 'Sangre',
              preparation: 'Ayuno de 8 horas.',
              status: 'REQUESTED',
            },
          ],
        },
      };
    case 'MEDICAL_CERTIFICATE':
      return {
        kind,
        data: {
          subjectId: 'sample',
          siteId: 'sample',
          // The same composer the issued certificate goes through: a sample
          // laid out by hand would preview a 117 nobody issues.
          form: composeForm117({
            certificate: {
              id: 'sample',
              number: 1,
              verificationCode: SAMPLE_CODE,
              type: 'ATTENDANCE',
              issuedAt,
              restFrom: null,
              restTo: null,
              includeDiagnosis: true,
              contingencyType: null,
              maternity: null,
              revokedAt: null,
              revocationReason: null,
            },
            site: {
              name: 'MUESTRA',
              mspUnicode: '000000',
              city: 'Quito',
              address: null,
              phone: null,
            },
            patient: {
              familyName: 'MUESTRA',
              secondFamilyName: null,
              givenName: 'PACIENTE',
              secondGivenName: 'Ejemplo',
              sex: 'FEMALE',
              mrn: 'MUESTRA',
              employerName: null,
              jobTitle: null,
              residenceAddressLine: null,
              phone: null,
              identifiers: [{ type: 'CEDULA', value: '1710034065' }],
            },
            encounter: {
              startedAt: issuedAt,
              endedAt: issuedAt,
              ageYears: patient.ageYears,
              ageMonths: patient.ageMonths,
              ageDays: null,
            },
            diagnoses,
            practitioner: {
              givenNames: 'MUESTRA',
              familyNames: 'PROFESIONAL Ejemplo',
              cedula: null,
              primarySpecialty: null,
              hasSeal: false,
            },
          }),
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
          // «Consumidor final»: no a person, unlike a cédula-shaped number.
          buyerIdentificationType: 'CONSUMIDOR_FINAL',
          buyerIdentification: '9999999999999',
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
