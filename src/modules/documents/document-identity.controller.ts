import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { DocumentIdentityService } from './application/document-identity.service';
import { toImageResponse } from './documents.presenter';
import { DocumentImageDto, type DocumentImageResponse } from './dto/documents.dto'; // prettier-ignore
import { DocumentImageFormatNotAllowedError } from './domain/document.errors';
import type { StoredImage } from './domain/document-image';

/**
 * The clinic's visual identity: the establishment's logo and the
 * practitioner's seal and signature.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BODY IS RAW BYTES, NOT JSON, AND THAT IS THE BYTE CAP WORKING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DOC-052 requires refusing an oversized image BEFORE decoding it. Base64
 * inside JSON inflates a 512 KB file to about 700 KB of string that Express has
 * to parse and hold before anything can look at it — so the cap would apply
 * after the cost it exists to avoid. `documents.module.ts` mounts
 * `express.raw({ limit })` on exactly these paths, and Express refuses a larger
 * body at the socket.
 *
 * ⚠️ THE `Content-Type` IS NOT TRUSTED. It selects the parser and nothing else:
 * the format is decided from the MAGIC BYTES (`detectImageFormat`), because a
 * header is whatever the client typed. An SVG announced as `image/png` is
 * refused by its bytes, not by its label.
 *
 * ⚠️ `PUT` AND NOT `POST`: setting the logo twice with the same file leaves the
 * establishment in the same state, which is what makes it idempotent. What is
 * NOT idempotent underneath is the archive — each upload inserts a new
 * `document_image` row (DOC-058) — and that is deliberate: an image that changed
 * in place would change what a seal says with nothing recording it.
 */
@ApiTags('documents')
@Controller({ path: 'documents/identity', version: '1' })
export class DocumentIdentityController {
  constructor(
    private readonly identity: DocumentIdentityService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * DOC-057. The establishment's logo.
   *
   * `site:manage`, because the establishment is the clinic's own map and that
   * is the permission that administers it. `global` scope: an establishment is
   * not a site, so there is no site dimension to narrow.
   */
  @Put('establishments/:establishmentId/logo')
  @RequirePermission('site:manage', 'global')
  @ApiConsumes('image/png', 'image/jpeg')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOperation({ summary: 'Subir el logo del establecimiento (PNG o JPEG, máximo 512 KB)' }) // prettier-ignore
  @ApiOkResponse({ type: DocumentImageDto })
  async setLogo(
    @Param('establishmentId', ParseUUIDPipe) establishmentId: string,
    @Req() req: Request,
  ): Promise<DocumentImageResponse> {
    const stored = await this.identity.setEstablishmentLogo(
      establishmentId,
      rawBodyOf(req, 'logo'),
      this.currentUser.requireUserId(),
    );
    return toImageResponse(stored);
  }

  /**
   * DOC-057. The prescriber's seal, which art. 5 demands TWICE — `d.iii` on the
   * prescriber block and `e.iv` on the tear-off indications.
   *
   * `staff:manage`, because it is part of the practitioner's professional file
   * and belongs with whoever administers it.
   */
  @Put('practitioners/:practitionerId/seal')
  @RequirePermission('staff:manage', 'global')
  @ApiConsumes('image/png', 'image/jpeg')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOperation({ summary: 'Subir el sello del profesional (PNG o JPEG, máximo 512 KB)' }) // prettier-ignore
  @ApiOkResponse({ type: DocumentImageDto })
  async setSeal(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Req() req: Request,
  ): Promise<DocumentImageResponse> {
    const stored = await this.identity.setPractitionerImage(
      practitionerId,
      'seal',
      rawBodyOf(req, 'seal'),
      this.currentUser.requireUserId(),
    );
    return toImageResponse(stored);
  }

  /**
   * DOC-057. The practitioner's handwritten signature, scanned.
   *
   * ⚠️ IT IS NOT AN ELECTRONIC SIGNATURE AND NEVER BECOMES ONE (DOC-100). It is
   * an image on a page; art. 5.d.iii is textual — «no se aceptarán rúbricas o
   * trazos por firma» — so this exists for the SEAL to sit beside, and nothing
   * printed on any of these documents claims the file is signed.
   */
  @Put('practitioners/:practitionerId/signature')
  @RequirePermission('staff:manage', 'global')
  @ApiConsumes('image/png', 'image/jpeg')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOperation({ summary: 'Subir la firma escaneada del profesional (PNG o JPEG, máximo 512 KB)' }) // prettier-ignore
  @ApiOkResponse({ type: DocumentImageDto })
  async setSignature(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Req() req: Request,
  ): Promise<DocumentImageResponse> {
    const stored = await this.identity.setPractitionerImage(
      practitionerId,
      'signature',
      rawBodyOf(req, 'signature'),
      this.currentUser.requireUserId(),
    );
    return toImageResponse(stored);
  }

  /** DOC-061. The current logo, as stored (re-encoded, DOC-054). */
  @Get('establishments/:establishmentId/logo')
  @RequirePermission('site:read', 'global')
  @ApiOperation({ summary: 'Ver el logo vigente del establecimiento' })
  @ApiProduces('image/png', 'image/jpeg')
  async logo(
    @Param('establishmentId', ParseUUIDPipe) establishmentId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendImage(res, await this.identity.establishmentLogo(establishmentId));
  }

  /** DOC-061. A practitioner's current seal. */
  @Get('practitioners/:practitionerId/seal')
  @RequirePermission('staff:read', 'global')
  @ApiOperation({ summary: 'Ver el sello vigente del profesional' })
  @ApiProduces('image/png', 'image/jpeg')
  async seal(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendImage(
      res,
      await this.identity.practitionerImage(practitionerId, 'seal'),
    );
  }

  /** DOC-061. A practitioner's current scanned signature. */
  @Get('practitioners/:practitionerId/signature')
  @RequirePermission('staff:read', 'global')
  @ApiOperation({ summary: 'Ver la firma vigente del profesional' })
  @ApiProduces('image/png', 'image/jpeg')
  async signature(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendImage(
      res,
      await this.identity.practitionerImage(practitionerId, 'signature'),
    );
  }
}

/**
 * The raw body the middleware parsed, or a refusal.
 *
 * An absent buffer means the `Content-Type` did not match what `express.raw`
 * was mounted for — which is the same answer as an unsupported format, and
 * deliberately so: telling the two apart would only teach somebody to relabel
 * their SVG.
 */
function rawBodyOf(req: Request, slot: 'logo' | 'seal' | 'signature'): Buffer {
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body)) {
    throw new DocumentImageFormatNotAllowedError(slot);
  }
  return body;
}

/**
 * DOC-061. The stored bytes with their own type, and `nosniff` so no browser
 * second-guesses it: what is served is always the re-encoded PNG or JPEG.
 * `no-store` because a replaced seal must not survive in a cache.
 */
function sendImage(res: Response, image: StoredImage): void {
  res
    .status(200)
    .setHeader('Content-Type', image.mimeType)
    .setHeader('Content-Length', image.byteSize)
    .setHeader('X-Content-Type-Options', 'nosniff')
    .setHeader('Cache-Control', 'no-store, private')
    .end(image.bytes);
}
