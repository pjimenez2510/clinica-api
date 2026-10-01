import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  CLINICAL_DOCUMENT_KINDS,
  DOCUMENT_KINDS,
} from '../domain/document-kind';
import { MAX_HEADER_FIELDS } from '../domain/document-template';

/**
 * The module's contract.
 *
 * Responses are schemas too and not bare interfaces: `clinica-web` generates
 * its types from the OpenAPI document, and a response Swagger cannot see
 * arrives on the other side typed as `never`.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, telling the user what to do.
 *
 * ⚠️ THE UPLOADS HAVE NO DTO, AND THAT IS DELIBERATE. A logo arrives as raw
 * `image/png` or `image/jpeg` bytes through `express.raw`, not as base64 inside
 * JSON: base64 inflates a 512 KB file to 700 KB of string that has to be parsed
 * and held in memory before anything can look at it, and the byte cap has to
 * apply BEFORE that (DOC-052). The middleware's `limit` is that cap, applied at
 * the socket.
 */

/** DOC-090. The three a caller holding `record:read` may ask for. */
const CLINICAL_KIND = z.enum(
  CLINICAL_DOCUMENT_KINDS as unknown as [string, ...string[]],
  { error: 'Elija el tipo de documento clínico que quiere imprimir' },
);

const ANY_KIND = z.enum(DOCUMENT_KINDS as unknown as [string, ...string[]]);

/** DOC-001, DOC-002. Which document, of what. */
const renderRequestSchema = z.object({
  kind: CLINICAL_KIND,
  subjectId: z.uuid('Seleccione el documento que quiere imprimir'),
});

/** Body of POST /documents/drafts and POST /documents/renders; `kind` admits only the clinical kinds. */
export class RenderRequestDto extends createZodDto(renderRequestSchema) {}

/**
 * DOC-007. Emitting a correction.
 *
 * ⚠️ THE REASON IS OBLIGATORY, and `document_render_supersession_states_why`
 * says the same thing in the database. Without it, annulling is a way of making
 * what was emitted disappear — the same argument that made the reason
 * obligatory on discarding a prescription draft.
 */
const supersedeRequestSchema = renderRequestSchema.extend({
  supersedesId: z.uuid('Indique el documento que se está corrigiendo'),
  reason: z
    .string()
    .trim()
    .min(10, 'Escriba por qué se corrige el documento anterior')
    .max(500, 'El motivo no puede superar 500 caracteres'),
});

/** Body of POST /documents/renders/supersede. */
export class SupersedeRequestDto extends createZodDto(supersedeRequestSchema) {}

/** DOC-034 to DOC-036. The closed set of slots. Nothing else is accepted. */
const templateSlotsSchema = z.object({
  kind: ANY_KIND,
  accentColour: z
    .string()
    .regex(
      /^#[0-9a-f]{6}$/,
      'El color de acento se escribe como #rrggbb en minúsculas, por ejemplo #1f6f8b',
    ),
  footerText: z
    .string()
    .trim()
    .max(500, 'El pie de página no puede superar 500 caracteres')
    .nullable()
    .default(null),
  headerFields: z
    .array(
      z.object({
        label: z
          .string()
          .trim()
          .min(1, 'Escriba la etiqueta del campo')
          .max(40, 'La etiqueta no puede superar 40 caracteres'),
        value: z
          .string()
          .trim()
          .min(1, 'Escriba el valor del campo')
          .max(120, 'El valor no puede superar 120 caracteres'),
      }),
    )
    .max(
      MAX_HEADER_FIELDS,
      `La cabecera admite como mucho ${MAX_HEADER_FIELDS} campos`,
    )
    .default([]),
  // DOC-034. Art. 5 requires NONE of these three, so printing them is a choice.
  showEstablishmentRuc: z.boolean().default(false),
  showEstablishmentAddress: z.boolean().default(false),
  showEstablishmentPhone: z.boolean().default(false),
});

