import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedDocumentTemplates } from '../../prisma/seed-document-templates.mts';

import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * DOC-030, DOC-037. The development seed publishes version 1 of each class,
 * and running it again changes nothing — against the real table and its
 * `document_template_kind_version_unique`.
 */
describe('la semilla de plantillas de documentos', () => {
  const db = useDatabase();
  let prisma: PrismaClient;
  let publisherId: string;

  beforeEach(async () => {
    prisma = db();
    publisherId = (await createUser(prisma)).id;
  });

  it('DOC-030 publica la versión 1 de las cuatro clases, y dos pasadas no duplican nada', async () => {
    const first = await seedDocumentTemplates(prisma, publisherId);
    expect(first.published.sort()).toEqual([
      'INVOICE_RIDE',
      'MEDICAL_CERTIFICATE',
      'PRESCRIPTION',
      'SERVICE_ORDER',
    ]);

    const second = await seedDocumentTemplates(prisma, publisherId);
    expect(second.published).toEqual([]);

    const rows = await prisma.documentTemplate.findMany({
      select: { kind: true, version: true, accentColour: true },
    });
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.version === 1)).toBe(true);
    expect(rows.every((row) => row.accentColour === '#0f6b5c')).toBe(true);
  });

  it('DOC-031 no publica encima de lo que la clínica ya publicó', async () => {
    await prisma.documentTemplate.create({
      data: {
        kind: 'PRESCRIPTION',
        version: 1,
        accentColour: '#1f4e8c',
        publishedById: publisherId,
      },
    });

    const result = await seedDocumentTemplates(prisma, publisherId);

    expect(result.published).not.toContain('PRESCRIPTION');
    const prescription = await prisma.documentTemplate.findMany({
      where: { kind: 'PRESCRIPTION' },
    });
    expect(prescription).toHaveLength(1);
    expect(prescription[0]?.accentColour).toBe('#1f4e8c');
  });
});
