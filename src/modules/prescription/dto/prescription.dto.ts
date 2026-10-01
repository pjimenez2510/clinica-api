import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  MEDICATION_ROUTE_CODES,
  MEDICATION_ROUTES,
} from '../domain/prescription';
import { MAX_SPELLABLE_QUANTITY } from '../../../shared/domain/quantity-in-words';

/**
 * The prescription's contract — art. 5 of the Resolución ACESS-2023-0030.
 *
 * Responses are schemas too and not bare interfaces: `clinica-web` generates
 * its types from the OpenAPI document, and a response Swagger cannot see
 * arrives on the other side typed as `never`.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, telling the user what to do.
 *
 * ⚠️ THE MANDATORY FIELDS OF ART. 5.c ARE DEMANDED HERE **AND** AT THE ISSUE,
 * and that is the pattern `AMENDMENT_REASON_REQUIRED` already follows: the
 * transport says it politely with the box named, the service guarantees it for
 * every caller including the ones that never come through HTTP, and the
 * database says it a third time where it can. A rule only the transport
 * enforces stops being true the first time an import writes a row.
 */

const routeCodes = MEDICATION_ROUTE_CODES as [string, ...string[]];

const ROUTE = z.enum(routeCodes, {
  error: `Elija la vía de administración: ${Object.values(MEDICATION_ROUTES).join(', ')}`, // prettier-ignore
});

const PRESCRIPTION_STATUS = z.enum([
  'DRAFT',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
  // Un borrador que se tecleó mal y se cerró antes de salir de la consulta.
  // No es `CANCELLED`: anular una receta emitida tiene peso legal —hay papel
  // en la mano de alguien— y descartar un borrador es limpieza.
  'DISCARDED',
]);

/**
 * PR-007 to PR-009, PR-028 to PR-031. One line of the prescription.
 *
 * ⚠️ THERE IS NO `genericName` WHEN THERE IS A CONCEPT, AND THAT IS PR-008. The
 * DCI is copied from the CNMB concept inside the write's own transaction,
 * because a name typed by hand produces «Amoxicilina», «amoxicilina 500» and
 * «AMOXICILINA» as three medicines — and because the copy is what an archived
 * prescription still says when the catalogue has been reloaded.
 */
