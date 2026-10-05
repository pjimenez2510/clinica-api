import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { noteTemplateSchema } from './note-template.dto';

/**
 * The clinical note's contract.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, telling the user what to do.
 */

const NOTE_STATUS = z.enum([
  'DRAFT',
  'SIGNED',
  'SUPERSEDED',
  'ENTERED_IN_ERROR',
]);

const DISCHARGE_CONDITION = z.enum([
  'ALIVE',
  'REFERRED',
  'DECEASED',
  'ABANDONED',
]);

/**
 * EN-020. The narrative sections of a form.
 *
 * A FREE OBJECT AND NOT A FIXED SHAPE, and the SPEC's own frontier is why: the
 * typed columns carry everything the ministry reports on or the system queries
 * — the vital signs are `encounter_vitals` and the diagnosis is
 * `encounter_diagnosis` — and what lands here is prose that is only read and
 * printed. Declaring the six sections of the 002 as required fields HERE would
 * make the DTO the second place that knows what a form is, and a 005 or a 033
 * would need a schema of its own. WHICH sections a form must carry is
 * `CLINICAL_FORMS` in the domain, checked at the signature (EN-020), which is
 * the moment the note becomes the record.
 *
 * ⚠️ THE VALUES ARE STRINGS. A section holding an object would sail past
 * `assertNoteComplete`, which asks for non-empty text, and would then be
 * unprintable — and this content is what a court is shown.
 */
const noteContent = z.record(
  z.string(),
  z.string({ error: 'Cada sección del formulario es texto' }),
);

/**
 * EN-020, EN-021, EN-137. Opening a note.
 *
 * ⚠️ THE FORM CODE IS A STRING AND NOT AN ENUM, and that is the requirement
 * rather than laziness (EN-021): the A.M. 00115-2021 went from 16 forms to 51,
 * and `clinical_note.form_code` is a `VarChar(8)` precisely so a renumbering
 * costs an UPDATE and not a migration. What is closed is not the CODE but the
 * set of forms this installation can validate, and that lives in the domain's
 * registry — so an unknown code answers `UNKNOWN_CLINICAL_FORM` naming the
 * ones that exist, instead of a generic per-field 422 that names none.
 */
export const draftNoteSchema = z.object({
  formCode: z
    .string()
    .trim()
    .min(1, 'Indique el formulario')
    .max(8, 'El código de formulario no puede superar 8 caracteres'),
  /** Versioned apart, so a revised 002 is a new key and not a new table. */
  formVersion: z
    .string()
    .trim()
    .max(16, 'La versión del formulario no puede superar 16 caracteres')
    .default('1'),
  content: noteContent,
});
/** Body of POST /encounters/:encounterId/notes. */
export class DraftNoteDto extends createZodDto(draftNoteSchema) {}

/** EN-023. Replacing the content of a draft. */
export const updateNoteSchema = z.object({ content: noteContent });
export class UpdateNoteDto extends createZodDto(updateNoteSchema) {}

/**
 * EN-027, EN-130, EN-138. Signing.
 *
 * ⚠️ THE DISCHARGE CONDITION IS ASKED FOR HERE, ON THE SIGNATURE. Signing the
 * consultation note IS the clinical discharge (EN-138), and
 * `encounter_discharge_states_a_condition` refuses a `DISCHARGED` attention
 * with no condition — so the doctor states the outcome in the same act in
 * which they declare themselves finished, which is also the only moment at
 * which it is a clinical fact rather than a guess. The cashier inherits it at
 * `COMPLETED`; nobody restates it and nobody invents it (EN-145).
 *
 * OPTIONAL IN THE SCHEMA because a form that does not discharge — an evolution
 * note — has no outcome to declare. When the form IS the consultation note,
 * the service refuses without it (`DISCHARGE_CONDITION_REQUIRED`), because
 * whether this particular form discharges is a fact of the DOMAIN's registry
 * and not of the request.
 */
