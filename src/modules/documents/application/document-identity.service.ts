import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  IMAGE_NORMALISER,
  type ImageNormaliser,
} from '../domain/document-rendering.port';
import {
  DOCUMENT_REPOSITORY,
  type DocumentRepository,
} from '../domain/document.repository';
import {
  DocumentImageNotFoundError,
  DocumentSubjectNotFoundError,
} from '../domain/document.errors';
import type {
  ImageSlot,
  StoredImage,
  StoredImageSummary,
} from '../domain/document-image';

/**
 * DOC-050 to DOC-060. The clinic's visual identity: the establishment's logo
 * and the practitioner's seal and signature.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SERVICE OF ITS OWN, AND THAT IS ADR-008 §2 APPLIED RATHER THAN SYMMETRY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It crosses two of the three limits: it shares NO dependency with
 * `DocumentService` — no source reader, no renderer, no template — and it
 * changes for an entirely different reason. A logo is uploaded once a decade by
 * whoever administers the clinic; an artefact is emitted a hundred times a day
 * by whoever attends. Folding them together would put a hostile-input pipeline
 * inside the class that composes recetas.
 *
 * ⚠️ THE ORDER OF WHAT HAPPENS HERE IS THE DEFENCE, and it is worth reading
 * once: normalise FIRST — which caps the bytes, checks the magic numbers, caps
 * the pixels and re-encodes — and only then hash and store. Storing first and
 * validating afterwards would put an unexamined file in the database, where the
 * next reader has no way of knowing it was never checked.
 */
@Injectable()
export class DocumentIdentityService {
  constructor(
    @Inject(DOCUMENT_REPOSITORY)
    private readonly documents: DocumentRepository,
    @Inject(IMAGE_NORMALISER)
    private readonly images: ImageNormaliser,
  ) {}

  /** DOC-057. The establishment's logo. */
  async setEstablishmentLogo(
    establishmentId: string,
    bytes: Buffer,
    uploadedById: string,
  ): Promise<StoredImageSummary> {
    const stored = await this.store(bytes, 'logo', uploadedById);
    const attached = await this.documents.attachEstablishmentLogo(
      establishmentId,
      stored.id,
    );
    // The image row survives a failed attach, and that is deliberate: it is
    // insert-only (DOC-058), so there is nothing to roll back, and an orphan
    // image costs a few hundred kilobytes once. Deleting it would be the one
    // `DELETE` this module has.
    if (!attached) throw new DocumentSubjectNotFoundError();
    return stored;
  }

  /**
   * DOC-057. The practitioner's seal or signature.
   *
   * PER PRACTITIONER, NEVER PER ESTABLISHMENT. Art. 5 of the Resolución
   * ACESS-2023-0030 asks for the prescriber's seal TWICE — `d.iii` and `e.iv` —
   * and a seal shared by a clinic would say who the clinic is, not who signed.
   */
  async setPractitionerImage(
    practitionerId: string,
    slot: 'seal' | 'signature',
    bytes: Buffer,
    uploadedById: string,
  ): Promise<StoredImageSummary> {
    const stored = await this.store(bytes, slot, uploadedById);
    const attached = await this.documents.attachPractitionerImage(
      practitionerId,
      slot,
      stored.id,
    );
    if (!attached) throw new DocumentSubjectNotFoundError();
    return stored;
  }

  /** DOC-061. The current logo, so the screen shows what is set. */
  async establishmentLogo(establishmentId: string): Promise<StoredImage> {
    const image = await this.documents.findEstablishmentLogo(establishmentId);
    if (image === null) throw new DocumentImageNotFoundError();
    return image;
  }

  /** DOC-061. A practitioner's current seal or signature. */
  async practitionerImage(
    practitionerId: string,
    slot: 'seal' | 'signature',
  ): Promise<StoredImage> {
    const image = await this.documents.findPractitionerImage(
      practitionerId,
      slot,
    );
    if (image === null) throw new DocumentImageNotFoundError();
    return image;
  }

  private async store(
    bytes: Buffer,
    slot: ImageSlot,
    uploadedById: string,
  ): Promise<StoredImageSummary> {
    // DOC-050 to DOC-055. Everything hostile is decided in here.
    const normalised = await this.images.normalise(bytes, slot);

    return this.documents.saveImage({
      mimeType: normalised.mimeType,
      // DOC-054. THE RE-ENCODED BYTES. `bytes` — what arrived — is not stored,
      // and SC-063 is measured on exactly that: the stored `sha256` is never
      // the hash of a file a client sent.
      bytes: normalised.bytes,
      sha256: createHash('sha256').update(normalised.bytes).digest('hex'),
      width: normalised.width,
      height: normalised.height,
      uploadedById,
    });
  }
}
