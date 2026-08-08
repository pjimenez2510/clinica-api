import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The patient contract, requests and responses.
 *
 * Responses are schemas too, not bare interfaces: the OpenAPI document is what
 * `clinica-web` generates its types from, and a response Swagger cannot see
 * arrives on the other side typed as `never`.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, addressing the user as "usted".
 */

const SEX = z.enum(['MALE', 'FEMALE', 'INTERSEX', 'UNKNOWN']);
const IDENTIFIER_TYPE = z.enum([
  'CEDULA',
  'PASSPORT',
  'REFUGEE_CARD',
  'FOREIGN_ID',
  'PROVISIONAL',
]);

/**
 * Ecuadorian cedula check digit, modulus 10.
 *
 * Validated HERE as well as in the database. The database constraint is the
 * guarantee — it is what stops a bad row arriving through an import or a
 * migration — but a receptionist deserves to be told which digit is wrong
 * while the person is still standing at the desk, not after a 500.
 */
function hasValidCedulaCheckDigit(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;

  const province = Number(value.slice(0, 2));
  // 01–24 are the provinces; 30 is used for citizens registered abroad.
  if (province < 1 || (province > 24 && province !== 30)) return false;

  /**
   * THE THIRD DIGIT IS 0–5 FOR A PERSON.
   *
   * Six or more identifies a RUC — a public body or a company — which is not
   * something a patient has. This rule was missing here while the database
   * enforced it, so a RUC passed validation and came back as a raw constraint
   * violation the receptionist could not act on.
   */
  if (Number(value[2]) >= 6) return false;

  const digits = [...value].map(Number);
  const total = digits.slice(0, 9).reduce((sum, digit, index) => {
    if (index % 2 !== 0) return sum + digit;
    const doubled = digit * 2;
    return sum + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);

  const check = (10 - (total % 10)) % 10;
  return check === digits[9];
}

const identifierSchema = z
  .object({
    type: IDENTIFIER_TYPE,
    /** ISO 3166-1 alpha-3. Two passports may share a number across countries. */
    issuingCountry: z
      .string()
      .length(3, 'El país emisor debe tener 3 letras')
      .toUpperCase()
      .default('ECU'),
    value: z
      .string({ error: 'El número de documento es obligatorio' })
      .trim()
      .min(1, 'El número de documento es obligatorio')
      .max(32, 'El número de documento no puede superar 32 caracteres'),
  })
  .refine(
    (identifier) =>
      identifier.type !== 'CEDULA' ||
      identifier.issuingCountry !== 'ECU' ||
      hasValidCedulaCheckDigit(identifier.value),
    {
      // Only Ecuadorian cedulas carry this check digit. Applying it to a
      // Colombian document would reject a valid one.
      error: 'La cédula ingresada no es válida',
      path: ['value'],
    },
  );

const NAME = (label: string) =>
  z
    .string({ error: `${label} es obligatorio` })
    .trim()
    .min(1, `${label} es obligatorio`)
    .max(120, `${label} no puede superar 120 caracteres`);

export const createPatientSchema = z.object({
  // Ecuadorian names carry TWO surnames. A single `fullName` makes sorting and
  // ministry reporting impossible, so they are separate all the way down.
  familyName: NAME('El primer apellido'),
  secondFamilyName: z.string().trim().max(120).optional(),
  givenName: NAME('El primer nombre'),
  secondGivenName: z.string().trim().max(120).optional(),
  sex: SEX,
  birthDate: z.iso.date('Ingrese una fecha de nacimiento válida'),
  /**
   * An undocumented migrant arrives with an estimated age. Without this flag
   * the estimate is later reported to the ministry as a fact.
   */
  birthDateEstimated: z.boolean().default(false),
  phone: z.string().trim().max(32).optional(),
  email: z.email('Ingrese un correo electrónico válido').optional(),
  residenceAddressLine: z.string().trim().max(255).optional(),
  bloodType: z
    .enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])
    .optional(),
  /**
   * OPTIONAL, and that is a clinical requirement rather than laxity. A newborn
   * twenty minutes old and an unconscious trauma case both need a chart before
   * anyone has a document for them.
   */
  identifier: identifierSchema.optional(),
});
export class CreatePatientDto extends createZodDto(createPatientSchema) {}

export const searchPatientsSchema = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Capped so a caller cannot ask for the entire register in one request.
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  includeMerged: z.coerce.boolean().default(false),
  /**
   * Ordenación, como lista cerrada y no como nombre de columna.
   *
   * El valor acaba en un ORDER BY, donde PostgreSQL no admite parámetros, así
   * que aceptar texto libre sería una inyección. Además obliga a decidir qué
   * es ordenable, que es una decisión de producto: ordenar por teléfono no
   * significa nada para nadie.
   */
  sortBy: z.enum(['name', 'mrn', 'birthDate']).default('name'),
  sortDirection: z.enum(['asc', 'desc']).default('asc'),
});
export class SearchPatientsDto extends createZodDto(searchPatientsSchema) {}

const identifierResponseSchema = z.object({
  type: IDENTIFIER_TYPE,
  issuingCountry: z.string(),
  value: z.string(),
});

export const patientSummarySchema = z.object({
  id: z.uuid(),
  /** The number humans quote. Printed monospaced, read digit by digit. */
  mrn: z.string(),
  familyName: z.string(),
  secondFamilyName: z.string().nullable(),
  givenName: z.string(),
  secondGivenName: z.string().nullable(),
  sex: SEX,
  birthDate: z.iso.date(),
  birthDateEstimated: z.boolean(),
  deceasedAt: z.iso.datetime().nullable(),
  primaryIdentifier: identifierResponseSchema.nullable(),
});

export const patientDetailSchema = patientSummarySchema.extend({
  phone: z.string().nullable(),
  email: z.string().nullable(),
  bloodType: z.string().nullable(),
  residenceAddressLine: z.string().nullable(),
  isProvisional: z.boolean(),
  identifiers: z.array(identifierResponseSchema),
  /**
   * Set once a duplicate was resolved. The record is NOT deleted — printed
   * documents still quote its MRN — so the interface has to be able to say
   * "this chart moved" instead of showing a dead end.
   */
  mergedIntoMrn: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export class PatientDetailDto extends createZodDto(patientDetailSchema) {}

export const patientPageSchema = z.object({
  items: z.array(patientSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export class PatientPageDto extends createZodDto(patientPageSchema) {}
