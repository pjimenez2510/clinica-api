import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { composeLayout } from '../domain/document-layout';
import {
  DOCUMENT_RENDERER,
  type DocumentRenderer,
  type LayoutImages,
} from '../domain/document-rendering.port';
import {
  DOCUMENT_SOURCE_READER,
  type DocumentSourceReader,
  type DocumentSubject,
} from '../domain/document-source';
import {
  DOCUMENT_REPOSITORY,
  type DisclosureRecord,
  type DocumentRenderSummary,
  type DocumentRepository,
  type StoredDocument,
} from '../domain/document.repository';
import {
  DocumentRenderNotFoundError,
  DocumentSubjectNotFoundError,
  DocumentSubjectNotIssuableError,
  DocumentTemplateNotPublishedError,
} from '../domain/document.errors';
import { assertSlotsAreValid } from '../domain/document-template';
import { SAMPLE_MARK, sampleSubject } from '../domain/document-samples';
import {
  DOCUMENT_KINDS,
  isClinicalDocumentKind,
} from '../domain/document-kind';
import type { DocumentKind, SiteScopeFilter } from '../domain/document-kind';
import type { DocumentTemplate, TemplateSlots } from '../domain/document-template'; // prettier-ignore

/** DOC-090, DOC-091. Who is asking. */
export interface Requester {
  /** The account id. Never a cedula (REQ-110). */
  userId: string;
  /** The caller's own resolved scope, never a site they named. */
  sites: SiteScopeFilter;
  ip?: string;
  userAgent?: string;
}

/**
 * Which document of which subject: one kind and the id of its prescription,
 * order, certificate or invoice (DOC-003).
 */
export interface RenderRequest {
  kind: DocumentKind;
  subjectId: string;
}

/** DOC-007. Emitting a correction: the artefact it annuls, and why. */
export interface SupersedeRequest extends RenderRequest {
  supersedesId: string;
  reason: string;
}

/** The bytes plus what has to travel with them in an HTTP response. */
export interface RenderedDocument {
  content: Buffer;
  mimeType: string;
  sha256: string;
  fileName: string;
}

/**
 * The document: composing a draft, emitting the artefact, serving it again and
 * publishing a template version.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE SERVICE, ONE AGGREGATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ADR-008 §2 splits a service when it crosses one of three limits: more than
 * ~8 public use cases, two groups of methods with no dependencies in common, or
 * two reasons to change. This has seven, they all revolve around the artefact
 * and the template version that produced it, and they change for one reason —
 * what the norm requires a printed document to be. Splitting «leer» from
 * «emitir» would be a pattern by symmetry, which CLAUDE.md §9 refuses.
 *
 * The IMAGES are the other aggregate, and they do have their own service: a
 * logo is uploaded by whoever administers the clinic's identity, changes for
 * entirely different reasons, and shares no dependency with any of this.
 *
 * ⚠️ WHAT THIS SERVICE NEVER DOES, AND EACH ABSENCE IS A REQUIREMENT:
 *
 *  - IT DOES NOT MODIFY OR DELETE AN ARTEFACT (DOC-011). There is no method,
 *    and the database refuses the statement besides.
 *  - IT DOES NOT ARCHIVE A DRAFT (DOC-014). The draft is served and forgotten;
 *    what is filed is what a pharmacy or an inspector could be handed.
 *  - IT DOES NOT SIGN ANYTHING (§7 of the SPEC). The candidate library covers
 *    only the basic PAdES level, without time-stamping, and a signature that
 *    stops validating when the doctor's certificate expires — two years — while
 *    the archive must last five is worse than none, because it looks valid.
 *  - IT DOES NOT INVENT A TEMPLATE (DOC-037). A template that exists only in
 *    the code is the version no row records.
 */
