import { createHash, randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import '../../src/modules/documents/infrastructure/documents.constraints';
import { PrismaDocumentRepository } from '../../src/modules/documents/infrastructure/prisma-document.repository';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MOST IMPORTANT TEST OF THIS MODULE: AN EMITTED DOCUMENT DOES NOT MOVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * D-A-014. Ley 67 de Comercio Electrónico art. 7 requires being able to show
 * that a data message «ha conservado la integridad de la información … desde
 * que se generó en su forma definitiva», and art. 8(b) that it is kept «con el
 * formato en el que se haya generado». An `UPDATE` nobody prevents makes that
 * claim impossible to assert — not for the row that changed, but for EVERY row,
 * because nothing distinguishes them.
 *
 * WHICH IS WHY EVERY ATTEMPT BELOW GOES IN BY RAW SQL, UNDERNEATH EVERY LAYER
 * THE APPLICATION HAS. A test that called a repository method would only prove
 * that the method does not exist — which is DOC-011 and a different claim. This
 * one is that the row cannot change even for somebody with a `psql` prompt.
 *
 * And each one asserts TWICE: that the statement was refused, AND that the row
 * did not move. Asserting only the rejection would pass even if a later trigger
 * had let a partial write through.
 */
const db = useDatabase();

interface Context {
  prisma: PrismaClient;
  documents: PrismaDocumentRepository;
  siteId: string;
  prescriptionId: string;
  otherPrescriptionId: string;
  templateId: string;
  userId: string;
}

let context: Context;

const PDF = Buffer.from('%PDF-1.4\nfake artefact for the archive\n%%EOF\n');
const sha256Of = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

beforeEach(async () => {
  const prisma = db();

  const site = await createSite(prisma);
  const patient = await createPatient(prisma);
  const practitioner = await createPractitioner(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });

  const user = await prisma.user.create({
    data: {
      email: `documentos${Date.now()}@clinica.ec`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Rosa',
      lastName: 'Cedeño',
    },
  });

  const prescription = await prisma.prescription.create({
    data: {
      encounterId: encounter.id,
      prescriberId: practitioner.id,
      status: 'ACTIVE',
      issuedAt: new Date('2026-08-21T01:00:00Z'),
    },
  });
  const otherPrescription = await prisma.prescription.create({
    data: {
      encounterId: encounter.id,
      prescriberId: practitioner.id,
      status: 'ACTIVE',
      issuedAt: new Date('2026-08-21T02:00:00Z'),
    },
  });

  const template = await prisma.documentTemplate.create({
    data: {
      kind: 'PRESCRIPTION',
      version: 1,
      accentColour: '#1f6f8b',
      publishedById: user.id,
    },
  });

  context = {
    prisma,
    documents: new PrismaDocumentRepository(prisma as unknown as PrismaService),
    siteId: site.id,
    prescriptionId: prescription.id,
    otherPrescriptionId: otherPrescription.id,
    templateId: template.id,
    userId: user.id,
  };
});

async function emit(
  overrides: {
    subjectId?: string;
    supersedesId?: string | null;
    supersedeReason?: string | null;
    content?: Buffer;
  } = {},
) {
  const content = overrides.content ?? PDF;
  return context.documents.saveRender(
    {
      kind: 'PRESCRIPTION',
      templateId: context.templateId,
      templateVersion: 1,
      subjectId: overrides.subjectId ?? context.prescriptionId,
      siteId: context.siteId,
      content,
      sha256: sha256Of(content),
      issuedById: context.userId,
      supersedesId: overrides.supersedesId ?? null,
      supersedeReason: overrides.supersedeReason ?? null,
    },
    {
      userId: context.userId,
      resourceId: overrides.subjectId ?? context.prescriptionId,
      action: 'CREATE',
    },
  );
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null).catch((error: unknown) => error);
}

