import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { isClinicalDocumentKind } from '../domain/document-kind';
import type { DocumentKind, SiteScopeFilter } from '../domain/document-kind';
import type {
  AllowedImageMimeType,
  StoredImageSummary,
} from '../domain/document-image';
import type {
  DocumentTemplate,
  HeaderField,
} from '../domain/document-template';
import type {
  DisclosureRecord,
  DocumentRenderSummary,
  DocumentRepository,
  NewDocumentImage,
  NewDocumentRender,
  NewDocumentTemplate,
  RenderQuery,
  StoredDocument,
} from '../domain/document.repository';

/**
 * The module's rows in, domain shapes out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ THERE IS NO `update` AND NO `delete` OF A RENDER IN THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not «there is not one yet»: there will not be one. `trg_document_render_
 * immutable` refuses the statement in the database, and this file refuses to
 * write it — and the two are not redundant. The trigger protects against a
 * `psql`, an import and a use case somebody adds in two years; the missing
 * method protects against the button somebody would add without reading the
 * trigger, and it is the half that turns a runtime failure into a compile
 * error.
 *
 * THE SAME FOR THE TEMPLATE AND THE IMAGE. A new template version is a new row;
 * a replaced logo is a new row and a repointed foreign key.
 */

/** Everything but the bytes. A listing must not drag a PDF out of TOAST. */
const SUMMARY_SELECT = {
  id: true,
  kind: true,
  prescriptionId: true,
  serviceOrderId: true,
  certificateId: true,
  invoiceId: true,
  siteId: true,
  byteSize: true,
  sha256: true,
  mimeType: true,
  pdfProfile: true,
  templateVersion: true,
  issuedAt: true,
  issuedById: true,
  supersedesId: true,
  supersedeReason: true,
} satisfies Prisma.DocumentRenderSelect;

type RenderRow = Prisma.DocumentRenderGetPayload<{
  select: typeof SUMMARY_SELECT;
}>;

/**
 * DOC-003. The one subject, out of the four columns.
 *
 * The `CHECK`s guarantee exactly one is populated AND that it matches the kind,
 * so this cannot legitimately return `null` for a stored row — and it still
 * returns the column that goes with the kind rather than the first non-null
 * one, because reading it any other way would keep working if the constraint
 * were ever dropped.
 */
function subjectIdOf(row: RenderRow): string {
  switch (row.kind) {
    case 'PRESCRIPTION':
      return row.prescriptionId ?? '';
    case 'SERVICE_ORDER':
      return row.serviceOrderId ?? '';
    case 'MEDICAL_CERTIFICATE':
      return row.certificateId ?? '';
    case 'INVOICE_RIDE':
      return row.invoiceId ?? '';
  }
}

function toSummary(row: RenderRow): DocumentRenderSummary {
  return {
    id: row.id,
    kind: row.kind,
    subjectId: subjectIdOf(row),
    siteId: row.siteId,
    byteSize: row.byteSize,
    sha256: row.sha256,
    mimeType: row.mimeType,
    pdfProfile: row.pdfProfile,
    templateVersion: row.templateVersion,
    issuedAt: row.issuedAt,
    issuedById: row.issuedById,
    supersedesId: row.supersedesId,
    supersedeReason: row.supersedeReason,
  };
}

/** DOC-003. The column a kind writes into. */
function subjectColumn(
  kind: DocumentKind,
  subjectId: string,
): Pick<
  Prisma.DocumentRenderUncheckedCreateInput,
  'prescriptionId' | 'serviceOrderId' | 'certificateId' | 'invoiceId'
> {
  switch (kind) {
    case 'PRESCRIPTION':
      return { prescriptionId: subjectId };
    case 'SERVICE_ORDER':
      return { serviceOrderId: subjectId };
    case 'MEDICAL_CERTIFICATE':
      return { certificateId: subjectId };
    case 'INVOICE_RIDE':
      return { invoiceId: subjectId };
  }
}

/**
 * DOC-012. The scope filter.
 *
 * `'all'` yields no filter; an empty list never reaches here, because a caller
 * whose grants resolve to no site is refused before the query.
 */
function siteFilter(sites: SiteScopeFilter): Prisma.DocumentRenderWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}

