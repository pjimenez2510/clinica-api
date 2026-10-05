import { describe, expect, it, vi } from 'vitest';

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

  it('DOC-109 sin PDF que sustituir responde que no archivó nada', async () => {
    const { archiver } = archiverWith(vi.fn().mockResolvedValue(null));
    await expect(archiver.archiveAnnulled(ANNULLED)).resolves.toBe(false);
  });

  it('DOC-109 si el PDF falla, no lanza: lo deja en el registro sin datos del paciente', async () => {
    const { archiver, warn } = archiverWith(
      vi.fn().mockRejectedValue(new Error('render failed for María Guamán')),
    );

    await expect(archiver.archiveAnnulled(ANNULLED)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('María');
  });
});
