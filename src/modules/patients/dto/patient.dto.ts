import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { explicitFlag } from '../../../shared/http/query-flag';
import {
  CORRECTABLE_PATIENT_FIELDS,
  type CorrectablePatientField,
} from '../domain/patient-corrections';
import { RDACAA_REQUIRED_FIELDS } from '../domain/rdacaa-completeness';
import {
  PRIORITY_GROUPS,
  RECORDABLE_PRIORITY_GROUPS,
  clinicalDateToday,
  type PriorityGroup,
} from '../domain/priority-groups';

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
const BLOOD_TYPE = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);
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

/**
 * El país de nacionalidad, `ISO 3166-1 alpha-3` (PA-053).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SE NORMALIZA A MAYÚSCULAS ANTES DE VALIDAR, Y NO ES COSMÉTICA.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `patient_country_of_nationality_format` exige tres letras MAYÚSCULAS, así
 * que sin normalizar aquí un `ven` perfectamente identificable llegaría a la
 * base y volvería como una violación de restricción que nadie puede leer. La
 * columna es `CHAR(3)`, que además rellena con espacios: `'ec'` se almacenaría
 * como `'ec '` y el patrón lo rechaza por partida doble.
 *
 * EL MENSAJE NO PIDE UN CÓDIGO (ADR-005 §5). En la pantalla se elige el país
 * por su nombre de la lista de `COUNTRY` y el sistema guarda el código; pedirle
 * a nadie que teclee `ECU` es justamente lo que esa regla prohíbe. Que el
 * código EXISTA lo comprueba el servicio contra el catálogo: un `CHECK` no
 * puede consultar otra tabla y `XXX` pasa este esquema.
 */
const COUNTRY_CODE = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Elija el país de la lista');

/** A required name part; `label` names the field in the Spanish messages. */
const NAME = (label: string) =>
  z
    .string({ error: `${label} es obligatorio` })
    .trim()
    .min(1, `${label} es obligatorio`)
    .max(120, `${label} no puede superar 120 caracteres`);

/**
 * Ni nacer ni morir en el futuro (PA-006, PA-008).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTA COTA NO ESTÁ EN LA BASE, Y NO HAY QUE BUSCARLA ALLÍ.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `patient_deceased_after_birth` cierra el otro extremo con un `CHECK` porque
 * compara dos COLUMNAS, y eso es inmutable. «No después de hoy» compara con
 * `now()`, que PostgreSQL declara `STABLE` y no `IMMUTABLE`: un `CHECK` con una
 * función no inmutable se rechaza al crearlo, y con razón —una fila válida al
 * insertarla dejaría de serlo mañana sin que nadie la tocara, y un `pg_dump`
 * restaurado ya no cargaría—. Así que va donde va el dígito verificador de la
 * cédula: en la validación de entrada, como error por campo, mientras la
 * persona sigue en el mostrador.
 *
 * El argumento del `CHECK` es SIMÉTRICO y sólo se había cerrado un lado: si el
 * año mal tecleado es 2016 por 2026 el fallecimiento precede al nacimiento y la
 * base lo rechaza; si es 2062 por 2026 se acepta, y como la edad se resuelve
 * contra la fecha de fallecimiento cuando la hay (PA-030), la ficha y CADA FILA
 * DEL LISTADO reportan setenta y dos años para alguien de treinta y seis,
 * congelado para siempre.
 *
 * `clinicalDateToday()` pregunta a Ecuador y no al anfitrión: a las 21:00 en
 * Guayaquil la fecha UTC ya es la de mañana, y con el huso de la sesión la
 * franja vespertina rechazaría fechas de hoy perfectamente válidas. Las dos
 * cadenas son `YYYY-MM-DD`, que ordenan cronológicamente, así que no entra
 * ningún instante en la comparación.
 */
const notInTheFuture = <T extends z.ZodType<string>>(
  schema: T,
  message: string,
) => schema.refine((value) => value <= clinicalDateToday(), { error: message });

const BIRTH_DATE = notInTheFuture(
  z.iso.date('Ingrese una fecha de nacimiento válida'),
  'La fecha de nacimiento no puede ser posterior a hoy',
);