@Injectable()
export class DocumentService {
  constructor(
    @Inject(DOCUMENT_REPOSITORY)
    private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_SOURCE_READER)
    private readonly sources: DocumentSourceReader,
    @Inject(DOCUMENT_RENDERER)
    private readonly renderer: DocumentRenderer,
  ) {}

  /**
   * DOC-001. A draft: bytes out, nothing stored.
   *
   * ⚠️ AND IT IS AUDITED ALL THE SAME. What leaves is the same file: the
   * patient's name, their age, their diagnosis and their medication. Auditing
   * only the filed copy would leave the cheapest way of taking a chart out of
   * the building unrecorded.
   */
  async draft(
    request: RenderRequest,
    requester: Requester,
  ): Promise<RenderedDocument> {
    const { subject, images, template, layout } = await this.prepare(
      request,
      requester.sites,
    );

    const content = await this.renderer.render(layout, images, {
      title: layout.frame.title,
      author: layout.frame.establishmentName,
      // A draft has no instant of emission — that is what makes it a draft —
      // so the clock is the honest answer here and only here.
      createdAt: new Date(),
    });

    // DOC-091. AND IT THROWS IF IT CANNOT BE WRITTEN. A draft is the cheapest
    // way to take a chart out of the building: the same file, without the row
    // that says who took it.
    if (isClinicalDocumentKind(subject.kind)) {
      await this.documents.recordDisclosure(
        disclosureOf(requester, request.subjectId, 'PRINT'),
      );
    }

    return {
      content,
      mimeType: 'application/pdf',
      sha256: sha256Of(content),
      fileName: fileNameFor(request.kind, template.version, 'borrador'),
    };
  }

  /**
   * DOC-002, DOC-007, DOC-014. Emits the artefact: composes it once and files
   * the bytes.
   *
   * ⚠️ THE HASH IS TAKEN OF WHAT IS STORED, IN THE SAME BREATH. Hashing a
   * second composition — or letting the caller send one — would produce a
   * `sha256` that describes a file nobody has, which is the one thing this
   * column must never do (SC-061).
   */
  async emit(
    request: RenderRequest | SupersedeRequest,
    requester: Requester,
  ): Promise<DocumentRenderSummary> {
    const { subject, images, template, layout, siteId } = await this.prepare(
      request,
      requester.sites,
    );

    assertIssuable(subject);

    const issuedAt = new Date();
    const content = await this.renderer.render(layout, images, {
      title: layout.frame.title,
      author: layout.frame.establishmentName,
      // DOC-024. The instant of EMISSION, and the very same one that goes into
      // the row: two clocks would make the file and the archive disagree about
      // when the document was produced.
      createdAt: issuedAt,
    });

    const supersedes = 'supersedesId' in request ? request : null;

    // DOC-002, DOC-091. The artefact and the row saying who produced it, in one
    // transaction. If the trail cannot be written, the artefact is not filed.
    return this.documents.saveRender(
      {
        kind: request.kind,
        templateId: template.id,
        templateVersion: template.version,
        subjectId: request.subjectId,
        siteId,
        content,
        sha256: sha256Of(content),
        issuedById: requester.userId,
        supersedesId: supersedes?.supersedesId ?? null,
        supersedeReason: supersedes?.reason ?? null,
      },
      isClinicalDocumentKind(subject.kind)
        ? disclosureOf(requester, request.subjectId, 'CREATE')
        : null,
    );
  }

  /**
   * DOC-092. The metadata. Deliberately NOT audited: it carries no clinical
   * datum — a class, a size, a hash, an instant and an author.
   *
   * ⚠️ `allowed` IS AN AUTHORISATION CHECK AND NOT A CONVENIENCE (DOC-090). The
   * RIDE is served under `billing:read` and the clinical documents under
   * `record:read`, and an artefact is found by an identifier that says nothing
   * about which of the two it is. Without this, whoever bills could ask for the
   * metadata of a receta by passing its id to the RIDE route — the permission
   * would pass, because the permission is on the ROUTE and the kind is in the
   * ROW.
   */
  async metadata(
    renderId: string,
    allowed: readonly DocumentKind[],
    requester: Requester,
  ): Promise<DocumentRenderSummary> {
    const summary = await this.documents.findRenderSummary({
      renderId,
      sites: requester.sites,
    });
    if (summary === null || !allowed.includes(summary.kind)) {
      // The same answer for «no existe», «no es de su sede» and «no es de esa
      // clase»: telling them apart would confirm the existence of documents the
      // caller may not see, one guessed identifier at a time.
      throw new DocumentRenderNotFoundError();
    }
    return summary;
  }

  /**
   * DOC-006, DOC-091. Reprinting: THE STORED BYTES.
   *
   * Nothing here recomposes anything. Ley 67 art. 8(b) keeps «el formato en el
   * que se haya generado», and a recomposition is a different file — a different
   * template version, a different tariff, a different date in the metadata — so
   * it would no longer be the document somebody held.
   */
  async content(
    renderId: string,
    allowed: readonly DocumentKind[],
    requester: Requester,
  ): Promise<StoredDocument> {
    /**
     * DOC-091. THE TRAIL IS WRITTEN IN THE SAME TRANSACTION AS THE READ, so the
     * bytes leave only if the row saying who took them was written.
     *
     * The kind is not known until the row is read, so the disclosure is handed
     * over unconditionally and the adapter decides: nothing found, nothing
     * recorded; a RIDE found, nothing recorded either, because a tax document
     * is not clinical content and this table exists to watch who reads a chart.
     */
    const stored = await this.documents.findRenderContent(
      { renderId, sites: requester.sites },
      disclosureOf(requester, renderId, 'PRINT'),
    );
    if (stored === null || !allowed.includes(stored.kind)) {
      // DOC-090 again, and here it matters more: what would have travelled is
      // the FILE. The trail row was written inside the transaction and stays —
      // an attempt to reach a document of the wrong class is exactly the thing
      // an investigation wants to find.
      throw new DocumentRenderNotFoundError();
    }
    return stored;
  }

  /** The artefacts of one subject, newest first. */
  async history(
    request: RenderRequest,
    requester: Requester,
  ): Promise<readonly DocumentRenderSummary[]> {
    return this.documents.listRendersOfSubject(
      request.subjectId,
      request.kind,
      requester.sites,
    );
  }

  /**
   * DOC-030. Every published version of every kind, newest version first within
   * a kind; the current one is the first of its kind (DOC-031).
   */
  listTemplates(): Promise<readonly DocumentTemplate[]> {
    return this.documents.listTemplates();
  }

  /** DOC-030, DOC-034 to DOC-036. Publishes the next version of a kind. */
  async publishTemplate(
    kind: DocumentKind,
    slots: TemplateSlots,
    requester: Requester,
  ): Promise<DocumentTemplate> {
    assertSlotsAreValid(slots);
    return this.documents.publishTemplate({
      ...slots,
      kind,
      publishedById: requester.userId,
    });
  }

  /**
   * DOC-039. One identity for the four classes (D-095.3): the next version of
   * each, in one transaction, so no receta goes out with the new colour while
   * the certificate still carries the old one.
   */
  async publishTemplateForAllKinds(
    slots: TemplateSlots,
    requester: Requester,
  ): Promise<DocumentTemplate[]> {
    assertSlotsAreValid(slots);
    return this.documents.publishTemplates(
      DOCUMENT_KINDS.map((kind) => ({
        ...slots,
        kind,
        publishedById: requester.userId,
      })),
    );
  }

  /**
   * DOC-038. The PDF a template WOULD produce: the clinic's real identity,
   * these slots, and content that is invented and says so. Nothing is stored
   * and nothing is audited — no person's data leaves in it.
   */
  async previewTemplate(
    kind: DocumentKind,
    slots: TemplateSlots,
  ): Promise<RenderedDocument> {
    assertSlotsAreValid(slots);

    // The first active site: a global route takes no site (D-023, AU-011).
    const site = await this.sources.firstActiveSiteId();
    const context =
      site === null ? null : await this.sources.contextForSite(site);
    if (context === null) throw new DocumentSubjectNotFoundError();

    // A preview is not an act: the clock is the honest instant, as in a draft.
    const now = new Date();
    const template: DocumentTemplate = {
      ...slots,
      id: 'preview',
      kind,
      version: 0,
      publishedAt: now,
    };
    const composed = composeLayout(sampleSubject(kind, now), context, template);
    // DOC-038. The letterhead is real; the paper must say it is not.
    const layout = {
      ...composed,
      frame: { ...composed.frame, watermark: SAMPLE_MARK },
    };
    const content = await this.renderer.render(
      layout,
      { logo: context.establishment.logo, seal: null, signature: null },
      {
        title: layout.frame.title,
        author: layout.frame.establishmentName,
        createdAt: now,
      },
    );

    return {
      content,
      mimeType: 'application/pdf',
      sha256: sha256Of(content),
      fileName: fileNameFor(kind, 0, 'muestra'),
    };
  }

  // ── composition ──────────────────────────────────────────────────────────

  /**
   * Everything a document needs, gathered once.
   *
   * THE SITE COMES FROM THE SUBJECT AND NEVER FROM THE REQUEST. A caller who
   * could name the site would be choosing which establishment's letterhead
   * their receta carries, which is the one thing art. 10 forbids: «en ningún
   * caso pueden ser utilizadas en otros establecimientos de salud».
   */
  private async prepare(request: RenderRequest, sites: SiteScopeFilter) {
    const subject = await this.sources.findSubject({
      kind: request.kind,
      subjectId: request.subjectId,
      sites,
    });
    if (subject === null) throw new DocumentSubjectNotFoundError();

    const siteId = subject.data.siteId;
    const context = await this.sources.contextForSite(siteId);
    if (context === null) throw new DocumentSubjectNotFoundError();

    const template = await this.documents.findCurrentTemplate(request.kind);
    if (template === null) {
      throw new DocumentTemplateNotPublishedError(request.kind);
    }

    const images: LayoutImages = {
      logo: context.establishment.logo,
      seal: signerOf(subject)?.seal ?? null,
      signature: signerOf(subject)?.signature ?? null,
    };

    return {
      subject,
      siteId,
      template,
      images,
      layout: composeLayout(subject, context, template),
    };
  }
}

