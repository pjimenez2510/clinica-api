import { describe, expect, it, vi } from 'vitest';

import { pruneToAllowlist } from '../../../shared/observability/log-privacy';

import { AnnulledDocumentArchiverService } from './annulled-document.archiver';
import type { DocumentService } from './document.service';

/**
 * DOC-109. The port other modules call after annulling: it files the PDF that
 * replaces the current one, and NEVER makes the annulment fail.
 */
function archiverWith(
  archiveReplacement: DocumentService['archiveReplacement'],
) {
  const warn = vi.fn();
  const archiver = new AnnulledDocumentArchiverService(
    { archiveReplacement } as unknown as DocumentService,
    { setContext: vi.fn(), warn, info: vi.fn() } as never,
  );
  return { archiver, warn };
}

const ANNULLED = {
  kind: 'PRESCRIPTION' as const,
  subjectId: 'prescription-1',
  userId: 'user-1',
  cause: 'ANNULMENT' as const,
};

describe('DOC-109 el archivo del PDF anulado no frena la anulación', () => {
  it('DOC-109 archiva a nombre de quien anuló, con la causa, sin mirar sedes (control positivo)', async () => {
    const archive = vi.fn().mockResolvedValue({ id: 'render-2' });
    const { archiver, warn } = archiverWith(archive);

    await expect(archiver.archiveAnnulled(ANNULLED)).resolves.toBe(true);
    expect(archive).toHaveBeenCalledWith(
      { kind: 'PRESCRIPTION', subjectId: 'prescription-1', cause: 'ANNULMENT' },
      { userId: 'user-1', sites: 'all' },
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('DOC-109 sin PDF que sustituir responde null: no había nada que archivar, y no es un fallo', async () => {
    const { archiver, warn } = archiverWith(vi.fn().mockResolvedValue(null));
    await expect(archiver.archiveAnnulled(ANNULLED)).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('DOC-109 si el PDF falla, no lanza: lo deja en el registro sin datos del paciente', async () => {
    const { archiver, warn } = archiverWith(
      vi.fn().mockRejectedValue(new Error('render failed for María Guamán')),
    );

    await expect(archiver.archiveAnnulled(ANNULLED)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('María');
  });

  it('DOC-109 el registro del fallo dice qué sujeto y de qué clase, con el nombre del error, y sobrevive a la poda', async () => {
    const { archiver, warn } = archiverWith(
      vi.fn().mockRejectedValue(new TypeError('font of María Guamán missing')),
    );

    await archiver.archiveAnnulled(ANNULLED);

    const entry = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    // What reaches disk is what the allowlist keeps: a key it drops is a
    // field nobody will ever read.
    expect(pruneToAllowlist(entry)).toEqual({
      action: 'ANNULLED_DOCUMENT_NOT_ARCHIVED',
      subject_id: 'prescription-1',
      document_type: 'PRESCRIPTION',
      type: 'TypeError',
    });
  });

  it('DOC-109 si el fallo es de Prisma, registra su código y no su mensaje', async () => {
    const prismaError = Object.assign(
      new Error('Unique constraint failed on María Guamán'),
      { name: 'PrismaClientKnownRequestError', code: 'P2002' },
    );
    const { archiver, warn } = archiverWith(
      vi.fn().mockRejectedValue(prismaError),
    );

    await expect(archiver.archiveAnnulled(ANNULLED)).resolves.toBe(false);

    const entry = pruneToAllowlist(warn.mock.calls[0]?.[0]);
    expect(entry).toEqual({
      action: 'ANNULLED_DOCUMENT_NOT_ARCHIVED',
      subject_id: 'prescription-1',
      document_type: 'PRESCRIPTION',
      type: 'PrismaClientKnownRequestError',
      error_code: 'P2002',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('María');
  });
});