export const createPatientSchema = z.object({
  // Ecuadorian names carry TWO surnames. A single `fullName` makes sorting and
  // ministry reporting impossible, so they are separate all the way down.
  familyName: NAME('El primer apellido'),
  secondFamilyName: z.string().trim().max(120).optional(),
  givenName: NAME('El primer nombre'),
  secondGivenName: z.string().trim().max(120).optional(),
  sex: SEX,
  /** PA-006, PA-007. Fecha de calendario, y nunca en el futuro. */
  birthDate: BIRTH_DATE,
  /**
   * An undocumented migrant arrives with an estimated age. Without this flag
   * the estimate is later reported to the ministry as a fact.
   */
  birthDateEstimated: z.boolean().default(false),
  phone: z.string().trim().max(32).optional(),
  email: z.email('Ingrese un correo electrónico válido').optional(),
  residenceAddressLine: z.string().trim().max(255).optional(),
  bloodType: BLOOD_TYPE.optional(),
  /**
   * Los seis datos del RDACAA, TODOS OPCIONALES (D-028, PA-026 a PA-029,
   * PA-056, PA-057).
   *
   * La norma los exige «en cada consulta», no al registrar, y bloquear el alta
   * a las tres de la mañana con un neonato delante es exactamente lo que
   * REQ-009 prohíbe. Lo que obliga a completarlos es el cierre de la primera
   * atención, que es de `encounter`; mientras tanto la ficha dice qué le falta
   * (`rdacaaMissingFields`, PA-032).
   */
  ethnicityConceptId: z.uuid().optional(),
  nationalityConceptId: z.uuid().optional(),
  /**
   * PA-056. El pueblo de la columna 14 del RDACAA.
   *
   * El formulario del ministerio lo activa SÓLO si la nacionalidad indígena es
   * «Kichwa», y esa condición NO está aquí: vive en el servicio, por lo mismo
   * que la de PA-027. Un `DEBERÁ` que sólo hace cumplir la capa de transporte
   * deja de cumplirse el día que otro caso de uso llame por dentro.
   */
  peopleConceptId: z.uuid().optional(),
  /**
   * PA-057, PA-058. La orientación sexual de la columna 7 del RDACAA.
   *
   * ⚠️ SE ESCRIBE CON `patient:write` Y SE LEE CON OTRO PERMISO, y la asimetría
   * es deliberada: el dato se teclea en el mostrador junto a las demás columnas
   * del formulario, así que exigir `patient:sexual-orientation` también para
   * escribirlo dejaría la columna 7 imposible de llenar para quien no tenga ese
   * permiso — y `RECEPCION`, que es quien la teclea, no lo tiene: desde el
   * 19-08-2026 lo traen `MEDICO` y `ADMIN`, y nadie más (D-039). Volver a
   * leerlo es lo que queda tras la puerta, y por eso NO está en
   * `PatientDetailDto`.
   *
   * La condición de edad —desde los 10 años— tampoco está aquí: depende de la
   * fecha de nacimiento resuelta en `America/Guayaquil`, y la resuelve el
   * servicio sobre la ficha RESULTANTE.
   */
  sexualOrientationConceptId: z.uuid().optional(),
  /** Parroquia del DPA del INEC. Provincia y cantón se derivan (PA-028). */
  residenceParishConceptId: z.uuid().optional(),
  /** PA-029: dato DISTINTO del sexo. Ninguno se deriva del otro. */
  genderIdentityConceptId: z.uuid().optional(),
  /**
   * PA-053. DE QUÉ PAÍS ES LA PERSONA, y no es `nationalityConceptId`.
   *
   * Ése es la nacionalidad o pueblo indígena del RDACAA —Kichwa, Shuar, Awa—,
   * un campo que el formulario del ministerio sólo activa si la
   * autoidentificación étnica es «Indígena». Éste es el que permite que una
   * ficha diga que un paciente es venezolano. Los dos hacen falta y no son el
   * mismo dato (D-036 opción C).
   *
   * OPCIONAL como los cuatro de arriba (D-028), y **no cuenta** para
   * `rdacaaMissingFields`: REQ-022 no lo pide.
   */
  countryOfNationalityCode: COUNTRY_CODE.optional(),
  /**
   * PA-009. La ficha de la madre.
   *
   * Es lo que permite encontrar al recién nacido antes de que tenga documento
   * propio: el listado filtra por ella (`motherId`).
   */
  motherPatientId: z.uuid().optional(),
  /**
   * OPTIONAL, and that is a clinical requirement rather than laxity. A newborn
   * twenty minutes old and an unconscious trauma case both need a chart before
   * anyone has a document for them.
   */
  identifier: identifierSchema.optional(),
});
/** Body of POST /patients. */
export class CreatePatientDto extends createZodDto(createPatientSchema) {}