export const signNoteSchema = z.object({
  dischargeCondition: DISCHARGE_CONDITION.optional(),
});
/** Body of POST /encounters/:encounterId/notes/:noteId/sign (`record:sign`). */
export class SignNoteDto extends createZodDto(signNoteSchema) {}

/**
 * EN-025. Amending: a NEW version, with the whole content and a written
 * reason.
 *
 * THE WHOLE CONTENT AND NOT A PATCH. An amendment that inherited the previous
 * version and applied a diff would make the two rows differ by whatever the
 * caller forgot to send, and the previous version has to stay readable and
 * printable exactly as it was — which it can only do if the new one states
 * itself in full.
 */
export const amendNoteSchema = z.object({
  content: noteContent,
  /**
   * EN-025. Refused per field so the form highlights the box, demanded again
   * in the service for the caller that does not come through the DTO, and a
   * third time by `clinical_note_amendment_reason` in the database.
   *
   * FREE TEXT AND NOT A DROPDOWN, and the schema comment says why: «un
   * desplegable se rellena en piloto automático; un cuadro de texto no». It
   * has to be citable in a legal proceeding, and «Otro» cites nothing.
   */
  amendmentReason: z
    .string()
    .trim()
    .min(1, 'Indique el motivo de la enmienda')
    .max(2000, 'El motivo no puede superar 2000 caracteres'),
});
/** Body of POST /encounters/:encounterId/notes/:noteId/amend. */
export class AmendNoteDto extends createZodDto(amendNoteSchema) {}

/**
 * One version of a note as a client reads it.
 *
 * ⚠️ `content` TRAVELS AND IT IS CLINICAL CONTENT — the reason for the visit,
 * the present illness, the plan of treatment. It is why reading a note is
 * audited (EN-122) while listing attentions is not (EN-123), and why no field
 * of this response may ever reach a log (EN-124).
 */
export const clinicalNoteSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  /** EN-024. Constant across every version of the same note. */
  chainId: z.uuid(),
  version: z.number().int(),
  /** EN-021. The MSP form number, as data. */
  formCode: z.string(),
  formVersion: z.string(),
  status: NOTE_STATUS,
  content: z.record(z.string(), z.unknown()),
  authorId: z.uuid(),
  /**
   * EN-027. The three that `clinical_note_signature_coherence` ties together:
   * all present or all absent, never «firmada a medias».
   *
   * THE HASH TRAVELS. It is what proves the content has not changed since the
   * signature WITHOUT trusting that the immutability trigger was never
   * disabled, and publishing it lets that be verified from outside the
   * database — which is what SC-012 counts.
   */
  signedById: z.uuid().nullable(),
  signedAt: z.iso.datetime().nullable(),
  contentHash: z.string().nullable(),
  /**
   * EN-025, EN-026. The version this one replaced, and why.
   *
   * A RETRACTED VERSION HAS NEITHER, and that is how a client tells «esto lo
   * escribí mal y aquí está lo correcto» from «esto no debió escribirse
   * nunca»: the first points at its replacement, the second points at nothing.
   */
  supersedesId: z.uuid().nullable(),
  amendmentReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /**
   * EN-204. The template the note was opened with: its sections, titles and
   * order, so a signed note is shown as it was written and not as the clinic
   * configures the note today.
   */
  template: noteTemplateSchema,
});
/** Response of every write on a note: drafting, updating, signing, amending and retracting. */
export class ClinicalNoteDto extends createZodDto(clinicalNoteSchema) {}

export const clinicalNoteListSchema = z.object({
  items: z.array(clinicalNoteSchema),
});
/** Response of GET /encounters/:encounterId/notes. */
export class ClinicalNoteListDto extends createZodDto(clinicalNoteListSchema) {}

/** Response types the controller returns, inferred from the schemas Swagger publishes. */
export type ClinicalNoteResponse = z.infer<typeof clinicalNoteSchema>;
export type ClinicalNoteListResponse = z.infer<typeof clinicalNoteListSchema>;