const prescriptionItemSchema = z
  .object({
    /** PR-007. A CNMB concept, or absent to prescribe outside the cuadro. */
    conceptId: z.uuid('Seleccione el medicamento en el CNMB').optional(),
    /**
     * PR-009. Only when prescribing outside the CNMB. With a concept it is
     * refused, so nobody can send a name that contradicts the one stored.
     */
    genericName: z
      .string()
      .trim()
      .min(3, 'Escriba el nombre genérico del medicamento')
      .max(240, 'El nombre genérico no puede superar 240 caracteres')
      .optional(),
    /** PR-029. Art. 5.c.ii — forma farmacéutica. */
    presentation: z
      .string()
      .trim()
      .min(1, 'Indique la forma farmacéutica')
      .max(160, 'La forma farmacéutica no puede superar 160 caracteres'),
    /** PR-029. Art. 5.c.iii — concentración del principio activo. */
    concentration: z
      .string()
      .trim()
      .min(1, 'Indique la concentración')
      .max(80, 'La concentración no puede superar 80 caracteres'),
    /** PR-029. Art. 5.c.iv — a code, never «VO»: art. 13 forbids abbreviations. */
    routeCode: ROUTE,
    /**
     * PR-030. Art. 5.c.v — the figure. The words are DERIVED from it and never
     * sent: two boxes somebody fills in are two boxes that can disagree, and
     * the one that decides in an inspection is the one that grants less.
     */
    quantity: z
      .number()
      .positive('La cantidad tiene que ser mayor que cero')
      .max(
        MAX_SPELLABLE_QUANTITY,
        'Esa cantidad es demasiado alta para una receta',
      ),
    /** PR-031. Art. 5.c.vi — dosis/posología. */
    doseText: z
      .string()
      .trim()
      .min(1, 'Indique la dosis')
      .max(160, 'La dosis no puede superar 160 caracteres'),
    /** PR-031. Art. 5.c.vi — frecuencia de la administración. */
    frequencyText: z
      .string()
      .trim()
      .min(1, 'Indique cada cuánto se toma')
      .max(160, 'La frecuencia no puede superar 160 caracteres'),
    /** PR-031. Art. 5.c.vi — duración del tratamiento, en días. */
    durationDays: z
      .number()
      .int('La duración se indica en días enteros')
      .min(1, 'La duración tiene que ser de al menos un día')
      .max(365, 'Una receta no puede durar más de un año'),
    /** PR-037. Art. 5.e.iii — indicaciones de esta línea, sin abreviaturas. */
    instructions: z
      .string()
      .trim()
      .max(2000, 'Las indicaciones no pueden superar 2000 caracteres')
      .optional(),
    /** PR-009. Obligatoria exactamente cuando no hay concepto del CNMB. */
    offFormularyJustification: z
      .string()
      .trim()
      .min(10, 'Explique por qué se receta fuera del CNMB')
      .max(2000, 'La justificación no puede superar 2000 caracteres')
      .optional(),
  })
  .check((ctx) => {
    const item = ctx.value;
    if (item.conceptId === undefined && item.genericName === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: item,
        path: ['genericName'],
        message:
          'Elija el medicamento en el CNMB, o escriba su nombre genérico y justifique la prescripción fuera del cuadro',
      });
    }
    if (
      item.conceptId === undefined &&
      item.offFormularyJustification === undefined
    ) {
      // prettier-ignore
      ctx.issues.push({
        code: 'custom',
        input: item,
        path: ['offFormularyJustification'],
        message: 'Escriba por qué se receta fuera del CNMB',
      });
    }
    /**
     * PR-008. A name sent ALONGSIDE a concept is refused rather than ignored.
     * Dropping it silently would leave the caller believing the name they typed
     * is the one on the prescription, and the day the two differ the screen and
     * the archived document disagree about which medicine was prescribed. It is
     * the argument `BMI_IS_DERIVED` already makes for a computed value.
     */
    if (item.conceptId !== undefined && item.genericName !== undefined) {
      ctx.issues.push({
        code: 'custom',
        input: item,
        path: ['genericName'],
        message:
          'El nombre genérico lo toma el sistema del CNMB: no lo escriba cuando elige el medicamento del cuadro',
      });
    }
  });

/**
 * PR-001, PR-005. Composing a prescription: the whole document, in one request.
 *
 * ⚠️ THE LINES TRAVEL WITH IT AND THERE IS NO ROUTE TO ADD ONE (PR-005). A
 * prescription is written in one go — the doctor has it whole in their head
 * before typing — and a «añadir línea» route opens a window in which a
 * half-written prescription exists and somebody can issue it.
 */
/** Optional free text: trimmed, and blank travels as absent. */
const indicationText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .transform((value) => (value === '' ? undefined : value))
    .optional();

export const composePrescriptionSchema = z.object({
  /**
   * PR-038 (art. 5.e.iv). Optional while composing, like every other field of
   * art. 5: the issue is where the norm applies and where it is demanded.
   */
  warningSigns: indicationText(
    2000,
    'Los signos de alarma no pueden superar 2000 caracteres',
  ),
  /** PR-039 (art. 5.e.v). Same rule. */
  nonPharmacologicalAdvice: indicationText(
    2000,
    'Las recomendaciones no pueden superar 2000 caracteres',
  ),
  items: z
    .array(prescriptionItemSchema)
    .min(1, 'Una receta lleva al menos un medicamento')
    .max(20, 'Una receta no puede llevar más de 20 medicamentos'),
});
/** Body of POST /encounters/:encounterId/prescriptions. */
export class ComposePrescriptionDto extends createZodDto(
  composePrescriptionSchema,
) {}