/**
 * PA-015. El documento que aparece después.
 *
 * REUTILIZA `identifierSchema`, no lo copia. El dígito verificador de la cédula
 * no puede tener dos implementaciones: la segunda es la que se queda atrás el
 * día que la primera se corrige, y el síntoma sería un documento que el alta
 * rechaza y esta ruta acepta.
 */
export const addIdentifierSchema = identifierSchema;
export class AddIdentifierDto extends createZodDto(addIdentifierSchema) {}

/**
 * La corrección de una ficha (PA-031).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LOS CAMPOS SALEN DEL DOMINIO, NO SE ESCRIBEN OTRA VEZ AQUÍ.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `CORRECTABLE_PATIENT_FIELDS` es la lista, y la base la repite en
 * `patient_change_history_field_known`. Una tercera copia en la capa de
 * transporte sería la que nadie recuerda editar, y el síntoma sería un
 * formulario que ofrece un campo que la base se niega a trazar. El `satisfies`
 * de abajo hace que añadir un campo a la lista sin definirlo aquí no compile.
 *
 * AUSENTE ≠ `null`. Un campo que no se envía no se toca; enviado como `null`
 * se vacía. Colapsarlos convertiría cada campo no enviado en un borrado, que
 * sobre una ficha clínica es pérdida de datos con forma de actualización.
 *
 * EL MRN NO ESTÁ (PA-002), ni puede estar: no es un dato de la ficha, es el
 * ancla de identidad.
 */
const correctableFields = {
  familyName: NAME('El primer apellido').optional(),
  secondFamilyName: z.string().trim().max(120).nullish(),
  givenName: NAME('El primer nombre').optional(),
  secondGivenName: z.string().trim().max(120).nullish(),
  sex: SEX.optional(),
  birthDate: BIRTH_DATE.optional(),
  birthDateEstimated: z.boolean().optional(),
  /**
   * PA-008. Una FECHA, que es lo que sabe quien está en el mostrador.
   *
   * Se almacena como el instante de la medianoche en `America/Guayaquil`. La
   * respuesta la sigue devolviendo como ISO 8601, sin cambiar el contrato que
   * el listado y la ficha ya tenían.
   *
   * Y NUNCA POSTERIOR A HOY: ver `notInTheFuture` arriba, incluido el porqué de
   * que la cota no esté en la base.
   */
  deceasedAt: notInTheFuture(
    z.iso.date('Ingrese una fecha de fallecimiento válida'),
    'La fecha de fallecimiento no puede ser posterior a hoy',
  ).nullish(),
  phone: z.string().trim().max(32).nullish(),
  email: z.email('Ingrese un correo electrónico válido').nullish(),
  residenceAddressLine: z.string().trim().max(255).nullish(),
  /** PA-061. Corrected here; the registration does not ask for them. */
  employerName: z
    .string()
    .trim()
    .max(160, 'La empresa no puede superar 160 caracteres')
    .nullish(),
  jobTitle: z
    .string()
    .trim()
    .max(120, 'El puesto de trabajo no puede superar 120 caracteres')
    .nullish(),
  bloodType: BLOOD_TYPE.nullish(),
  ethnicityConceptId: z.uuid().nullish(),
  nationalityConceptId: z.uuid().nullish(),
  /** PA-056. El mismo esquema que el alta, no una copia suya. */
  peopleConceptId: z.uuid().nullish(),
  /** PA-057, PA-058. Se corrige con `patient:write`; leerla es otra ruta. */
  sexualOrientationConceptId: z.uuid().nullish(),
  residenceParishConceptId: z.uuid().nullish(),
  genderIdentityConceptId: z.uuid().nullish(),
  /** PA-053. El mismo esquema que el alta, no una copia suya. */
  countryOfNationalityCode: COUNTRY_CODE.nullish(),
  motherPatientId: z.uuid().nullish(),
} satisfies Record<CorrectablePatientField, z.ZodType>;

export const correctPatientSchema = z
  .object(correctableFields)
  .refine(
    (body) =>
      CORRECTABLE_PATIENT_FIELDS.some((field) => body[field] !== undefined),
    {
      /**
       * Un cuerpo sin ningún campo corregible es un ERROR, no un 200 que no
       * hizo nada.
       *
       * Responder 200 a una corrección que no corrigió nada hace creer al
       * mostrador que el cambio se guardó — y lo que se ve es la ficha
       * anterior, que parece un problema de caché. Sale por campo y como 422,
       * igual que cualquier otro fallo de validación.
       *
       * SIN `path`: el fallo no es de ningún campo, es del cuerpo entero, y
       * `zod-problem.ts` ya traduce una ruta vacía a `(root)`. Señalar un campo
       * cualquiera pondría el mensaje sobre un input que no tiene nada de malo.
       */
      error: 'Indique al menos un dato que corregir',
    },
  );