/** Body of POST /documents/templates (`config:manage`). */
export class PublishTemplateDto extends createZodDto(templateSlotsSchema) {}

/** DOC-039. Body of POST /documents/templates/all-kinds: the slots, no kind. */
export class PublishAllKindsDto extends createZodDto(
  templateSlotsSchema.omit({ kind: true }),
) {}

/**
 * DOC-038. Body of POST /documents/templates/preview: a kind and the slots as
 * the form has them now. NO SITE: the route is `global`, and D-023 (AU-011)
 * keeps a site out of the body of every global route — the preview borrows the
 * identity of the first active site.
 */
export class PreviewTemplateDto extends createZodDto(templateSlotsSchema) {}

// ── responses ──────────────────────────────────────────────────────────────

const renderSummarySchema = z.object({
  id: z.uuid(),
  kind: ANY_KIND,
  subjectId: z.uuid(),
  siteId: z.uuid(),
  byteSize: z.number().int(),
  /** SC-061. The proof the archived file has not moved. */
  sha256: z.string(),
  mimeType: z.string(),
  pdfProfile: z.string(),
  templateVersion: z.number().int(),
  /**
   * An ISO-8601 INSTANT as a string, not a `Date`.
   *
   * `z.date()` cannot be represented in JSON Schema, so the OpenAPI document
   * would fail to build — and `clinica-web` generates its types from that
   * document. Serialising in the presenter is also what keeps the two sides
   * from disagreeing about whether this is an instant or a calendar date.
   */
  issuedAt: z.iso.datetime(),
  issuedById: z.uuid(),
  supersedesId: z.uuid().nullable(),
  supersedeReason: z.string().nullable(),
});

/** Response of every route that emits or reads an archived render, clinical documents and invoice RIDEs alike. */
export class DocumentRenderDto extends createZodDto(renderSummarySchema) {}
/** What the presenter returns for it, inferred from the schema. */
export type DocumentRenderResponse = z.infer<typeof renderSummarySchema>;

const templateSchema = z.object({
  id: z.uuid(),
  kind: ANY_KIND,
  version: z.number().int(),
  accentColour: z.string(),
  footerText: z.string().nullable(),
  headerFields: z.array(z.object({ label: z.string(), value: z.string() })),
  showEstablishmentRuc: z.boolean(),
  showEstablishmentAddress: z.boolean(),
  showEstablishmentPhone: z.boolean(),
  publishedAt: z.iso.datetime(),
});

/** Response of listing and publishing templates. */
export class DocumentTemplateDto extends createZodDto(templateSchema) {}
/** What the templates controller returns, inferred from the schema. */
export type DocumentTemplateResponse = z.infer<typeof templateSchema>;

const imageSchema = z.object({
  id: z.uuid(),
  mimeType: z.string(),
  byteSize: z.number().int(),
  /**
   * SC-063. The hash of what is STORED, which is never the hash of what was
   * uploaded: the image is always re-encoded from its pixels.
   */
  sha256: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

/** Response of uploading a logo, a seal or a signature. */
export class DocumentImageDto extends createZodDto(imageSchema) {}
/** What the identity controller returns, inferred from the schema. */
export type DocumentImageResponse = z.infer<typeof imageSchema>;

/** DOC-094, DOC-095. The public answer: nothing about the patient. */
const verificationSchema = z.object({
  kind: z.enum(['PRESCRIPTION', 'MEDICAL_CERTIFICATE']),
  /** A clinical date in `America/Guayaquil`, `YYYY-MM-DD`. */
  issuedOn: z.iso.date(),
  establishmentName: z.string(),
  siteName: z.string(),
  practitionerName: z.string(),
  status: z.enum(['VALID', 'ANNULLED']),
  annulledOn: z.iso.date().nullable(),
});

/** Response of GET /documents/verify/:code. */
export class DocumentVerificationDto extends createZodDto(verificationSchema) {}
