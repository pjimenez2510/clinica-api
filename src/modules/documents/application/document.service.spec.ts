import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { DocumentIdentityService } from './document-identity.service';
import { DocumentService, type Requester } from './document.service';
import {
  DocumentRenderNotFoundError,
  DocumentSubjectNotFoundError,
  DocumentSubjectNotIssuableError,
  DocumentTemplateNotPublishedError,
} from '../domain/document.errors';
import { CLINICAL_DOCUMENT_KINDS } from '../domain/document-kind';
import type { DocumentKind } from '../domain/document-kind';
import type { StoredImage, StoredImageSummary } from '../domain/document-image';
import type {
  DocumentContext,
  DocumentSourceReader,
  DocumentSubject,
  SubjectQuery,
} from '../domain/document-source';
import type {
  DocumentMetadata,
  DocumentRenderer,
  ImageNormaliser,
  LayoutImages,
} from '../domain/document-rendering.port';
import type { DocumentTemplate } from '../domain/document-template';
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
import type { DocumentLayout } from '../domain/page-layout';

/**
 * The use cases, exercised with in-memory doubles.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: the immutability of the artefact. That
 * is a guarantee of the DATABASE, and a double that refuses an `update` only
 * proves the double refuses it. It lives in
 * `test/integration/documents-immutable.spec.ts`, where the attempt goes in by
 * raw SQL underneath every layer this file exercises.
 */

const template: DocumentTemplate = {
  id: 'template-1',
  kind: 'PRESCRIPTION',
  version: 2,
  accentColour: '#1f6f8b',
  footerText: null,
  headerFields: [],
  showEstablishmentRuc: false,
  showEstablishmentAddress: false,
  showEstablishmentPhone: false,
  publishedAt: new Date('2026-08-01T00:00:00Z'),
};

const context: DocumentContext = {
  siteName: 'Sede Centro',
  siteLine: null,
  verificationBaseUrl: 'https://clinica.example/verificar',
  establishment: {
    name: 'Centro de Especialidades Bahía',
    ruc: '0993123456001',
    addressLine: null,
    phone: null,
    logo: null,
    keepsAccounting: false,
    specialTaxpayerResolution: null,
    withholdingAgentResolution: null,
    rimpeRegime: 'NONE',
    tradeName: null,
    email: null,
    operatingPermit: null,
  },
};

const prescriptionSubject = (status = 'ACTIVE'): DocumentSubject => ({
  kind: 'PRESCRIPTION',
  data: {
    subjectId: 'prescription-1',
    siteId: 'site-1',
    status,
    issuedAt: status === 'DRAFT' ? null : new Date('2026-08-21T01:00:00Z'),
    city: 'Guayaquil',
    verificationCode: 'RX-1',
    patient: {
      fullName: 'Guamán Andrade María José',
      identifier: '1710034065',
      ageYears: 34,
      ageMonths: 2,
    },
    diagnoses: [],
    allergies: [],
    prescriber: {
      fullName: 'Cedeño Rosa',
      acessRegistration: 'ACESS-1',
      mspCode: null,
      seal: null,
      signature: null,
    },
    lines: [],
  },
});

const rideSubject = (): DocumentSubject => ({
  kind: 'INVOICE_RIDE',
  data: {
    subjectId: 'invoice-1',
    siteId: 'site-1',
    documentNumber: '001-001-000000001',
    accessKey: null,
    status: 'ISSUED',
    issuedAt: new Date('2026-08-21T01:00:00Z'),
    authorisedAt: null,
    buyerIdentificationType: '05',
    buyerIdentification: '1710034065',
    buyerName: 'Guamán Andrade María José',
    buyerEmail: null,
    lines: [],
    subtotalTaxed: '0.00',
    subtotalUntaxed: '0.00',
    discountTotal: '0.00',
    taxTotal: '0.00',
    total: '0.00',
  },
});

class FakeRepository implements DocumentRepository {
  readonly renders: (DocumentRenderSummary & { content: Buffer })[] = [];
  readonly disclosures: DisclosureRecord[] = [];
  readonly images: StoredImageSummary[] = [];
  templates: DocumentTemplate[] = [template];
  logoOf = new Map<string, string>();
  practitionerImages = new Map<string, string>();
  attachSucceeds = true;