/** Body of PATCH /patients/:id. */
export class CorrectPatientDto extends createZodDto(correctPatientSchema) {}

export const searchPatientsSchema = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Capped so a caller cannot ask for the entire register in one request.
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  includeMerged: explicitFlag,
  /**
   * PA-009. Sólo las fichas cuya madre es ésta.
   *
   * ES LO QUE HACE QUE EL VÍNCULO SIRVA. Sin este filtro,
   * `mother_patient_id` es una columna que nadie puede recorrer, y encontrar
   * al recién nacido —que no tiene documento ni, muchas veces, nombre todavía—
   * vuelve a depender de teclear un apellido. SE COMBINA con la búsqueda por
   * texto, no la sustituye.
   */
  motherId: z.uuid().optional(),
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
/** Query of GET /patients. */
export class SearchPatientsDto extends createZodDto(searchPatientsSchema) {}

/**
 * Query of GET /patients/:id (AG-073). `agendaEntryId` names the appointment
 * the chart is opened from; the service checks it before the audit row
 * carries it.
 */
const openPatientSchema = z.object({
  agendaEntryId: z.uuid().optional(),
});
export class OpenPatientDto extends createZodDto(openPatientSchema) {}

const identifierResponseSchema = z.object({
  type: IDENTIFIER_TYPE,
  issuingCountry: z.string(),
  value: z.string(),
});

/**
 * PA-030. La edad DERIVADA, nunca almacenada.
 *
 * `days` sólo viene relleno para menores de 29 días, que es como el RDACAA
 * clasifica a un neonato. Un número de días para un adulto sería ruido que
 * alguien acabaría pintando como «29 200 días».
 *
 * `months` sólo para el lactante: de los 29 días al primer cumpleaños (D-035).
 * Sin él la ficha decía «Menos de 1 año» de un bebé de siete meses, y las
 * tablas de dosis pediátricas van por meses. Se calcula en el servidor por lo
 * mismo que los días: el navegador está en el huso del portátil.
 *
 * ⚠️ `days` Y `months` NUNCA VIENEN LOS DOS. Debajo de `years` viaja como mucho
 * una unidad, así que la pantalla no tiene nada que arbitrar: un bebé de veinte
 * días tiene cero meses cumplidos, y ofrecer las dos a la vez es invitar a
 * pintar «0 meses» donde lo que importa son los días.
 */
const ageResponseSchema = z.object({
  years: z.number().int().nonnegative(),
  months: z.number().int().nonnegative().nullable(),
  days: z.number().int().nonnegative().nullable(),
});

/** Un concepto de catálogo tal como se guardó, con su redacción de entonces. */
const conceptResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  display: z.string(),
});

/**
 * PA-053. El país de nacionalidad: el código y CÓMO SE LLAMA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SIN `id`, Y ESA AUSENCIA ES LA DIFERENCIA CON `conceptResponseSchema`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La ficha no guarda una fila del catálogo: guarda tres letras, igual que
 * `issuingCountry` de un documento. Devolver un `id` invitaría a la pantalla a
 * mandarlo de vuelta y a que un día la columna se convirtiera en una clave
 * foránea — que es justo la segunda representación del país que esta entrega
 * evita.
 *
 * `display` puede ser `null` —una edición anterior del catálogo, un país que se
 * dividió— y el CÓDIGO SIGUE VIAJANDO: un nombre que falta es una pantalla
 * peor, un código que falta es un registro peor. Mismo criterio que la
 * provincia y el cantón.
 *
 * NO VIAJA EN EL LISTADO, y esa ausencia es PA-021: la búsqueda se dispara con
 * cada letra tecleada y resolver el nombre cuesta una consulta por ficha.
 */
const countryResponseSchema = z.object({
  code: z.string(),
  display: z.string().nullable(),
});

