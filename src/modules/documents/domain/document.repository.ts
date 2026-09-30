import type { DocumentKind, SiteScopeFilter } from './document-kind';
import type { StoredImageSummary } from './document-image';
import type { DocumentTemplate, TemplateSlots } from './document-template';

/**
 * What this module needs from storage, stated without naming a database.
 *
 * A PORT: the application depends on this and the Prisma adapter implements it.
 * `dependency-cruiser` enforces the direction.
 *
 * ⚠️ THERE IS NO `update` AND NO `delete` ON A RENDER, AND THE ABSENCE IS THE
 * REQUIREMENT (DOC-011). `trg_document_render_immutable` is the guarantee in the
 * database; this interface is the same guarantee in the code, and both are
 * needed: the trigger protects against a `psql`, and a port with no method
 * protects against the button somebody would add without reading the trigger.
 */

/** DOC-002. Everything an artefact is born with. */
export interface NewDocumentRender {
  kind: DocumentKind;
  templateId: string;
  templateVersion: number;
  subjectId: string;
  siteId: string;
  content: Buffer;
  sha256: string;
  issuedById: string;
  /** DOC-007, DOC-010. The two travel together or neither does. */
  supersedesId: string | null;
  supersedeReason: string | null;
}

/** DOC-092. The metadata, without dragging the bytes out of TOAST. */
export interface DocumentRenderSummary {
  id: string;
  kind: DocumentKind;
  subjectId: string;
  siteId: string;
  byteSize: number;
  sha256: string;
  mimeType: string;
  pdfProfile: string;
  templateVersion: number;
  issuedAt: Date;
  issuedById: string;
  supersedesId: string | null;
  supersedeReason: string | null;
}

/** The bytes, plus the metadata that has to travel with them. */
export interface StoredDocument extends DocumentRenderSummary {
  content: Buffer;
}

export interface RenderQuery {
  renderId: string;
  sites: SiteScopeFilter;
}

/** DOC-030. A new template version. The number is assigned by the repository. */
export interface NewDocumentTemplate extends TemplateSlots {
  kind: DocumentKind;
  publishedById: string;
}

/** DOC-056. One image, on its way in. */
export interface NewDocumentImage {
  mimeType: string;
  bytes: Buffer;
  sha256: string;
  width: number;
  height: number;
  uploadedById: string;
}

/**
 * DOC-091. One disclosure, recorded IN THE SAME TRANSACTION as the act.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS DOES NOT GO THROUGH `ACCESS_AUDIT_RECORDER`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That port states its own failure policy out loud: it MUST NOT throw into the
 * caller's path, because refusing to show a doctor a chart when the audit table
 * is unreachable is the wrong trade in a clinic — and it says, in the same
 * comment, that «an EXPORT or a PRINT of clinical data, when they exist, must
 * do the same» as `MFA_RESET`: write inside their own transaction, so an act
 * that cannot be recorded does not happen.
 *
 * THIS MODULE IS THAT PRINT. What leaves here is a FILE — forwardable, storable,
 * printable — and not a screen somebody looked at, so «no se pudo registrar»
 * cannot be allowed to mean «pero el PDF salió igual». Emitting and reprinting
 * therefore FAIL CLOSED: no trail, no bytes.
 *
 * ⚠️ NO `before`/`after` PAYLOAD, EVER.
 * `access_audit_payload_only_for_declared_resources` whitelists exactly
 * `'configuration'`, and clinical resource types are deliberately absent: this
 * table is append-only and never purged, so a chart's contents landing in it
 * could never be corrected or removed.
 */
export interface DisclosureRecord {
  userId: string;
  /** The artefact or the subject, depending on which act is being recorded. */
  resourceId: string;
  /** `PRINT` when a file leaves; `CREATE` when the archive gains a row. */
  action: 'PRINT' | 'CREATE';
  ip?: string;
  userAgent?: string;
}

export interface DocumentRepository {
  /**
   * DOC-002, DOC-091. Writes the artefact AND its disclosure, atomically.
   *
   * The only way a render is ever created. `disclosure` is `null` only for a
   * document that is not clinical content — the RIDE — where there is nothing
   * about a person's health to account for.
   */
  saveRender(
    render: NewDocumentRender,
    disclosure: DisclosureRecord | null,
  ): Promise<DocumentRenderSummary>;

  /** DOC-012, DOC-092. `null` when it does not exist OR is out of scope. */
  findRenderSummary(query: RenderQuery): Promise<DocumentRenderSummary | null>;

  /**
   * DOC-006, DOC-091. The stored bytes, and the row saying who took them.
   *
   * The trail is written FIRST, in the same transaction: if it cannot be
   * written, the bytes are not served.
   */
  findRenderContent(
    query: RenderQuery,
    disclosure: DisclosureRecord | null,
  ): Promise<StoredDocument | null>;

  /** DOC-091. A draft leaving the building. Nothing else is stored. */
  recordDisclosure(disclosure: DisclosureRecord): Promise<void>;

  /** The artefacts of one subject, newest first. */
  listRendersOfSubject(
    subjectId: string,
    kind: DocumentKind,
    sites: SiteScopeFilter,
  ): Promise<readonly DocumentRenderSummary[]>;

  /**
   * DOC-031. The published version with the highest number, or `null`.
   *
   * DERIVED AND NOT MARKED. There is no `active` column: a flag would need an
   * `UPDATE` to move, and an `UPDATE` on a versions table is the very change
   * this module exists to prevent.
   */
  findCurrentTemplate(kind: DocumentKind): Promise<DocumentTemplate | null>;

  listTemplates(): Promise<readonly DocumentTemplate[]>;

  /** DOC-030. Publishes the next version of a kind, whatever number that is. */
  publishTemplate(template: NewDocumentTemplate): Promise<DocumentTemplate>;

  /** DOC-056, DOC-058. Inserts a new image row. Nothing is ever updated. */
  saveImage(image: NewDocumentImage): Promise<StoredImageSummary>;

  /** DOC-057. Repoints an establishment's logo at a freshly stored image. */
  attachEstablishmentLogo(
    establishmentId: string,
    imageId: string,
  ): Promise<boolean>;

  /** DOC-057. Repoints a practitioner's seal or signature. */
  attachPractitionerImage(
    practitionerId: string,
    slot: 'seal' | 'signature',
    imageId: string,
  ): Promise<boolean>;
}

export const DOCUMENT_REPOSITORY = Symbol('DOCUMENT_REPOSITORY');