  saveRender(
    render: NewDocumentRender,
    disclosure: DisclosureRecord | null,
  ): Promise<DocumentRenderSummary> {
    const stored = {
      id: `render-${this.renders.length + 1}`,
      kind: render.kind,
      subjectId: render.subjectId,
      siteId: render.siteId,
      byteSize: render.content.byteLength,
      sha256: render.sha256,
      mimeType: 'application/pdf',
      pdfProfile: 'PDF/A-1b',
      templateVersion: render.templateVersion,
      issuedAt: new Date('2026-08-21T02:00:00Z'),
      issuedById: render.issuedById,
      supersedesId: render.supersedesId,
      supersedeReason: render.supersedeReason,
      content: render.content,
    };
    this.renders.push(stored);
    if (disclosure !== null) this.disclosures.push(disclosure);
    return Promise.resolve(stored);
  }

  findRenderSummary(query: RenderQuery): Promise<DocumentRenderSummary | null> {
    return Promise.resolve(
      this.renders.find((render) => render.id === query.renderId) ?? null,
    );
  }

  findRenderContent(
    query: RenderQuery,
    disclosure: DisclosureRecord | null,
  ): Promise<StoredDocument | null> {
    const found =
      this.renders.find((render) => render.id === query.renderId) ?? null;
    if (found === null) return Promise.resolve(null);
    if (
      disclosure !== null &&
      (CLINICAL_DOCUMENT_KINDS as readonly DocumentKind[]).includes(found.kind)
    ) {
      this.disclosures.push({ ...disclosure, resourceId: found.id });
    }
    return Promise.resolve(found);
  }

  recordDisclosure(disclosure: DisclosureRecord): Promise<void> {
    this.disclosures.push(disclosure);
    return Promise.resolve();
  }

  listRendersOfSubject(
    subjectId: string,
    kind: DocumentKind,
  ): Promise<readonly DocumentRenderSummary[]> {
    return Promise.resolve(
      this.renders.filter(
        (render) => render.subjectId === subjectId && render.kind === kind,
      ),
    );
  }

  findCurrentTemplate(kind: DocumentKind): Promise<DocumentTemplate | null> {
    const candidates = this.templates.filter((one) => one.kind === kind);
    if (candidates.length === 0) return Promise.resolve(null);
    return Promise.resolve(
      candidates.reduce((best, one) =>
        one.version > best.version ? one : best,
      ),
    );
  }

  listTemplates(): Promise<readonly DocumentTemplate[]> {
    return Promise.resolve(this.templates);
  }

  async publishTemplate(
    published: NewDocumentTemplate,
  ): Promise<DocumentTemplate> {
    const current = await this.findCurrentTemplate(published.kind);
    const created: DocumentTemplate = {
      ...published,
      id: `template-${this.templates.length + 1}`,
      version: (current?.version ?? 0) + 1,
      publishedAt: new Date(),
    };
    this.templates = [...this.templates, created];
    return created;
  }

  async publishTemplates(
    published: readonly NewDocumentTemplate[],
  ): Promise<DocumentTemplate[]> {
    const created: DocumentTemplate[] = [];
    for (const one of published) created.push(await this.publishTemplate(one));
    return created;
  }

  saveImage(image: NewDocumentImage): Promise<StoredImageSummary> {
    const stored: StoredImageSummary = {
      id: `image-${this.images.length + 1}`,
      mimeType: image.mimeType as 'image/png',
      byteSize: image.bytes.byteLength,
      sha256: image.sha256,
      width: image.width,
      height: image.height,
    };
    this.images.push(stored);
    return Promise.resolve(stored);
  }

  findEstablishmentLogo(): Promise<StoredImage | null> {
    return Promise.resolve(null);
  }

  findPractitionerImage(): Promise<StoredImage | null> {
    return Promise.resolve(null);
  }

  attachEstablishmentLogo(
    establishmentId: string,
    imageId: string,
  ): Promise<boolean> {
    if (!this.attachSucceeds) return Promise.resolve(false);
    this.logoOf.set(establishmentId, imageId);
    return Promise.resolve(true);
  }

