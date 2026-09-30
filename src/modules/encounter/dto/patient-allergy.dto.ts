import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Alergias y antecedentes visibles — REQ-008, EN-080 to EN-084.
 *
 * Responses are schemas too and not bare interfaces: `clinica-web` generates
 * its types from the OpenAPI document, and a response Swagger cannot see
 * arrives on the other side typed as `never`.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, telling the user what to do.
 */

/**
 * EN-083. Low, high, or nobody has assessed it.
 *
 * ⚠️ IT HAS NO `.default()`, AND THAT IS THE REQUIREMENT. «El valor por defecto
 * tiene que decir "no se sabe", no "es leve"» — and the way to make the system
 * never assert something nobody evaluated is to make the caller answer. §7 bis
 * of `FLUJO-DE-LA-ATENCION.md` measured what pre-filled clinical values cost:
 * of 324 safety events attributed to them, 128 — the dominant failure — were
 * simply nobody changing the value that came set.
 *
 * `UNABLE_TO_ASSESS` remains the COLUMN's default, which is the honest value
 * for a row that arrives from an import with no human in the loop.
 */
const ALLERGY_CRITICALITY = z.enum(['LOW', 'HIGH', 'UNABLE_TO_ASSESS']);

/**
 * EN-080, EN-083. Recording one allergy.
 *
 * ⚠️ IT IS STRUCTURED AND NOT PROSE, and the schema says why in its own
 * comment: «estructurada y no enterrada en el JSON del formulario 002 porque
 * prescribir tiene que comprobarla, y "comprobarla" significa una consulta, no
 * una persona leyendo prosa». Nothing about this contract can be satisfied by
 * a paragraph in the clinical note.
 */
export const recordAllergySchema = z.object({
  /**
   * EN-080. The CNMB concept, when the allergen is a drug.
   *
   * OPTIONAL BECAUSE HALF OF THEM ARE NOT DRUGS — foods, latex, insect stings
   * — and a required concept would either make those unrecordable or make
   * somebody pick a nearby wrong one. What it costs is that only the drug
   * allergies can be checked automatically against a prescription (EN-084);
   * that is the schema's own division and not a decision taken here.
   */
  substanceConceptId: z
    .uuid('Seleccione el principio activo en el catálogo CNMB')
    .optional(),
  /**
   * EN-080. The label, always — including when the concept is present.
   *
   * `substance_text` is `NOT NULL` in the schema and it is what a person reads
   * on the screen. Deriving it from the concept at read time would make an
   * allergy recorded in 2026 change its wording the day the CNMB is reloaded,
   * which is the same argument that freezes the CIE-10 code on a diagnosis
   * (EN-041).
   */
  substanceText: z
    .string()
    .trim()
    .min(1, 'Escriba a qué es alérgico el paciente')
    .max(240, 'El nombre de la sustancia no puede superar 240 caracteres'),
  /**
   * EN-080. What happened — urticaria, angioedema, anafilaxia.
   *
   * OPTIONAL: the patient who says «me hace daño la penicilina» and cannot say
   * more is the ordinary case, and refusing that record would trade a
   * life-saving datum for a tidy form.
   */
  reaction: z
    .string()
    .trim()
    .max(512, 'La descripción de la reacción no puede superar 512 caracteres')
    .optional(),
  criticality: ALLERGY_CRITICALITY,
});
/** Body of POST /patients/:patientId/allergies. */
export class RecordAllergyDto extends createZodDto(recordAllergySchema) {}

/**
 * EN-082. Ruling one out. NOT a deletion, and the contract has no route for
 * one.
 */
export const refuteAllergySchema = z.object({
  /**
   * EN-082. Why it was ruled out, and it is mandatory.
   *
   * The service demands it again, exactly as it does with the amendment's
   * reason: the DTO guards one door, and a refutation with no reason is a row
   * a future doctor cannot decide whether to trust.
   */
  notes: z
    .string()
    .trim()
    .min(1, 'Escriba por qué se descarta la alergia')
    .max(2000, 'El motivo no puede superar 2000 caracteres'),
});
/** Body of POST /patients/:patientId/allergies/:allergyId/refute. */
export class RefuteAllergyDto extends createZodDto(refuteAllergySchema) {}

/**
 * EN-081, EN-084. One allergy that has NOT been ruled out.
 *
 * ⚠️ IT IS A SCHEMA OF ITS OWN AND NOT `allergySchema` WITH TWO NULLS. This is
 * what travels beside a consultation and what a prescription check reads, and
 * every field it lacks is a field that cannot leak into either. `refutedNotes`
 * in particular is prose about a clinical judgement, and it has no business in
 * a payload whose only question is «¿a qué es alérgica esta persona hoy?».
 */
