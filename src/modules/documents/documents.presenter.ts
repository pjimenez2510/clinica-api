import type { StoredImageSummary } from './domain/document-image';
import type { DocumentTemplate } from './domain/document-template';
import type { DocumentRenderSummary } from './domain/document.repository';
import type {
  DocumentImageResponse,
  DocumentRenderResponse,
  DocumentTemplateResponse,
} from './dto/documents.dto';

/**
 * Domain shapes out, HTTP shapes in.
 *
 * EXPLICIT AND FIELD BY FIELD, never a spread of the domain object. A spread
 * publishes whatever field somebody adds next — and in this module the field
 * somebody would add next is the artefact's `content`, which is a whole PDF of
 * somebody's chart travelling inside a JSON listing.
 *
 * Instants leave as ISO-8601 STRINGS. `z.date()` has no JSON Schema
 * representation, so a response schema carrying one breaks the OpenAPI document
 * `clinica-web` generates its types from — and serialising here is also what
 * keeps the two sides from disagreeing about whether a field is an instant or a
 * calendar date.
 */

/**
 * An artefact's metadata — never its `content` — with the issuing instant as an
 * ISO string (DOC-092).
 */
export function toRenderResponse(
  render: DocumentRenderSummary,
): DocumentRenderResponse {
  return {
    id: render.id,
    kind: render.kind,
    subjectId: render.subjectId,
    siteId: render.siteId,
    byteSize: render.byteSize,
    sha256: render.sha256,
    mimeType: render.mimeType,
    pdfProfile: render.pdfProfile,
    templateVersion: render.templateVersion,
    issuedAt: render.issuedAt.toISOString(),
    issuedById: render.issuedById,
    supersedesId: render.supersedesId,
    supersedeReason: render.supersedeReason,
  };
}

/**
 * One template version, slot by slot (DOC-034), header fields copied rather
 * than passed through.
 */
export function toTemplateResponse(
  template: DocumentTemplate,
): DocumentTemplateResponse {
  return {
    id: template.id,
    kind: template.kind,
    version: template.version,
    accentColour: template.accentColour,
    footerText: template.footerText,
    headerFields: template.headerFields.map((field) => ({
      label: field.label,
      value: field.value,
    })),
    showEstablishmentRuc: template.showEstablishmentRuc,
    showEstablishmentAddress: template.showEstablishmentAddress,
    showEstablishmentPhone: template.showEstablishmentPhone,
    publishedAt: template.publishedAt.toISOString(),
  };
}

/**
 * A stored image's description; the bytes are never part of a JSON response.
 */
export function toImageResponse(
  image: StoredImageSummary,
): DocumentImageResponse {
  return {
    id: image.id,
    mimeType: image.mimeType,
    byteSize: image.byteSize,
    sha256: image.sha256,
    width: image.width,
    height: image.height,
  };
}