/** DOC-091. Who took what, from where. Never a cedula (REQ-110). */
function disclosureOf(
  requester: Requester,
  resourceId: string,
  action: DisclosureRecord['action'],
): DisclosureRecord {
  return {
    userId: requester.userId,
    resourceId,
    action,
    ip: requester.ip,
    userAgent: requester.userAgent,
  };
}

/** SC-061. Lowercase hex, which is what `document_render_sha256_format` demands. */
function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** What the browser saves the file as. Never carries a patient's name. */
function fileNameFor(
  kind: DocumentKind,
  version: number,
  suffix?: string,
): string {
  const stem = kind.toLowerCase().replace(/_/g, '-');
  return [stem, `v${version}`, suffix].filter(Boolean).join('-') + '.pdf';
}

/** The practitioner whose seal the document carries, if it carries one. */
function signerOf(subject: DocumentSubject) {
  switch (subject.kind) {
    case 'PRESCRIPTION':
      return subject.data.prescriber;
    case 'SERVICE_ORDER':
      return subject.data.orderedBy;
    case 'MEDICAL_CERTIFICATE':
      return subject.data.issuedBy;
    case 'INVOICE_RIDE':
      // A tax document is not signed by a practitioner. Returning `null` rather
      // than reaching for «somebody» is what keeps a doctor's seal off an
      // invoice.
      return null;
  }
}

/**
 * DOC-014. What may be filed.
 *
 * ⚠️ THE LIST IS PER KIND AND IT IS AN ALLOWLIST. «Everything except DRAFT»
 * would file whatever state somebody adds next, and the state somebody adds
 * next is exactly the one nobody thought about.
 */
function assertIssuable(subject: DocumentSubject): void {
  switch (subject.kind) {
    case 'PRESCRIPTION':
      // A receta is a document from the moment it is issued. `CANCELLED` is
      // filed too: art. 70 annuls a receta that is in somebody's hand, and the
      // paper that has to be produced during a control is that one.
      if (!['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(subject.data.status)) {
        throw new DocumentSubjectNotIssuableError(subject.data.status);
      }
      return;
    case 'INVOICE_RIDE':
      // The RIDE of a `DRAFT` invoice has no sequential and no access key: it
      // is not a voucher, it is a quotation with the wrong title.
      if (subject.data.status === 'DRAFT') {
        throw new DocumentSubjectNotIssuableError(subject.data.status);
      }
      return;
    case 'SERVICE_ORDER':
    case 'MEDICAL_CERTIFICATE':
      // Both exist only once they have been written: there is no draft state
      // for either, so there is nothing to refuse.
      return;
  }
}