/**
 * PA-028. La parroquia, con provincia y cantón DERIVADOS del código.
 *
 * `provinceCode` es `left(code,2)` y `cantonCode` es `left(code,4)`. No son
 * columnas y no deben serlo: dos filas del archivo del INEC declaran un cantón
 * que su propio código desmiente, así que almacenarlo reportaría a esos
 * pacientes en el cantón equivocado sin que nada fallara. Son `null` si el
 * código guardado no tiene seis dígitos, en vez de un prefijo inventado.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Y EL NOMBRE, PORQUE «Provincia 06 · Cantón 0603» NO LE DICE NADA A NADIE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El código es lo que se reporta al ministerio; el nombre es lo que se lee en
 * el mostrador. Devolver sólo el número obligaba a la pantalla a pintarlo tal
 * cual, y nadie sabe que `0603` es Guano. Se resuelve del propio catálogo DPA
 * por el código derivado —nunca por la columna descriptiva del archivo, que es
 * la que miente en dos filas—, así que sigue siendo derivar y PA-028 no cambia.
 *
 * `null` cuando el catálogo no puede decirlo: una parroquia de una edición
 * vieja cuyo cantón ya no está. El CÓDIGO sigue viajando — un nombre que falta
 * es una pantalla peor, un código que falta es un registro peor.
 */
const parishResponseSchema = conceptResponseSchema.extend({
  provinceCode: z.string().nullable(),
  provinceDisplay: z.string().nullable(),
  cantonCode: z.string().nullable(),
  cantonDisplay: z.string().nullable(),
});

/**
 * PA-032. Qué le falta a la ficha de lo que el RDACAA exige.
 *
 * Vacío significa completa. Por NOMBRE de campo y no un contador: admisión
 * tiene que poder completarlo sin adivinar cuál de los cuatro es.
 */
const rdacaaMissingFieldsSchema = z
  .array(z.enum(RDACAA_REQUIRED_FIELDS))
  .readonly();

export const patientSummarySchema = z.object({
  id: z.uuid(),
  /**
   * PA-041. The order, ALREADY CALCULATED, and never the reason.
   *
   * `1` prioritised under article 35, `2` ordinary. Two values and not ten: the
   * article does not rank the groups against each other, and a distinct number
   * per group would leak the reason through the order — which is exactly what
   * PA-042 forbids. It travels with `patient:read` because the waiting list
   * needs the order to work; the reason has its own permission and its own
   * audited route.
   */
  priority: z.number().int().positive(),
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
  age: ageResponseSchema,
  rdacaaMissingFields: rdacaaMissingFieldsSchema,
  primaryIdentifier: identifierResponseSchema.nullable(),
});

/**
 * PA-054. Qué fichas absorbió ésta, vista desde la superviviente.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA MITAD QUE LE FALTABA A PA-043: EL ENLACE SÓLO SE RECORRÍA EN UN SENTIDO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PA-043 conserva la absorbida apuntando a la superviviente y PA-045 hace que
 * abrirla lleve a la vigente. Las dos recorren el enlace de la absorbida hacia
 * la superviviente. Al revés no había nada: ni esta ficha ni el listado decían
 * que hubiera absorbido a otra, así que nadie podía SABER que había algo al
 * otro lado — y saberlo es la condición de que alguien lo siga.
 *
 * POR QUÉ EXISTE, con el caso delante (D-038, REQ-008): admisión fusiona
 * correctamente las dos fichas de una paciente; en la absorbida estaba su
 * ALERGIA A LA PENICILINA; el médico abre la ficha vigente, no ve ninguna
 * alergia, y prescribe. `linkedRecords` (PA-049) sólo lo ve quien fusiona, en
 * el acto; quien abre la ficha una semana después no fusionó nada.
 *
 * ⚠️ NO SUSTITUYE A D-038 NI A NINGUNA DE SUS TRES OPCIONES. D-031 decidió que
 * la historia no se repunta y que se lee siguiendo el enlace; D-038 decide
 * QUIÉN la lee, y las tres opciones necesitan que la superviviente sepa que
 * tiene absorbidas. Esto hace el problema visible; no lo resuelve.
 *
 * LA FORMA: los MRN acotados con el total al lado. Un contador a secas nombra
 * el problema y no da con qué ir a mirarlo; el MRN es lo que se teclea en la
 * búsqueda del registro. La lista entera tampoco sirve —veinte absorbidas
 * convierten el aviso en un muro—, así que viajan como mucho cinco y el total
 * hace que el recorte se vea.
 *
 * VACÍO, NUNCA AUSENTE NI `null`.
 */
const absorbedChartsSchema = z.object({
  /** Cuántas fichas absorbió ésta. `0` si no absorbió ninguna. */
  total: z.number().int().nonnegative(),
  /**
   * Sus números de historia, de la fusión más antigua a la más reciente y
   * acotados. NADA MÁS QUE EL NÚMERO: ni nombre, ni documento, ni fecha de
   * nacimiento de la absorbida (PA-025).
   */
  mrns: z.array(z.string()).readonly(),
});