function toTemplate(row: {
  id: string;
  kind: DocumentKind;
  version: number;
  accentColour: string;
  footerText: string | null;
  headerFields: Prisma.JsonValue;
  showEstablishmentRuc: boolean;
  showEstablishmentAddress: boolean;
  showEstablishmentPhone: boolean;
  publishedAt: Date;
}): DocumentTemplate {
  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    accentColour: row.accentColour,
    footerText: row.footerText,
    // `document_template_header_fields_bounded` guarantees the shape in the
    // database, so this cast is checked by a constraint rather than by hope.
    headerFields: (row.headerFields as unknown as HeaderField[]) ?? [],
    showEstablishmentRuc: row.showEstablishmentRuc,
    showEstablishmentAddress: row.showEstablishmentAddress,
    showEstablishmentPhone: row.showEstablishmentPhone,
    publishedAt: row.publishedAt,
  };
}

/**
 * DOC-091. One audit row.
 *
 * ⚠️ NO `before`/`after`. `access_audit_payload_only_for_declared_resources`
 * whitelists exactly `'configuration'`, so a payload on a clinical resource
 * type is refused by the database — and here that refusal would roll the
 * emission back, which is the correct outcome and a terrible way to discover
 * the rule.
 */
function auditRow(
  disclosure: DisclosureRecord,
): Prisma.AccessAuditUncheckedCreateInput {
  return {
    userId: disclosure.userId,
    resourceType: 'document',
    resourceId: disclosure.resourceId,
    action: disclosure.action,
    ip: disclosure.ip,
    userAgent: disclosure.userAgent,
  };
}

