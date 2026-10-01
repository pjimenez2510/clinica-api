import { describe, expect, it } from 'vitest';

import { DocumentVerificationNotFoundError } from '../domain/document.errors';
import type {
  DocumentContext,
  DocumentSourceReader,
  DocumentSubject,
} from '../domain/document-source';
import type { VerificationFacts } from '../domain/document-verification';
import { DocumentVerificationService } from './document-verification.service';

/** DOC-094, DOC-096. The public verification, against a double of its port. */
class FakeSources implements DocumentSourceReader {
  readonly asked: string[] = [];
  constructor(private readonly facts: VerificationFacts | null) {}

  findSubject(): Promise<DocumentSubject | null> {
    return Promise.resolve(null);
  }
  contextForSite(): Promise<DocumentContext | null> {
    return Promise.resolve(null);
  }
  firstActiveSiteId(): Promise<string | null> {
    return Promise.resolve(null);
  }
  findForVerification(code: string): Promise<VerificationFacts | null> {
    this.asked.push(code);
    return Promise.resolve(this.facts);
  }
}

const facts: VerificationFacts = {
  kind: 'MEDICAL_CERTIFICATE',
  issuedAt: new Date(),
  annulled: false,
  annulledAt: null,
  establishmentName: 'Clínica Andina',
  siteName: 'Sede Norte',
  practitionerName: 'Jiménez Pablo',
};

describe('DocumentVerificationService', () => {
  it('DOC-094 responde lo que el lector encontró detrás del código', async () => {
    const sources = new FakeSources(facts);
    const answer = await new DocumentVerificationService(sources).verify(
      'A1B2C3D4E5F60718',
    );

    expect(answer).toMatchObject({
      kind: 'MEDICAL_CERTIFICATE',
      status: 'VALID',
      establishmentName: 'Clínica Andina',
    });
    expect(sources.asked).toEqual(['A1B2C3D4E5F60718']);
  });

  it('DOC-096 un código desconocido responde DOCUMENT_VERIFICATION_NOT_FOUND', async () => {
    await expect(
      new DocumentVerificationService(new FakeSources(null)).verify('ZZZZ9999'),
    ).rejects.toThrow(DocumentVerificationNotFoundError);
  });

  it('DOC-096 un código sin forma de código se responde igual, sin consultar nada', async () => {
    const sources = new FakeSources(facts);
    await expect(
      new DocumentVerificationService(sources).verify('../../etc'),
    ).rejects.toThrow(DocumentVerificationNotFoundError);
    expect(sources.asked).toEqual([]);
  });
});