export const patientDetailSchema = patientSummarySchema.extend({
  phone: z.string().nullable(),
  email: z.string().nullable(),
  bloodType: z.string().nullable(),
  residenceAddressLine: z.string().nullable(),
  /** PA-061, CER-038. La empresa y el puesto, `null` mientras no se corrijan. */
  employerName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  /**
   * Los conceptos elegidos, con la redacción con la que se registraron
   * (PA-026 a PA-029, PA-056).
   *
   * NO VIAJAN EN EL LISTADO, y esa ausencia es PA-021: una búsqueda se dispara
   * con cada letra tecleada, y resolver un concepto por fila para pintar una
   * lista es trabajo que nadie pidió. Lo que sí viaja allí es la edad y qué
   * falta.
   *
   * ⚠️ Y LA ORIENTACIÓN SEXUAL NO ESTÁ AQUÍ, que es la mitad visible de
   * PA-058. Es dato de categoría especial bajo la LOPDP: se lee por
   * `GET /patients/:id/sexual-orientation`, con permiso propio y su fila de
   * bitácora. Añadirla a este esquema quitaría esa puerta sin que nada fallara
   * — exactamente lo que PA-042 evita para el motivo de la prioridad.
   */
  ethnicity: conceptResponseSchema.nullable(),
  nationality: conceptResponseSchema.nullable(),
  /** PA-056. El pueblo, tercer escalón de la cadena que empieza en la etnia. */
  people: conceptResponseSchema.nullable(),
  genderIdentity: conceptResponseSchema.nullable(),
  /**
   * PA-053. El país de la persona, que NO es `nationality`.
   *
   * `nationality` es la nacionalidad o pueblo indígena del RDACAA; esto es de
   * dónde es. Viajan los dos porque son dos preguntas distintas y la clínica
   * tiene delante a diario a quien necesita cada una.
   */
  countryOfNationality: countryResponseSchema.nullable(),
  residenceParish: parishResponseSchema.nullable(),
  /** PA-009. La ficha de la madre, o `null`. */
  motherPatientId: z.uuid().nullable(),
  isProvisional: z.boolean(),
  identifiers: z.array(identifierResponseSchema).readonly(),
  /**
   * Set once a duplicate was resolved. The record is NOT deleted — printed
   * documents still quote its MRN — so the interface has to be able to say
   * "this chart moved" instead of showing a dead end.
   */
  mergedIntoMrn: z.string().nullable(),
  /**
   * PA-054. El mismo enlace leído hacia atrás.
   *
   * NO VIAJA EN EL LISTADO, y esa ausencia es PA-021: la búsqueda se dispara
   * con cada letra tecleada y ninguna fila de resultados lo necesita.
   */
  absorbedCharts: absorbedChartsSchema,
  createdAt: z.iso.datetime(),
});
/** Response of reading, registering and correcting one chart, and of adding an identifier to it. */
export class PatientDetailDto extends createZodDto(patientDetailSchema) {}

/**
 * PA-057, PA-058. La orientación sexual, por su propia puerta.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN ESQUEMA APARTE PORQUE LA RESPUESTA ES APARTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es un solo campo y aun así no viaja dentro de `PatientDetailDto`: es dato de
 * categoría especial bajo la LOPDP y su lectura exige
 * `patient:sexual-orientation`, que no basta declarar en una ruta si el dato
 * viaja también por otra. Mismo reparto que el motivo de la prioridad
 * (PA-040, PA-042): el orden viaja con la ficha, el motivo tiene su ruta.
 *
 * `null` significa «no se ha registrado», y es una respuesta legítima que
 * quien tiene el permiso puede ver: lo que la puerta protege es el valor, no
 * la existencia del campo.
 */
export const sexualOrientationSchema = z.object({
  sexualOrientation: conceptResponseSchema.nullable(),
});
/** Response of GET /patients/:id/sexual-orientation (`patient:sexual-orientation`). */
export class SexualOrientationDto extends createZodDto(
  sexualOrientationSchema,
) {}
/** What that controller returns, inferred from the schema Swagger publishes. */
export type SexualOrientationResponse = z.infer<typeof sexualOrientationSchema>;

