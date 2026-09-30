import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { DocumentService } from './application/document.service';
import { toTemplateResponse } from './documents.presenter';
import {
  DocumentTemplateDto,
  PublishTemplateDto,
  type DocumentTemplateResponse,
} from './dto/documents.dto';
import type { DocumentKind } from './domain/document-kind';

/**
 * The versioned template: what exists, and publishing the next one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `config:manage` TO PUBLISH, AND THERE IS NO ROUTE THAT EDITS ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A template version is what an archived document was produced with, so it can
 * never change: `trg_document_template_immutable` refuses the `UPDATE` and this
 * controller offers nowhere to send one (DOC-032). Changing the letterhead is
 * publishing version 4; version 3 keeps saying what the recetas of last March
 * were printed with.
 *
 * ⚠️ AND THERE IS NO «SET AS CURRENT» ROUTE EITHER (DOC-031). The current
 * version is the HIGHEST one, derived and never marked — a flag would need an
 * `UPDATE` on the one table in this module that must never take one.
 *
 * ⚠️ THE BODY IS A CLOSED SET OF SLOTS (DOC-034). No template language, no
 * uploaded layout, no HTML. The risk has a name — internal platform effect —
 * but the argument that decides it here is local: a verifiable EARS requirement
 * cannot be written against a template the clinic rewrote on Tuesday.
 */
@ApiTags('documents')
@Controller({ path: 'documents/templates', version: '1' })
export class DocumentTemplatesController {
  constructor(
    private readonly documents: DocumentService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * Every published version of every kind, newest first within each kind.
   *
   * `global` AND NOT `query`: a template belongs to the installation and not to
   * a site, so there is no site dimension to narrow. Saying so is the point of
   * the declaration — «no site check» has to be a decision somebody wrote down.
   */
  @Get()
  @RequirePermission('config:read', 'global')
  @ApiOperation({ summary: 'Listar las versiones de plantilla publicadas' })
  @ApiOkResponse({ type: [DocumentTemplateDto] })
  async list(): Promise<DocumentTemplateResponse[]> {
    const templates = await this.documents.listTemplates();
    return templates.map(toTemplateResponse);
  }

  /** DOC-030. Publishes the next version of a kind. */
  @Post()
  @RequirePermission('config:manage', 'global')
  @ApiOperation({ summary: 'Publicar una versión nueva de la plantilla' })
  @ApiCreatedResponse({ type: DocumentTemplateDto })
  async publish(
    @Body() body: PublishTemplateDto,
    @Req() req: Request,
  ): Promise<DocumentTemplateResponse> {
    const published = await this.documents.publishTemplate(
      body.kind as DocumentKind,
      {
        accentColour: body.accentColour,
        footerText: body.footerText,
        headerFields: body.headerFields,
        showEstablishmentRuc: body.showEstablishmentRuc,
        showEstablishmentAddress: body.showEstablishmentAddress,
        showEstablishmentPhone: body.showEstablishmentPhone,
      },
      {
        userId: this.currentUser.requireUserId(),
        // A template is not site-scoped, so the scope is stated rather than
        // resolved: passing a narrowed one would suggest a filter that does not
        // exist on this table.
        sites: 'all',
        ip: req.ip,
        userAgent: req.get('user-agent'),
      },
    );
    return toTemplateResponse(published);
  }
}