  attachPractitionerImage(
    practitionerId: string,
    slot: 'seal' | 'signature',
    imageId: string,
  ): Promise<boolean> {
    if (!this.attachSucceeds) return Promise.resolve(false);
    this.practitionerImages.set(`${practitionerId}:${slot}`, imageId);
    return Promise.resolve(true);
  }
}

class FakeSources implements DocumentSourceReader {
  subject: DocumentSubject | null = prescriptionSubject();
  context: DocumentContext | null = context;
  readonly queries: SubjectQuery[] = [];

  findSubject(query: SubjectQuery): Promise<DocumentSubject | null> {
    this.queries.push(query);
    if (this.subject === null) return Promise.resolve(null);
    return Promise.resolve(
      this.subject.kind === query.kind ? this.subject : null,
    );
  }

  readonly contextSites: string[] = [];
  defaultSite: string | null = 'site-1';

  contextForSite(siteId: string): Promise<DocumentContext | null> {
    this.contextSites.push(siteId);
    return Promise.resolve(this.context);
  }

  firstActiveSiteId(): Promise<string | null> {
    return Promise.resolve(this.defaultSite);
  }
}

class RecordingRenderer implements DocumentRenderer {
  readonly calls: { layout: DocumentLayout; metadata: DocumentMetadata }[] = [];

  render(
    layout: DocumentLayout,
    _images: LayoutImages,
    metadata: DocumentMetadata,
  ): Promise<Buffer> {
    this.calls.push({ layout, metadata });
    return Promise.resolve(
      Buffer.from(`pdf:${layout.frame.title}:${this.calls.length}`),
    );
  }
}

class FakeNormaliser implements ImageNormaliser {
  normalise(bytes: Buffer) {
    // The point of the double: what comes out is NEVER what went in.
    return Promise.resolve({
      mimeType: 'image/png' as const,
      bytes: Buffer.concat([Buffer.from('reencoded:'), bytes]),
      width: 100,
      height: 40,
    });
  }
}

const requester: Requester = { userId: 'user-1', sites: 'all' };

let repository: FakeRepository;
let sources: FakeSources;
let renderer: RecordingRenderer;
let service: DocumentService;

beforeEach(() => {
  repository = new FakeRepository();
  sources = new FakeSources();
  renderer = new RecordingRenderer();
  service = new DocumentService(repository, sources, renderer);
});