/**
 * PR-011. Discarding a draft: the motivo, and nothing else.
 *
 * ⚠️ THE REASON IS OBLIGATORY, AND IT IS OBLIGATORY BECAUSE IT IS STORED.
 * `prescription.discard_reason` exists and
 * `prescription_discard_states_who_when_and_why` refuses a discarded row
 * without it, so what is typed here is kept. That is the exact difference with
 * the annulment, which asks for nothing precisely because there is no column
 * (⚠️ **Falta esquema**, PR-010): a mandatory reason dropped on the floor makes
 * everybody believe there is a register.
 *
 * ⚠️ AND THERE IS NO `discardedById` FIELD. Who discarded it is the
 * authenticated session, never an id the caller supplies — the same rule
 * PR-004 applies to the prescriber.
 */
export const discardPrescriptionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Escriba por qué se descarta este borrador')
    // 500 is `discard_reason`'s own width: refusing here names the box, while
    // letting it through would refuse the row with a constraint name instead.
    .max(500, 'El motivo no puede superar 500 caracteres'),
});
/** Body of POST /prescriptions/:prescriptionId/discard. */
export class DiscardPrescriptionDto extends createZodDto(
  discardPrescriptionSchema,
) {}

/** One line as a client reads it. */
export const prescriptionItemViewSchema = z.object({
  id: z.uuid(),
  /** The 1-based address every error message uses (PR-032). */
  line: z.number().int(),
  conceptId: z.uuid().nullable(),
  /** PR-008, PR-028. The DCI, frozen from the CNMB. */
  genericName: z.string(),
  presentation: z.string().nullable(),
  concentration: z.string().nullable(),
  routeCode: z.string().nullable(),
  quantity: z.number().nullable(),
  doseText: z.string(),
  frequencyText: z.string(),
  durationDays: z.number().int().nullable(),
  instructions: z.string().nullable(),
  offFormularyJustification: z.string().nullable(),
});

/**
 * A prescription as a client reads it on the write path.
 *
 * ⚠️ NO PATIENT AND NO DIAGNOSIS. Those travel only in the document, which is
 * the one audited read of this module (PR-092).
 */
export const prescriptionSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  prescriberId: z.uuid(),
  status: PRESCRIPTION_STATUS,
  issuedAt: z.iso.datetime().nullable(),
  /** PR-020. The pharmacy's check code, NOT the sequential number of art. 5.a.i. */
  verificationCode: z.string().nullable(),
  /** PR-020. Art. 5.a.i — consecutive per site; `null` until issued. */
  sequenceNumber: z.number().int().positive().nullable(),
  /** PR-038. Art. 5.e.iv. */
  warningSigns: z.string().nullable(),
  /** PR-039. Art. 5.e.v. */
  nonPharmacologicalAdvice: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /**
   * PR-011. When the draft was discarded, and why. `null` on every other state.
   *
   * ⚠️ THE REASON IS SERVED BECAUSE IT IS STORED. A register nobody can read is
   * not a register, and the next doctor opening the chart is exactly who has to
   * be able to tell a mistyped draft from medication that was stopped.
   */
  discardedAt: z.iso.datetime().nullable(),
  discardReason: z.string().nullable(),
  items: z.array(prescriptionItemViewSchema),
});
/** Response of issuing, discarding and annulling a prescription. */
export class PrescriptionDto extends createZodDto(prescriptionSchema) {}

export const prescriptionListSchema = z.object({
  items: z.array(prescriptionSchema),
});
/** Response of GET /encounters/:encounterId/prescriptions. */
export class PrescriptionListDto extends createZodDto(prescriptionListSchema) {}

/**
 * PR-067. What comes back from composing.
 *
 * ⚠️ THE ALERT CARRIES NO MEDICINE NAME AND NO ALLERGEN (PR-094). A drug name
 * IS a diagnosis said differently, and this response reaches logs and support
 * screenshots. The line number addresses the box; the allergy identifier lets
 * the screen open the chart entry.
 */
export const allergyAlertSchema = z.object({
  line: z.number().int(),
  allergyId: z.uuid(),
  match: z.literal('EXACT'),
});