describe('DOC-005 el artefacto emitido no se modifica ni se borra', () => {
  it('DOC-005 la base rechaza cambiar los BYTES de un documento archivado, por SQL directo', async () => {
    const render = await emit();

    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "document_render"
           SET "content" = '\\x00'::bytea, "byte_size" = 1
         WHERE "id" = ${render.id}::uuid`,
    );

    expect(rejection).not.toBeNull();
    expect(String((rejection as Error).message)).toMatch(
      /document_render is insert-only/,
    );

    // AND THE ROW DID NOT MOVE.
    const stored = await context.prisma.documentRender.findUniqueOrThrow({
      where: { id: render.id },
    });
    expect(Buffer.from(stored.content).equals(PDF)).toBe(true);
    expect(stored.byteSize).toBe(PDF.byteLength);
  });

  it('DOC-005 la base rechaza cambiar el sha256, que es la prueba de integridad', async () => {
    // The hash is the claim. If it could be rewritten to match altered bytes,
    // the archive would prove nothing at all.
    const render = await emit();

    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "document_render" SET "sha256" = ${'0'.repeat(64)}
         WHERE "id" = ${render.id}::uuid`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /document_render is insert-only/,
    );

    const stored = await context.prisma.documentRender.findUniqueOrThrow({
      where: { id: render.id },
    });
    expect(stored.sha256).toBe(sha256Of(PDF));
  });

  it('DOC-005 la base rechaza cambiar quién lo emitió y cuándo', async () => {
    const render = await emit();

    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "document_render"
           SET "issued_at" = CURRENT_TIMESTAMP, "issued_by_id" = ${context.userId}::uuid
         WHERE "id" = ${render.id}::uuid`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /document_render is insert-only/,
    );

    const stored = await context.prisma.documentRender.findUniqueOrThrow({
      where: { id: render.id },
    });
    expect(stored.issuedAt.getTime()).toBe(render.issuedAt.getTime());
  });

  it('DOC-005 la base rechaza BORRAR un documento archivado', async () => {
    const render = await emit();

    const rejection = await rejectionOf(
      context.prisma
        .$executeRaw`DELETE FROM "document_render" WHERE "id" = ${render.id}::uuid`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /document_render is insert-only/,
    );
    await expect(
      context.prisma.documentRender.findUnique({ where: { id: render.id } }),
    ).resolves.not.toBeNull();
  });

  it('DOC-005 la base rechaza VACIAR la tabla entera de un golpe', async () => {
    // TRUNCATE fires no FOR EACH ROW trigger at all: without its own statement
    // trigger, the whole archive of the clinic goes in one line.
    await emit();

    const rejection = await rejectionOf(
      context.prisma.$executeRawUnsafe('TRUNCATE TABLE "document_render"'),
    );

    expect(String((rejection as Error).message)).toMatch(
      /document_render is insert-only/,
    );
    await expect(context.prisma.documentRender.count()).resolves.toBe(1);
  });

  it('DOC-005 el rechazo llega como falta de privilegio y nombra la tabla', async () => {
    // `insufficient_privilege` (42501) and not a plain `raise_exception`: the
    // code is what an operator's tooling branches on, and «no tiene permiso
    // para tocar esta tabla» is exactly what happened. Whoever hits this at
    // 11 p.m. reads the message, not the catalog, so it names the table.
    const render = await emit();

    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "document_render" SET "byte_size" = 1
         WHERE "id" = ${render.id}::uuid`,
    );

    const message = String((rejection as Error).message);
    expect(message).toMatch(/42501/);
    expect(message).toMatch(/document_render/);
  });

  it('DOC-011 el repositorio no ofrece ningún método que lo intente', () => {
    // The other half of the guarantee: the trigger protects against a `psql`,
    // and the missing method protects against the button somebody would add
    // without reading the trigger.
    const surface = Object.getOwnPropertyNames(
      PrismaDocumentRepository.prototype,
    );
    expect(
      surface.filter((name) => /update|delete|remove/i.test(name)),
    ).toEqual([]);
  });
});