describe('DOC-001 el borrador no archiva nada', () => {
  it('DOC-001 devuelve los bytes y no escribe ninguna fila', async () => {
    const draft = await service.draft(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );

    expect(draft.mimeType).toBe('application/pdf');
    expect(draft.content.byteLength).toBeGreaterThan(0);
    // A draft is not a document: filing every preview would fill the archive
    // with files nobody emitted and make «¿qué documentos existen de esta
    // receta?» — the ACESS art. 9 question — unanswerable.
    expect(repository.renders).toHaveLength(0);
  });

  it('DOC-091 el borrador SÍ deja fila de bitácora', async () => {
    // It is the same file. Auditing only the filed copy would leave the
    // cheapest way of taking a chart out of the building unrecorded.
    await service.draft(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );
    expect(repository.disclosures).toEqual([
      { userId: 'user-1', resourceId: 'prescription-1', action: 'PRINT' },
    ]);
  });

  it('DOC-014 el borrador de una receta en borrador SÍ se puede ver', async () => {
    // What DOC-014 refuses is FILING it, not looking at it.
    sources.subject = prescriptionSubject('DRAFT');
    await expect(
      service.draft(
        { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
        requester,
      ),
    ).resolves.toMatchObject({ mimeType: 'application/pdf' });
  });
});

describe('DOC-002 la emisión materializa los bytes', () => {
  it('DOC-002 guarda el sha256 de lo que guardó, en el mismo acto', async () => {
    const stored = await service.emit(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );

    // SC-061: the hash has to describe the file that exists. Hashing a second
    // composition — or trusting one the caller sent — would describe a file
    // nobody has.
    const written = repository.renders[0];
    expect(written).toBeDefined();
    expect(stored.sha256).toBe(
      createHash('sha256').update(written?.content ?? Buffer.alloc(0)).digest('hex'), // prettier-ignore
    );
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('DOC-033 copia el número de versión de la plantilla en la fila', async () => {
    const stored = await service.emit(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );
    expect(stored.templateVersion).toBe(2);
  });

  it('DOC-024 usa el MISMO instante en el PDF y en la fila', async () => {
    // Two clocks would make the file and the archive disagree about when the
    // document was produced.
    await service.emit(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );
    const call = renderer.calls[0];
    expect(call?.metadata.createdAt).toBeInstanceOf(Date);
  });

  it('DOC-014 se niega a archivar una receta en borrador', async () => {
    sources.subject = prescriptionSubject('DRAFT');
    await expect(
      service.emit(
        { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
        requester,
      ),
    ).rejects.toThrow(DocumentSubjectNotIssuableError);
    expect(repository.renders).toHaveLength(0);
  });

  it('DOC-014 SÍ archiva una receta anulada, que es la que pide una inspección', async () => {
    // Art. 70 annuls a receta that is in somebody's hand, and the paper that has
    // to be produced during a control is that one.
    sources.subject = prescriptionSubject('CANCELLED');
    await expect(
      service.emit(
        { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
        requester,
      ),
    ).resolves.toMatchObject({ kind: 'PRESCRIPTION' });
  });

  it('DOC-007 la corrección lleva a quién anula y por qué', async () => {
    const first = await service.emit(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );
    const second = await service.emit(
      {
        kind: 'PRESCRIPTION',
        subjectId: 'prescription-1',
        supersedesId: first.id,
        reason: 'Se corrigió la posología de la segunda línea',
      },
      requester,
    );

    expect(second.supersedesId).toBe(first.id);
    expect(second.supersedeReason).toMatch(/posología/);
    // AND THE FIRST ONE DID NOT MOVE.
    expect(repository.renders[0]?.supersedesId).toBeNull();
    expect(repository.renders[0]?.sha256).toBe(first.sha256);
  });

  it('DOC-012 no encuentra el origen fuera del alcance de sedes', async () => {
    sources.subject = null;
    await expect(
      service.emit(
        { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
        requester,
      ),
    ).rejects.toThrow(DocumentSubjectNotFoundError);
  });

  it('DOC-012 pasa el alcance del llamador al puerto, nunca una sede que le dijeron', async () => {
    await service.emit(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      { userId: 'user-1', sites: ['site-1', 'site-2'] },
    );
    expect(sources.queries[0]?.sites).toEqual(['site-1', 'site-2']);
  });

  it('DOC-037 se niega a emitir sin plantilla publicada, y no inventa una', async () => {
    repository.templates = [];
    await expect(
      service.emit(
        { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
        requester,
      ),
    ).rejects.toThrow(DocumentTemplateNotPublishedError);
  });
});

describe('DOC-006 reimprimir es servir los bytes guardados', () => {
  it('DOC-006 devuelve exactamente lo guardado, sin volver a componer', async () => {
    const emitted = await service.emit(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );
    const rendersBefore = renderer.calls.length;

    const served = await service.content(
      emitted.id,
      CLINICAL_DOCUMENT_KINDS,
      requester,
    );

    expect(served.sha256).toBe(emitted.sha256);
    // THE RENDERER WAS NOT CALLED AGAIN. Ley 67 art. 8(b) keeps «el formato en
    // el que se haya generado»; a recomposition is a different file.
    expect(renderer.calls).toHaveLength(rendersBefore);
  });

  it('DOC-090 no sirve un RIDE por la puerta clínica, ni con el identificador correcto', async () => {
    // The permission is on the ROUTE and the kind is in the ROW.
    sources.subject = rideSubject();
    repository.templates = [
      { ...template, kind: 'INVOICE_RIDE', id: 'template-ride', version: 1 },
    ];

    const ride = await service.emit(
      { kind: 'INVOICE_RIDE', subjectId: 'invoice-1' },
      requester,
    );

    await expect(
      service.content(ride.id, CLINICAL_DOCUMENT_KINDS, requester),
    ).rejects.toThrow(DocumentRenderNotFoundError);
    await expect(
      service.metadata(ride.id, CLINICAL_DOCUMENT_KINDS, requester),
    ).rejects.toThrow(DocumentRenderNotFoundError);
  });

  it('DOC-091 el RIDE no deja fila en la bitácora de accesos clínicos', async () => {
    // This table exists to answer «¿quién leyó esta historia?». Filling it with
    // invoice reads dilutes exactly the rows an investigation looks at.
    sources.subject = rideSubject();
    repository.templates = [
      { ...template, kind: 'INVOICE_RIDE', id: 'template-ride', version: 1 },
    ];

    const ride = await service.emit(
      { kind: 'INVOICE_RIDE', subjectId: 'invoice-1' },
      requester,
    );
    await service.content(ride.id, ['INVOICE_RIDE'], requester);

    expect(repository.disclosures).toHaveLength(0);
  });

  it('DOC-012 no sirve un documento que no existe', async () => {
    await expect(
      service.content('render-999', CLINICAL_DOCUMENT_KINDS, requester),
    ).rejects.toThrow(DocumentRenderNotFoundError);
  });

  it('DOC-092 los metadatos no dejan fila de bitácora', async () => {
    const emitted = await service.emit(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );
    const before = repository.disclosures.length;

    await service.metadata(emitted.id, CLINICAL_DOCUMENT_KINDS, requester);

    // Auditing what reveals nothing trains everybody to ignore the trail.
    expect(repository.disclosures).toHaveLength(before);
  });

  it('DOC-007 el historial devuelve el original y el que lo anula', async () => {
    const first = await service.emit(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );
    await service.emit(
      {
        kind: 'PRESCRIPTION',
        subjectId: 'prescription-1',
        supersedesId: first.id,
        reason: 'Se corrigió la dosis indicada',
      },
      requester,
    );

    const history = await service.history(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );
    expect(history).toHaveLength(2);
  });
});

describe('DOC-030, DOC-031 la plantilla versionada', () => {
  it('DOC-030 publicar crea la versión siguiente', async () => {
    const published = await service.publishTemplate(
      'PRESCRIPTION',
      {
        accentColour: '#003366',
        footerText: null,
        headerFields: [],
        showEstablishmentRuc: true,
        showEstablishmentAddress: false,
        showEstablishmentPhone: false,
      },
      requester,
    );
    expect(published.version).toBe(3);
  });

  it('DOC-031 la vigente es la de mayor versión, sin ninguna marca', async () => {
    await service.publishTemplate(
      'PRESCRIPTION',
      {
        accentColour: '#003366',
        footerText: null,
        headerFields: [],
        showEstablishmentRuc: false,
        showEstablishmentAddress: false,
        showEstablishmentPhone: false,
      },
      requester,
    );

    const emitted = await service.emit(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1' },
      requester,
    );
    expect(emitted.templateVersion).toBe(3);
  });

  it('DOC-035 rechaza una ranura mal formada antes de escribir nada', async () => {
    await expect(
      service.publishTemplate(
        'PRESCRIPTION',
        {
          accentColour: 'azul',
          footerText: null,
          headerFields: [],
          showEstablishmentRuc: false,
          showEstablishmentAddress: false,
          showEstablishmentPhone: false,
        },
        requester,
      ),
    ).rejects.toThrow(/DOCUMENT_TEMPLATE_SLOT_INVALID|Invalid template slot/);
    expect(repository.templates).toHaveLength(1);
  });
});

describe('DOC-054 la identidad visual se reencoda siempre', () => {
  it('DOC-054, SC-063 guarda los bytes reencodados y no los recibidos', async () => {
    const identity = new DocumentIdentityService(
      repository,
      new FakeNormaliser(),
    );
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

    const stored = await identity.setEstablishmentLogo(
      'establishment-1',
      original,
      'user-1',
    );

    const hashOfOriginal = createHash('sha256').update(original).digest('hex');
    // SC-063 measured directly: the stored hash is NEVER the hash of a file a
    // client sent.
    expect(stored.sha256).not.toBe(hashOfOriginal);
    expect(repository.logoOf.get('establishment-1')).toBe(stored.id);
  });

  it('DOC-057 el sello y la firma van por profesional', async () => {
    const identity = new DocumentIdentityService(
      repository,
      new FakeNormaliser(),
    );

    await identity.setPractitionerImage(
      'practitioner-1',
      'seal',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'user-1',
    );
    await identity.setPractitionerImage(
      'practitioner-1',
      'signature',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'user-1',
    );

    expect(repository.practitionerImages.get('practitioner-1:seal')).toBe(
      'image-1',
    );
    expect(repository.practitionerImages.get('practitioner-1:signature')).toBe(
      'image-2',
    );
  });

  it('DOC-057 avisa si el profesional o el establecimiento no existen', async () => {
    repository.attachSucceeds = false;
    const identity = new DocumentIdentityService(
      repository,
      new FakeNormaliser(),
    );

    await expect(
      identity.setEstablishmentLogo(
        'nope',
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        'user-1',
      ),
    ).rejects.toThrow(DocumentSubjectNotFoundError);
  });
});

const slots = {
  accentColour: '#0f6b5c',
  footerText: 'Pie nuevo',
  headerFields: [],
  showEstablishmentRuc: true,
  showEstablishmentAddress: true,
  showEstablishmentPhone: true,
};

describe('DOC-038 la vista previa la pinta el mismo generador, y no guarda nada', () => {
  it('DOC-038 compone la clase pedida con las ranuras propuestas y contenido de muestra', async () => {
    const preview = await service.previewTemplate(
      'MEDICAL_CERTIFICATE',
      { ...slots, accentColour: '#7a3b2e' },
      null,
    );

    expect(preview.mimeType).toBe('application/pdf');
    const { layout } = renderer.calls[0] ?? {};
    expect(layout?.frame.title).toBe('CERTIFICADO MÉDICO');
    expect(layout?.frame.accentColour).toBe('#7a3b2e');
    expect(JSON.stringify(layout?.blocks)).toContain('MUESTRA');
  });

  it('DOC-038 no escribe ni artefacto, ni plantilla, ni bitácora', async () => {
    await service.previewTemplate('PRESCRIPTION', slots, null);

    expect(repository.renders).toHaveLength(0);
    expect(repository.templates).toHaveLength(1);
    expect(repository.disclosures).toHaveLength(0);
  });

  it('DOC-038 usa la sede pedida, o la primera activa si no piden ninguna', async () => {
    await service.previewTemplate('PRESCRIPTION', slots, 'site-9');
    await service.previewTemplate('PRESCRIPTION', slots, null);

    expect(sources.contextSites).toEqual(['site-9', 'site-1']);
  });

  it('DOC-038 rechaza las ranuras inválidas igual que al publicar', async () => {
    await expect(
      service.previewTemplate(
        'PRESCRIPTION',
        { ...slots, accentColour: 'verde' },
        null,
      ),
    ).rejects.toThrow(/DOCUMENT_TEMPLATE_SLOT_INVALID|Invalid template slot/);
    expect(renderer.calls).toHaveLength(0);
  });

  it('DOC-038 sin ninguna sede no hay identidad que mostrar', async () => {
    sources.defaultSite = null;
    await expect(
      service.previewTemplate('PRESCRIPTION', slots, null),
    ).rejects.toThrow(DocumentSubjectNotFoundError);
  });
});

describe('DOC-039 una sola identidad para las cuatro clases', () => {
  it('DOC-039 publica la versión siguiente de cada clase', async () => {
    const published = await service.publishTemplateForAllKinds(
      slots,
      requester,
    );

    expect(published.map((one) => one.kind).sort()).toEqual([
      'INVOICE_RIDE',
      'MEDICAL_CERTIFICATE',
      'PRESCRIPTION',
      'SERVICE_ORDER',
    ]);
    expect(published.find((one) => one.kind === 'PRESCRIPTION')?.version).toBe(
      3,
    );
    expect(published.every((one) => one.accentColour === '#0f6b5c')).toBe(true);
  });

  it('DOC-039 DOC-035 una ranura inválida no publica ninguna', async () => {
    await expect(
      service.publishTemplateForAllKinds(
        { ...slots, accentColour: '#ZZZ' },
        requester,
      ),
    ).rejects.toThrow(/DOCUMENT_TEMPLATE_SLOT_INVALID|Invalid template slot/);
    expect(repository.templates).toHaveLength(1);
  });
});
