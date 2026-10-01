import { Inject, Injectable } from '@nestjs/common';

import {
  DOCUMENT_SOURCE_READER,
  type DocumentSourceReader,
} from '../domain/document-source';
import { DocumentVerificationNotFoundError } from '../domain/document.errors';
import {
  VERIFICATION_CODE,
  toVerification,
  type DocumentVerification,
} from '../domain/document-verification';

/**
 * DOC-094 to DOC-096. The public answer to «¿este documento es auténtico?».
 *
 * A SERVICE OF ITS OWN (ADR-008 §2): it is the only thing in this module that
 * answers someone without a session, it shares nothing with emitting or with
 * the identity, and it changes for a different reason — what the public may
 * read, which is D-096.
 */
@Injectable()
export class DocumentVerificationService {
  constructor(
    @Inject(DOCUMENT_SOURCE_READER)
    private readonly sources: DocumentSourceReader,
  ) {}

  /** DOC-096. A malformed code and an unknown one get the same answer. */
  async verify(code: string): Promise<DocumentVerification> {
    if (!VERIFICATION_CODE.test(code)) {
      throw new DocumentVerificationNotFoundError();
    }
    const facts = await this.sources.findForVerification(code);
    if (facts === null) throw new DocumentVerificationNotFoundError();
    return toVerification(facts);
  }
}