export const activeAllergySchema = z.object({
  id: z.uuid(),
  /**
   * The chart the allergy was WRITTEN ON, which after a merge may be a chart
   * the one asked about absorbed (D-031). Served so a screen can tell the two
   * apart; nothing requires it to match the id in the URL.
   */
  patientId: z.uuid(),
  substanceConceptId: z.uuid().nullable(),
  substanceText: z.string(),
  reaction: z.string().nullable(),
  criticality: ALLERGY_CRITICALITY,
  recordedAt: z.iso.datetime(),
});
/** No route returns it alone: it travels inside the attention detail and the chart summary. */
export class ActiveAllergyDto extends createZodDto(activeAllergySchema) {}

/** EN-082. The same allergy in the listing, where the refuted ones live too. */
export const allergySchema = activeAllergySchema.extend({
  /** EN-082. Present exactly when the allergy has been ruled out. */
  refutedAt: z.iso.datetime().nullable(),
  refutedNotes: z.string().nullable(),
  /** EN-086. Who recorded it and who ruled it out; `null` for older rows. */
  recordedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  refutedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
/** Response of recording and of refuting an allergy. */
export class AllergyDto extends createZodDto(allergySchema) {}

/**
 * EN-087. «Sin alergias conocidas», afirmado por un clínico.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SIN NOMBRE Y SIN FECHA, ESTA RESPUESTA NO EXISTIRÍA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El *International Patient Summary* de HL7 define `nilknown` como «una
 * afirmación positiva por parte de un usuario clínico, y no una posición por
 * defecto afirmada por un sistema informático a falta de otra información». Lo
 * que convierte esto en lo primero y no en lo segundo son estos dos campos: la
 * banda escribe «Sin alergias conocidas (Ana Villacís, 14-03-2026)», y sin
 * ellos diría «ninguna», que es el silencio de una base de datos disfrazado de
 * hallazgo clínico.
 *
 * ⚠️ EL NOMBRE VIAJA, A DIFERENCIA DE `authorId` EN LA NOTA. Es la única
 * excepción de este módulo y tiene su motivo: lo que se lee está en la banda
 * permanente de la consulta, y resolver un identificador a un nombre exigiría
 * una segunda llamada para un renglón. Del personal sale su NOMBRE y nada más
 * —ni correo, ni cédula, ni registro ACESS—, y de la persona atendida no sale
 * absolutamente nada.
 */
export const noKnownAllergiesSchema = z.object({
  /** El identificador, que es por donde la bitácora une esto con su autor. */
  assertedById: z.uuid(),
  /** Y su nombre, que es lo que se lee en la banda. */
  assertedByName: z.string(),
  assertedAt: z.iso.datetime(),
});
/** Response of POST /patients/:patientId/allergies/none-known. */
export class NoKnownAllergiesDto extends createZodDto(noKnownAllergiesSchema) {}

/**
 * EN-082, EN-087. La ficha de alergias entera: la lista y el tercer estado.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA LISTA VACÍA NO DICE «SIN ALERGIAS». DICE «NO LO SABEMOS»
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Son tres estados y la pantalla sólo podía pintar dos, porque la respuesta
 * sólo llevaba la lista:
 *
 *   - `items` con filas                    → hay alergias registradas
 *   - `items` vacío, esto presente         → «sin alergias conocidas (quién, cuándo)»
 *   - `items` vacío, esto `null`           → «no se preguntó»
 *
 * `nilknown` del *International Patient Summary* es «una afirmación positiva
 * por parte de un usuario clínico, **y no una posición por defecto afirmada por
 * un sistema informático a falta de otra información**». Sin este campo, la
 * ficha del paciente no puede distinguir «sin alergias conocidas, afirmado por
 * la Dra. X el 14-03-2026» de «nadie lo preguntó»: caía del lado seguro —«no
 * registradas»—, que es lo correcto ante la duda y sigue siéndolo, pero le
 * faltaba poder decir la verdad cuando alguien SÍ lo afirmó.
 *
 * ⚠️ EL MISMO ESQUEMA QUE SIRVE `chart-summary`, NO UNO SEGUNDO. Dos formas de
 * la misma afirmación acabarían discrepando, y en lo que discreparían es en
 * `assertedByName` — la mitad que convierte esto en la afirmación de una
 * persona en vez de en el silencio de una base de datos.
 */
export const allergyListSchema = z.object({
  items: z.array(allergySchema),
  /** EN-087. `null` es «no se preguntó», nunca «no tiene». */
  noKnownAllergies: noKnownAllergiesSchema.nullable(),
});
/** Response of GET /patients/:patientId/allergies. */
export class AllergyListDto extends createZodDto(allergyListSchema) {}

/** Response types inferred from the schemas; `ActiveAllergyResponse` is what `active-allergy.mapper.ts` returns. */
export type ActiveAllergyResponse = z.infer<typeof activeAllergySchema>;
export type NoKnownAllergiesResponse = z.infer<typeof noKnownAllergiesSchema>;
export type AllergyResponse = z.infer<typeof allergySchema>;
export type AllergyListResponse = z.infer<typeof allergyListSchema>;