export const patientPageSchema = z.object({
  items: z.array(patientSummarySchema).readonly(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
/** Response of GET /patients: one page of summaries and the total to paginate over. */
export class PatientPageDto extends createZodDto(patientPageSchema) {}

// ---------------------------------------------------------------------------
// Duplicate resolution (P4: PA-043 to PA-049, REQ-010)
// ---------------------------------------------------------------------------

/**
 * Por qué se unen —o se separan— dos historias (PA-044, PA-047).
 *
 * OBLIGATORIO Y NO EN BLANCO. `NOT NULL` impide la ausencia, no `'   '`, y un
 * motivo obligatorio es lo único que distingue esto de un clic. El esquema lo
 * exige aquí, `patient_merge_reason_not_blank` en la base —una importación no
 * pasa por el DTO— y `PatientMergeService` en medio, porque un `DEBERÁ` que
 * sólo hace cumplir el transporte deja de cumplirse el día que otro caso de uso
 * llame por dentro.
 *
 * El tope de 500 no lo pide la columna, que es `text`: lo pide que este texto
 * viaja al rastro de auditoría y se lee en una pantalla, no en un informe.
 */
const MERGE_REASON = z
  .string()
  .trim()
  .min(1, 'Explique por qué se unen las dos historias')
  .max(500, 'El motivo no puede pasar de 500 caracteres');

export const mergePatientSchema = z.object({
  /**
   * La ficha que queda VIGENTE. La absorbida es la de la URL, que es la que
   * cambia: recibe el enlace y deja de estar activa.
   */
  targetPatientId: z.uuid('Elija la historia que debe quedar vigente'),
  reason: MERGE_REASON,
});
/** Body of POST /patients/:id/merge, where `:id` is the chart being absorbed. */
export class MergePatientDto extends createZodDto(mergePatientSchema) {}

export const undoPatientMergeSchema = z.object({ reason: MERGE_REASON });
/** Body of POST /patients/:id/merge/undo: only the reason, which PA-047 makes mandatory as well. */
export class UndoPatientMergeDto extends createZodDto(undoPatientMergeSchema) {}

/**
 * PA-049, D-031. Qué ocurre con las citas, atenciones y documentos de la
 * absorbida: NO SE MUEVE NADA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * VIAJA EN LA RESPUESTA PARA QUE SEA COMPROBABLE, NO PARA QUE SE VEA BONITO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El esquema ya leía por el enlace antes de que nadie lo decidiera, y D-031 lo
 * hizo explícito el 16-08-2026: repuntar las filas hijas unificaría la historia
 * y haría la fusión irreversible en la práctica. Lo que faltaba era poder
 * DEMOSTRARLO desde fuera, y una garantía que nadie puede observar es un
 * comentario. La respuesta dice cuántas filas se quedaron donde estaban, y la
 * prueba comprueba las dos mitades: lo que contesta y dónde siguen las filas.
 *
 * `policy` es un literal a propósito: si algún día se repuntara, este campo
 * tendría que cambiar de valor y ninguna pantalla podría no enterarse.
 *
 * ⚠️ SON OCHO CONTADORES Y NO TRES, y eso es lo que hace que el campo sirva.
 * Con citas, atenciones y documentos, quien fusiona leía «no se movió nada» y
 * no se enteraba de que la LISTA DE ALERGIAS, los contactos, los grupos
 * prioritarios y la lista de espera se quedaban en la ficha vieja. La lista
 * completa vive en `LinkedRecordCounts`, recorrida contra el esquema.
 */
export const mergeLinkedRecordsSchema = z.object({
  policy: z.literal('READ_THROUGH_LINK'),
  /** Citas de la ficha absorbida, que siguen siendo suyas. */
  appointments: z.number().int().nonnegative(),
  encounters: z.number().int().nonnegative(),
  /** Certificados y derivaciones: los documentos que cuelgan de la ficha. */
  documents: z.number().int().nonnegative(),
  /** Alergias: las que quien prescribe consulta por ficha, no por persona. */
  allergies: z.number().int().nonnegative(),
  contacts: z.number().int().nonnegative(),
  priorityGroups: z.number().int().nonnegative(),
  waitlistEntries: z.number().int().nonnegative(),
});

export const patientMergeSchema = z.object({
  /**
   * La fila del registro de sucesos. `bigint` como CADENA: JSON no tiene
   * entero en el que se pueda confiar para uno.
   */
  mergeId: z.string(),
  event: z.enum(['MERGE', 'UNDO']),
  sourcePatientId: z.uuid(),
  /** El número de la absorbida, que documentos ya impresos siguen citando. */
  sourceMrn: z.string(),
  targetPatientId: z.uuid(),
  targetMrn: z.string(),
  performedAt: z.iso.datetime(),
  linkedRecords: mergeLinkedRecordsSchema,
});
/** Response of a merge and of its undo. */
export class PatientMergeDto extends createZodDto(patientMergeSchema) {}

// ---------------------------------------------------------------------------
// Priority groups (P3: PA-033 to PA-042, D-026, D-027)
// ---------------------------------------------------------------------------

/**
 * Qué grupos se pueden ESCRIBIR, que no son los diez.
 *
 * Sale del dominio con `satisfies` en vez de repetirse a mano: una segunda
 * lista aquí sería la que nadie recuerda editar el día que el artículo 35 se
 * lea otra vez, y el síntoma sería una pantalla que ofrece un grupo que la base
 * rechaza. Los dos derivados de la edad —«adulto mayor» y «niña, niño o
 * adolescente»— NO están, y por eso teclearlos es un error de campo y no un
 * 500: PA-035 dice que se calculan de la fecha de nacimiento.
 */
const RECORDABLE_GROUP = z.enum(
  RECORDABLE_PRIORITY_GROUPS as unknown as [PriorityGroup, ...PriorityGroup[]],
);

const PRIORITY_GROUP = z.enum(
  PRIORITY_GROUPS as unknown as [PriorityGroup, ...PriorityGroup[]],
);

const ORIGIN = z.enum(['SELF_DECLARED', 'ACCREDITED']);

export const recordPriorityGroupSchema = z.object({
  group: RECORDABLE_GROUP,
  startsOn: z.iso.date('Ingrese una fecha de inicio válida'),
  /**
   * Fecha probable de parto o de fin. OBLIGATORIA para el embarazo, y el
   * servicio lo comprueba además del esquema: PA-036 es una regla de dominio,
   * y una que sólo hace cumplir el transporte deja de cumplirse el día que
   * otro caso de uso llame por dentro.
   */
  endsOn: z.iso.date('Ingrese una fecha de fin válida').nullish(),
  origin: ORIGIN,
  /** Carné del CONADIS, certificado médico. Obligatorio si es acreditado. */
  evidenceDocument: z.string().trim().max(160).nullish(),
});
/** Body of POST /patients/:id/priority-groups. */
export class RecordPriorityGroupDto extends createZodDto(
  recordPriorityGroupSchema,
) {}

export const closePriorityGroupSchema = z.object({
  endsOn: z.iso.date('Ingrese la fecha en la que dejó de aplicar'),
});
/** Body of PATCH /patients/:id/priority-groups/:recordId: a record is closed with an end date, never deleted (PA-037). */
export class ClosePriorityGroupDto extends createZodDto(
  closePriorityGroupSchema,
) {}

export const priorityGroupSchema = z.object({
  id: z.uuid(),
  group: PRIORITY_GROUP,
  startsOn: z.iso.date(),
  endsOn: z.iso.date().nullable(),
  /**
   * Si cuenta HOY, resuelto al leer contra la fecha de `America/Guayaquil`.
   *
   * Viaja calculado para que la pantalla no vuelva a decidirlo: el navegador
   * está en el huso del portátil, y un embarazo que caducó anoche seguiría
   * pintándose como vigente hasta las 05:00.
   */
  inForce: z.boolean(),
  origin: ORIGIN,
  evidenceDocument: z.string().nullable(),
  /** PA-039: quién lo registró y cuándo, y quién lo cerró. */
  recordedById: z.uuid(),
  recordedAt: z.iso.datetime(),
  closedById: z.uuid().nullable(),
  closedAt: z.iso.datetime().nullable(),
});
/** Response of recording and closing a priority group. */
export class PriorityGroupDto extends createZodDto(priorityGroupSchema) {}

export const priorityGroupListSchema = z.object({
  /** La fecha clínica con la que se resolvió la vigencia. */
  asOf: z.iso.date(),
  items: z.array(priorityGroupSchema).readonly(),
});
/** Response of GET /patients/:id/priority-groups. */
export class PriorityGroupListDto extends createZodDto(
  priorityGroupListSchema,
) {}

/** Response types inferred from the published schemas; see agenda.dto.ts. */
export type PatientDetailResponse = z.infer<typeof patientDetailSchema>;
export type PatientPageResponse = z.infer<typeof patientPageSchema>;
export type PatientMergeResponse = z.infer<typeof patientMergeSchema>;
export type PriorityGroupResponse = z.infer<typeof priorityGroupSchema>;
export type PriorityGroupListResponse = z.infer<typeof priorityGroupListSchema>;