describe('DOC-007 a DOC-010 corregir es emitir otro que anula al anterior', () => {
  it('DOC-007 el nuevo declara a cuál anula y por qué, y el anterior no se toca', async () => {
    const first = await emit();
    const second = await emit({
      supersedesId: first.id,
      supersedeReason: 'Se corrigió la posología de la segunda línea',
    });

    expect(second.supersedesId).toBe(first.id);

    const original = await context.prisma.documentRender.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(original.sha256).toBe(first.sha256);
    expect(original.supersedesId).toBeNull();
  });

  it('DOC-008 la base rechaza que dos documentos anulen al mismo', async () => {
    // A chain that forks has no «current document», and two people would see
    // two final versions of the same act.
    const first = await emit();
    await emit({ supersedesId: first.id, supersedeReason: 'Primera corrección' }); // prettier-ignore

    const rejection = await rejectionOf(
      emit({ supersedesId: first.id, supersedeReason: 'Segunda corrección' }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_ALREADY_SUPERSEDED',
    );
  });

  it('DOC-009 la base rechaza anular el documento de OTRA receta', async () => {
    // Without this the RIDE of one invoice could declare that it annuls the
    // receta of another person — every foreign key satisfied — and the archive
    // would stop being able to answer «¿cuál es el documento vigente?».
    const first = await emit();

    const rejection = await rejectionOf(
      emit({
        subjectId: context.otherPrescriptionId,
        supersedesId: first.id,
        supersedeReason: 'Corrección cruzada que no debe existir',
      }),
    );

    expect(String((rejection as Error).message)).toMatch(
      /same kind and subject/,
    );
    await expect(context.prisma.documentRender.count()).resolves.toBe(1);
  });

  it('DOC-010 la base rechaza anular sin decir por qué', async () => {
    const first = await emit();

    const rejection = await rejectionOf(
      emit({ supersedesId: first.id, supersedeReason: null }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_SUPERSEDE_REASON_REQUIRED',
    );
  });

  it('DOC-010 la base rechaza un motivo sin documento anulado', async () => {
    const rejection = await rejectionOf(
      emit({ supersedesId: null, supersedeReason: 'Motivo sin anulación' }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_SUPERSEDE_REASON_REQUIRED',
    );
  });
});

describe('DOC-003, DOC-004 lo que la fila garantiza sobre sí misma', () => {
  it('DOC-003 la base rechaza un documento sin sujeto', async () => {
    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        INSERT INTO "document_render"
          ("kind", "template_id", "template_version", "site_id",
           "content", "byte_size", "sha256", "issued_by_id")
        VALUES ('PRESCRIPTION', ${context.templateId}::uuid, 1, ${context.siteId}::uuid,
                ${PDF}::bytea, ${PDF.byteLength}, ${sha256Of(PDF)}, ${context.userId}::uuid)`,
    );

    // EITHER constraint may fire: a row with no subject violates «exactly one»
    // and «the kind has its own column» at once, and PostgreSQL reports
    // whichever it evaluates first. Pinning one would make the test depend on
    // the order the constraints happen to be checked in.
    expect(String((rejection as Error).message)).toMatch(
      /document_render_one_subject|document_render_kind_matches_subject/,
    );
  });

  it('DOC-003 la base rechaza un documento con DOS sujetos', async () => {
    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        INSERT INTO "document_render"
          ("kind", "template_id", "template_version", "prescription_id",
           "invoice_id", "site_id", "content", "byte_size", "sha256", "issued_by_id")
        VALUES ('PRESCRIPTION', ${context.templateId}::uuid, 1,
                ${context.prescriptionId}::uuid, ${randomUUID()}::uuid,
                ${context.siteId}::uuid, ${PDF}::bytea, ${PDF.byteLength},
                ${sha256Of(PDF)}, ${context.userId}::uuid)`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /document_render_one_subject|document_render_invoice_fk/,
    );
  });

  it('DOC-003 la base rechaza una clase que no concuerda con su sujeto', async () => {
    // A row saying `INVOICE_RIDE` while pointing at a prescription satisfies
    // every foreign key and lies about what the file contains.
    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        INSERT INTO "document_render"
          ("kind", "template_id", "template_version", "prescription_id",
           "site_id", "content", "byte_size", "sha256", "issued_by_id")
        VALUES ('INVOICE_RIDE', ${context.templateId}::uuid, 1,
                ${context.prescriptionId}::uuid, ${context.siteId}::uuid,
                ${PDF}::bytea, ${PDF.byteLength}, ${sha256Of(PDF)}, ${context.userId}::uuid)`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /document_render_kind_matches_subject/,
    );
  });

  it('DOC-004 la base rechaza un tamaño que no concuerda con los bytes', async () => {
    // A `byte_size` that disagrees with the content is a `Content-Length` that
    // truncates the download.
    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        INSERT INTO "document_render"
          ("kind", "template_id", "template_version", "prescription_id",
           "site_id", "content", "byte_size", "sha256", "issued_by_id")
        VALUES ('PRESCRIPTION', ${context.templateId}::uuid, 1,
                ${context.prescriptionId}::uuid, ${context.siteId}::uuid,
                ${PDF}::bytea, 1, ${sha256Of(PDF)}, ${context.userId}::uuid)`,
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_CONTENT_INCONSISTENT',
    );
  });

  it('DOC-002 la base rechaza un sha256 en mayúsculas o de otro largo', async () => {
    // Uppercase would compare unequal to the same hash computed anywhere else,
    // which is the one thing this column must never do.
    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        INSERT INTO "document_render"
          ("kind", "template_id", "template_version", "prescription_id",
           "site_id", "content", "byte_size", "sha256", "issued_by_id")
        VALUES ('PRESCRIPTION', ${context.templateId}::uuid, 1,
                ${context.prescriptionId}::uuid, ${context.siteId}::uuid,
                ${PDF}::bytea, ${PDF.byteLength},
                ${sha256Of(PDF).toUpperCase()}, ${context.userId}::uuid)`,
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_SHA256_INVALID',
    );
  });

  it('DOC-002 el artefacto emitido y su fila de bitácora se escriben juntos', async () => {
    // DOC-091. If `access_audit` refused the row, the render would roll back
    // with it: an emission nobody can account for does not happen.
    const render = await emit();

    const trail = await context.prisma.accessAudit.findMany({
      where: { resourceType: 'document' },
    });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.action).toBe('CREATE');
    expect(trail[0]?.userId).toBe(context.userId);
    expect(render.byteSize).toBe(PDF.byteLength);
  });
});

describe('DOC-030 a DOC-032 la plantilla versionada', () => {
  it('DOC-032 la base rechaza modificar una versión de plantilla publicada', async () => {
    // A template version is what an archived document was produced with, so it
    // can never change: changing the letterhead is publishing version 2.
    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "document_template" SET "accent_colour" = '#000000'
         WHERE "id" = ${context.templateId}::uuid`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /document_template is insert-only/,
    );

    const stored = await context.prisma.documentTemplate.findUniqueOrThrow({
      where: { id: context.templateId },
    });
    expect(stored.accentColour).toBe('#1f6f8b');
  });

  it('DOC-031 la vigente es la de mayor versión, sin ninguna columna que lo marque', async () => {
    await context.documents.publishTemplate({
      kind: 'PRESCRIPTION',
      accentColour: '#003366',
      footerText: null,
      headerFields: [],
      showEstablishmentRuc: false,
      showEstablishmentAddress: false,
      showEstablishmentPhone: false,
      publishedById: context.userId,
    });

    const current = await context.documents.findCurrentTemplate('PRESCRIPTION');
    expect(current?.version).toBe(2);
    expect(current?.accentColour).toBe('#003366');
  });

  it('DOC-030 la base rechaza repetir clase y versión', async () => {
    const rejection = await rejectionOf(
      context.prisma.documentTemplate.create({
        data: {
          kind: 'PRESCRIPTION',
          version: 1,
          accentColour: '#123456',
          publishedById: context.userId,
        },
      }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_TEMPLATE_VERSION_TAKEN',
    );
  });

  it('DOC-035 la base rechaza un color de acento fuera de forma', async () => {
    const rejection = await rejectionOf(
      context.prisma.documentTemplate.create({
        data: {
          kind: 'SERVICE_ORDER',
          version: 1,
          accentColour: '#ABCDEF',
          publishedById: context.userId,
        },
      }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_TEMPLATE_COLOUR_INVALID',
    );
  });

  it('DOC-036 la base rechaza el séptimo campo de cabecera', async () => {
    const seven = Array.from({ length: 7 }, (_, index) => ({
      label: `Campo ${index}`,
      value: `Valor ${index}`,
    }));

    const rejection = await rejectionOf(
      context.prisma.documentTemplate.create({
        data: {
          kind: 'SERVICE_ORDER',
          version: 1,
          accentColour: '#123456',
          headerFields: seven,
          publishedById: context.userId,
        },
      }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_TEMPLATE_HEADER_FIELDS_INVALID',
    );
  });

  it('DOC-036 la base rechaza un campo de cabecera sin etiqueta', async () => {
    const rejection = await rejectionOf(
      context.prisma.documentTemplate.create({
        data: {
          kind: 'SERVICE_ORDER',
          version: 1,
          accentColour: '#123456',
          headerFields: [{ label: '', value: 'Valor' }],
          publishedById: context.userId,
        },
      }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_TEMPLATE_HEADER_FIELDS_INVALID',
    );
  });
});

describe('DOC-050 a DOC-058 la imagen guardada', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

  it('DOC-050 la base rechaza guardar un SVG, aunque nadie pase por el servicio', async () => {
    const rejection = await rejectionOf(
      context.prisma.documentImage.create({
        data: {
          mimeType: 'image/svg+xml',
          bytes: new Uint8Array(png),
          byteSize: png.byteLength,
          sha256: sha256Of(png),
          width: 10,
          height: 10,
          uploadedById: context.userId,
        },
      }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_IMAGE_FORMAT_STORED_NOT_ALLOWED',
    );
  });

  it('DOC-053 la base rechaza una bomba de descompresión', async () => {
    const rejection = await rejectionOf(
      context.prisma.documentImage.create({
        data: {
          mimeType: 'image/png',
          bytes: new Uint8Array(png),
          byteSize: png.byteLength,
          sha256: sha256Of(png),
          width: 30_000,
          height: 30_000,
          uploadedById: context.userId,
        },
      }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DOCUMENT_IMAGE_PIXELS_OUT_OF_BOUNDS',
    );
  });

  it('DOC-058 la base rechaza modificar una imagen ya guardada', async () => {
    // An image that changed underneath would change what a SEAL says with
    // nothing recording it — and art. 5 asks for the seal twice.
    const image = await context.documents.saveImage({
      mimeType: 'image/png',
      bytes: png,
      sha256: sha256Of(png),
      width: 10,
      height: 10,
      uploadedById: context.userId,
    });

    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "document_image" SET "width" = 999 WHERE "id" = ${image.id}::uuid`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /document_image is insert-only/,
    );
  });

  it('DOC-057 sustituir el sello es guardar otra fila y repuntar la referencia', async () => {
    const practitioner = await createPractitioner(context.prisma);

    const first = await context.documents.saveImage({
      mimeType: 'image/png',
      bytes: png,
      sha256: sha256Of(png),
      width: 10,
      height: 10,
      uploadedById: context.userId,
    });
    await context.documents.attachPractitionerImage(
      practitioner.id,
      'seal',
      first.id,
    );

    const replacement = Buffer.concat([png, Buffer.from([2])]);
    const second = await context.documents.saveImage({
      mimeType: 'image/png',
      bytes: replacement,
      sha256: sha256Of(replacement),
      width: 12,
      height: 12,
      uploadedById: context.userId,
    });
    await context.documents.attachPractitionerImage(
      practitioner.id,
      'seal',
      second.id,
    );

    const stored = await context.prisma.practitioner.findUniqueOrThrow({
      where: { id: practitioner.id },
    });
    expect(stored.sealImageId).toBe(second.id);
    // THE OLD ROW IS STILL THERE. Nothing in this module deletes.
    await expect(context.prisma.documentImage.count()).resolves.toBe(2);
  });
});