export const composedPrescriptionSchema = z.object({
  prescription: prescriptionSchema,
  /** PR-067. Informative here; the same coincidence refuses the ISSUE. */
  allergyAlerts: z.array(allergyAlertSchema),
});
/** Response of POST /encounters/:encounterId/prescriptions. */
export class ComposedPrescriptionDto extends createZodDto(
  composedPrescriptionSchema,
) {}

/** PR-020 to PR-053. The prescription as art. 5 obliges it to be emitted. */
export const prescriptionDocumentSchema = z.object({
  id: z.uuid(),
  verificationCode: z.string().nullable(),
  /** PR-020. Art. 5.a.i — `null` on a draft. */
  sequenceNumber: z.number().int().positive().nullable(),
  /** PR-038. Art. 5.e.iv. */
  warningSigns: z.string().nullable(),
  /** PR-039. Art. 5.e.v. */
  nonPharmacologicalAdvice: z.string().nullable(),
  status: PRESCRIPTION_STATUS,
  /** PR-021. Art. 5.a.ii — the client renders it as DD/MM/AAAA. */
  issuedAt: z.iso.datetime().nullable(),
  /** PR-021. Art. 5.a.ii — the canton of the site's parish. */
  city: z.string().nullable(),
  /** PR-022. Art. 5.a.iii. */
  establishment: z.object({ name: z.string(), mspUnicode: z.string() }),
  /** PR-023, PR-050. `null` on a draft: nothing is dispensable yet. */
  validity: z
    .object({ days: z.number().int(), through: z.string() })
    .nullable(),
  patient: z.object({
    /** PR-024. «Apellidos y nombres completos», in that order. */
    fullName: z.string(),
    /** PR-025. Months are present exactly under five years. */
    age: z
      .object({
        years: z.number().int(),
        months: z.number().int().nullable(),
        text: z.string(),
      })
      .nullable(),
  }),
  /** PR-026. Art. 5.b.iii — the CIE of the attention, principal first. */
  diagnoses: z.array(z.object({ code: z.string(), display: z.string() })),
  /** PR-027. Art. 5.b.iv — «Antecedentes de alergias». */
  allergies: z.array(z.string()),
  prescriber: z.object({
    fullName: z.string(),
    /** PR-034. Art. 5.d.ii — printed on the document. */
    acessRegistration: z.string().nullable(),
    /** PR-040. Art. 5.e.vi — the permanent contact number. */
    contactPhone: z.string().nullable(),
    /** PR-035. There is no drawn signature, and there never will be. */
    signedAt: z.iso.datetime().nullable(),
  }),
  items: z.array(
    z.object({
      line: z.number().int(),
      genericName: z.string(),
      presentation: z.string().nullable(),
      concentration: z.string().nullable(),
      /** PR-029. Spelled out — «Vía oral», never «VO». */
      route: z.string().nullable(),
      quantity: z.number().nullable(),
      /** PR-030. Art. 5.c.v — derived from the figure, never typed. */
      quantityInWords: z.string().nullable(),
      doseText: z.string(),
      frequencyText: z.string(),
      durationDays: z.number().int().nullable(),
      instructions: z.string().nullable(),
      /** PR-037. Composed from the fields, never typed: no abbreviation. */
      indications: z.string(),
      offFormularyJustification: z.string().nullable(),
    }),
  ),
});
/** Response of GET /prescriptions/:prescriptionId, the audited read (PR-092). */
export class PrescriptionDocumentDto extends createZodDto(
  prescriptionDocumentSchema,
) {}

/** Response types the controllers return, inferred from the schemas Swagger publishes. */
export type PrescriptionResponse = z.infer<typeof prescriptionSchema>;
export type PrescriptionListResponse = z.infer<typeof prescriptionListSchema>;
export type ComposedPrescriptionResponse = z.infer<
  typeof composedPrescriptionSchema
>;
/** Likewise, for the document. */
export type PrescriptionDocumentResponse = z.infer<
  typeof prescriptionDocumentSchema
>;
