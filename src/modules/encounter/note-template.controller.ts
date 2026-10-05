import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { NoteTemplateService } from './application/note-template.service';
import {
  NoteTemplateDto,
  NoteTemplateListDto,
  NoteTemplateSummaryDto,
  PublishNoteTemplateDto,
  type NoteTemplateListResponse,
  type NoteTemplateResponse,
  type NoteTemplateSummaryResponse,
} from './dto/note-template.dto';
import {
  toTemplateResponse,
  toTemplateSummaryResponse,
} from './dto/note-template.mapper';

const optionalSpecialty = z.uuid().optional();

/**
 * EN-200 to EN-203. The consultation-note template, from the administration.
 *
 * `global`: a template belongs to the installation, not to a site, so there
 * is no site dimension to narrow — the same declaration as the document
 * templates. A note itself never asks for it here: it travels with the note
 * (EN-204), under `record:read`.
 */
@ApiTags('encounter')
@Controller({ path: 'note-templates', version: '1' })
export class NoteTemplateController {
  constructor(
    private readonly templates: NoteTemplateService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get()
  @RequirePermission('config:read', 'global')
  @ApiOperation({ summary: 'Listar las plantillas de la nota de consulta' })
  @ApiOkResponse({ type: NoteTemplateListDto })
  async list(): Promise<NoteTemplateListResponse> {
    const items = await this.templates.list('002');
    return { items: items.map(toTemplateSummaryResponse) };
  }

  @Get('current')
  @RequirePermission('config:read', 'global')
  @ApiOperation({
    summary: 'La plantilla que usaría hoy una nota de esa especialidad',
  })
  @ApiQuery({ name: 'specialtyId', required: false })
  @ApiOkResponse({ type: NoteTemplateDto })
  async current(
    @Query('specialtyId') specialtyId?: string,
  ): Promise<NoteTemplateResponse> {
    const template = await this.templates.current(
      '002',
      optionalSpecialty.parse(specialtyId || undefined) ?? null,
    );
    return toTemplateResponse(template);
  }

  @Post()
  @RequirePermission('config:manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publicar la versión siguiente de una plantilla' })
  @ApiCreatedResponse({ type: NoteTemplateSummaryDto })
  async publish(
    @Body() body: PublishNoteTemplateDto,
  ): Promise<NoteTemplateSummaryResponse> {
    const published = await this.templates.publish(
      {
        formCode: body.formCode,
        specialtyId: body.specialtyId,
        sections: body.sections,
      },
      this.currentUser.requireUserId(),
    );
    return toTemplateSummaryResponse(published);
  }
}
