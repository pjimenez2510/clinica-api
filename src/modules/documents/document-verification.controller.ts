import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../shared/http/auth.decorators';

import { DocumentVerificationService } from './application/document-verification.service';
import { DocumentVerificationDto } from './dto/documents.dto';
import type { DocumentVerification } from './domain/document-verification';

/**
 * DOC-094. What the QR of a receta or a certificate opens.
 *
 * ⚠️ `@Public()` — THE ONLY PUBLIC ROUTE OF THIS MODULE, ON PURPOSE (the
 * author's decision of 30-09-2026). Whoever checks a document is a pharmacy or
 * an employer, without an account here. What keeps it narrow: the answer
 * carries nobody's health data (DOC-095), every miss answers the same
 * (DOC-096), the code is 64 random bits, and requests are capped at 30 a
 * minute per IP — looser than `login`'s 10, because a pharmacy behind one
 * address checks several recetas in a row, and nothing here can be guessed.
 */
@ApiTags('documents')
@Controller({ path: 'documents/verify', version: '1' })
export class DocumentVerificationController {
  constructor(private readonly verification: DocumentVerificationService) {}

  @Get(':code')
  @Public()
  @Throttle({ short: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Verificar un documento por su código' })
  @ApiOkResponse({ type: DocumentVerificationDto })
  verify(@Param('code') code: string): Promise<DocumentVerification> {
    return this.verification.verify(code);
  }
}