@Injectable()
export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * DOC-002, DOC-091. The artefact and its trail, in ONE transaction.
   *
   * If `access_audit` refuses the row, the render is rolled back with it: an
   * emission nobody can account for does not happen. That is the policy
   * `access-audit.port.ts` prescribes for a PRINT of clinical data, and the
   * reason this does not go through `ACCESS_AUDIT_RECORDER`, whose contract is
   * to swallow the failure.
   */
  async saveRender(
    render: NewDocumentRender,
    disclosure: DisclosureRecord | null,
  ): Promise<DocumentRenderSummary> {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.documentRender.create({
        data: {
          kind: render.kind,
          templateId: render.templateId,
          templateVersion: render.templateVersion,
          ...subjectColumn(render.kind, render.subjectId),
          siteId: render.siteId,
          // `Uint8Array` and not the `Buffer`: Prisma 7 types `Bytes` as
          // `Uint8Array<ArrayBuffer>`, and a `Buffer` may sit on a
          // `SharedArrayBuffer`. The view is over the same memory, so nothing
          // is copied.
          content: new Uint8Array(render.content),
          // DOC-004. Written from the buffer itself, never from a caller's
          // count: a `byte_size` that disagrees with the bytes is a
          // `Content-Length` that truncates the download.
          byteSize: render.content.byteLength,
          sha256: render.sha256,
          issuedById: render.issuedById,
          supersedesId: render.supersedesId,
          supersedeReason: render.supersedeReason,
        },
        select: SUMMARY_SELECT,
      });

      if (disclosure !== null) {
        await tx.accessAudit.create({ data: auditRow(disclosure) });
      }

      return created;
    });

    return toSummary(row);
  }

  async findRenderSummary(
    query: RenderQuery,
  ): Promise<DocumentRenderSummary | null> {
    const row = await this.prisma.documentRender.findFirst({
      where: { id: query.renderId, ...siteFilter(query.sites) },
      select: SUMMARY_SELECT,
    });
    return row === null ? null : toSummary(row);
  }

  async findRenderContent(
    query: RenderQuery,
    disclosure: DisclosureRecord | null,
  ): Promise<StoredDocument | null> {
    // DOC-091. The read and the trail in one transaction: the bytes leave only
    // if the row saying who took them was written.
    const row = await this.prisma.$transaction(async (tx) => {
      const found = await tx.documentRender.findFirst({
        where: { id: query.renderId, ...siteFilter(query.sites) },
        select: { ...SUMMARY_SELECT, content: true },
      });
      // Nothing to disclose, nothing to record: a 404 is not an access.
      if (found === null) return null;
      // DOC-091 covers CLINICAL content. The RIDE is a tax document, and this
      // table exists to answer «¿quién leyó esta historia?»; filling it with
      // invoice reads dilutes exactly the rows an investigation looks at. The
      // kind is only known once the row is read, which is why the decision is
      // here and not at the caller.
      if (disclosure !== null && isClinicalDocumentKind(found.kind)) {
        await tx.accessAudit.create({
          data: auditRow({ ...disclosure, resourceId: found.id }),
        });
      }
      return found;
    });
    if (row === null) return null;
    return {
      ...toSummary(row),
      // DOC-006. THE STORED BYTES. Nothing here recomposes anything: Ley 67
      // art. 8(b) keeps «el formato en el que se haya generado», and a
      // recomposition is a different file.
      content: Buffer.from(row.content),
    };
  }

  async recordDisclosure(disclosure: DisclosureRecord): Promise<void> {
    // A single `INSERT` is atomic on its own, so there is no transaction to
    // open — and it still throws, which is the whole point: a draft that
    // cannot be recorded is a draft that is not served.
    await this.prisma.accessAudit.create({ data: auditRow(disclosure) });
  }

  async listRendersOfSubject(
    subjectId: string,
    kind: DocumentKind,
    sites: SiteScopeFilter,
  ): Promise<readonly DocumentRenderSummary[]> {
    const rows = await this.prisma.documentRender.findMany({
      where: {
        kind,
        ...subjectColumn(kind, subjectId),
        ...siteFilter(sites),
      },
      orderBy: { issuedAt: 'desc' },
      select: SUMMARY_SELECT,
    });
    return rows.map(toSummary);
  }

  async findCurrentTemplate(
    kind: DocumentKind,
  ): Promise<DocumentTemplate | null> {
    // DOC-031. THE HIGHEST VERSION WINS, and that is why there is no `active`
    // column: a flag would need an `UPDATE` on a versions table.
    const row = await this.prisma.documentTemplate.findFirst({
      where: { kind },
      orderBy: { version: 'desc' },
    });
    return row === null ? null : toTemplate(row);
  }

  async listTemplates(): Promise<readonly DocumentTemplate[]> {
    const rows = await this.prisma.documentTemplate.findMany({
      orderBy: [{ kind: 'asc' }, { version: 'desc' }],
    });
    return rows.map(toTemplate);
  }

  async publishTemplate(
    template: NewDocumentTemplate,
  ): Promise<DocumentTemplate> {
    /**
     * The next version number, decided INSIDE the transaction.
     *
     * `max(version) + 1` read outside one is the same number twice when two
     * people publish at the same moment, and the second `INSERT` would die on
     * `document_template_kind_version_unique`. `Serializable` is the honest
     * isolation for a read-then-write on a range: the alternative is an
     * advisory lock, which is a second mechanism for the same claim.
     */
    const row = await this.prisma.$transaction(
      async (tx) => {
        const latest = await tx.documentTemplate.findFirst({
          where: { kind: template.kind },
          orderBy: { version: 'desc' },
          select: { version: true },
        });

        return tx.documentTemplate.create({
          data: {
            kind: template.kind,
            version: (latest?.version ?? 0) + 1,
            accentColour: template.accentColour,
            footerText: template.footerText,
            headerFields: template.headerFields as unknown as Prisma.InputJsonValue, // prettier-ignore
            showEstablishmentRuc: template.showEstablishmentRuc,
            showEstablishmentAddress: template.showEstablishmentAddress,
            showEstablishmentPhone: template.showEstablishmentPhone,
            publishedById: template.publishedById,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return toTemplate(row);
  }

  async saveImage(image: NewDocumentImage): Promise<StoredImageSummary> {
    const row = await this.prisma.documentImage.create({
      data: {
        mimeType: image.mimeType,
        bytes: new Uint8Array(image.bytes),
        byteSize: image.bytes.byteLength,
        sha256: image.sha256,
        width: image.width,
        height: image.height,
        uploadedById: image.uploadedById,
      },
      select: {
        id: true,
        mimeType: true,
        byteSize: true,
        sha256: true,
        width: true,
        height: true,
      },
    });
    return { ...row, mimeType: row.mimeType as AllowedImageMimeType };
  }

  async attachEstablishmentLogo(
    establishmentId: string,
    imageId: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.establishment.updateMany({
      where: { id: establishmentId },
      data: { logoImageId: imageId },
    });
    return count === 1;
  }

  async attachPractitionerImage(
    practitionerId: string,
    slot: 'seal' | 'signature',
    imageId: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.practitioner.updateMany({
      where: { id: practitionerId },
      data:
        slot === 'seal'
          ? { sealImageId: imageId }
          : { signatureImageId: imageId },
    });
    return count === 1;
  }
}
