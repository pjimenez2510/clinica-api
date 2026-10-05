import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';
import type { Permission } from '../../shared/authorisation/permission.catalogue';

import { ClinicalNoteService } from './application/clinical-note.service';
import type { Requester } from './application/encounter.service';
import type { NoteWithTemplate } from './application/clinical-note.service';
import { toTemplateResponse } from './dto/note-template.mapper';
import {
  AmendNoteDto,
  ClinicalNoteDto,
  ClinicalNoteListDto,
  DraftNoteDto,
  SignNoteDto,
  UpdateNoteDto,
  type ClinicalNoteListResponse,
  type ClinicalNoteResponse,
} from './dto/clinical-note.dto';

/**
 * The clinical note and its chain of amendments.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SIGNING, AMENDING AND RETRACTING ARE ROUTES OF THEIR OWN, NOT A `PATCH`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * For the same reason `POST …/merge/undo` is one in `patients`: they are
 * clinical acts with an author, an instant and — two of the three — a
 * mandatory reason of their own, never the edit of a field. And the three
 * demand `record:sign`, which `ENFERMERIA` does not carry: nursing signs its
 * OWN forms (EN-142) and never the consultation note.
 *
 * A CONTROLLER OF ITS OWN and not more routes on `EncounterController`,
 * because it serves a second aggregate with a second permission profile: the
 * attention is opened with `encounter:open` and read with `record:read`, while
 * everything here is `record:write` or `record:sign`. Keeping them apart is
 * what makes the permission of each route readable in one screen.
 *
 * ⚠️ EVERY ROUTE DECLARES `'query'` SITE SCOPE, like the attention's own: the
 * note is addressed through the attention it belongs to, and the HANDLER
 * narrows with the caller's resolved scope.
 */
@ApiTags('encounter')
@Controller({ path: 'encounters/:encounterId/notes', version: '1' })
export class ClinicalNoteController {
  constructor(
    private readonly notes: ClinicalNoteService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * EN-022. Every version of every chain of this attention.
   *
   * AUDITED, unlike the listing of attentions (EN-123), and the difference is
   * what travels: an attention carries identifiers and a state, a note carries
   * the reason for the visit and the plan of treatment.
   */
  @Get()
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Listar las notas clínicas de una atención' })
  @ApiOkResponse({ type: ClinicalNoteListDto })
  async list(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ClinicalNoteListResponse> {
    const items = await this.notes.listOf(
      encounterId,
      this.requester(req, 'record:read'),
    );
    return { items: items.map(toNoteResponse) };
  }

  /**
   * EN-020, EN-021, EN-137. Opens a note: a first version, as a draft.
   *
   * 201, because what it leaves behind is a new row that did not exist. The
   * board moves in the same transaction: opening the note is the documented
   * fact that proves the patient is with the practitioner (EN-137), and
   * nobody had to press a second button for it (D-A-008).
   */
  @Post()
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Abrir una nota clínica' })
  @ApiCreatedResponse({ type: ClinicalNoteDto })
  async draft(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: DraftNoteDto,
    @Req() req: Request,
  ): Promise<ClinicalNoteResponse> {
    const note = await this.notes.draft(
      {
        encounterId,
        formCode: dto.formCode,
        formVersion: dto.formVersion,
        content: dto.content,
      },
      this.requester(req, 'record:write'),
    );
    return toNoteResponse(note);
  }

  /**
   * EN-023. Replaces the content of a DRAFT.
   *
   * A `PATCH` AND NOT A `PUT` even though it replaces the whole content, and
   * the asymmetry with block D is deliberate: the vital signs are the entire
   * resource, while a note has a status, a chain and a version that this route
   * must not be able to touch. `PUT` would advertise «send me the note» and
   * invite a client to send `status: SIGNED`.
   *
   * ⚠️ A SIGNED NOTE IS REFUSED HERE, AND THAT IS THE ONE SENTENCE THIS MODULE
   * EXISTS FOR (REQ-005). `trg_clinical_note_immutable` refuses it too — it is
   * the guarantee, because it also stops a `psql`, an import and a use case
   * somebody writes in two years — and this route is what makes the refusal a
   * sentence: the trigger raises `insufficient_privilege`, which on its own
   * would tell the doctor they lack permissions when what happened is that the
   * note is signed.
   */
  @Patch(':noteId')
  @RequirePermission('record:write', 'query')
  @ApiOperation({ summary: 'Editar el borrador de una nota clínica' })
  @ApiOkResponse({ type: ClinicalNoteDto })
  async update(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: UpdateNoteDto,
    @Req() req: Request,
  ): Promise<ClinicalNoteResponse> {
    const note = await this.notes.updateDraft(
      { encounterId, noteId, content: dto.content },
      this.requester(req, 'record:write'),
    );
    return toNoteResponse(note);
  }

  /**
   * EN-027 to EN-030, EN-130, EN-138. Signs the note.
   *
   * `record:sign` AND NOT `record:write`: writing the note and standing behind
   * it are two acts, and art. 4 of the A.M. 00115-2021 is about the second —
   * «todo profesional de salud que intervenga en la atención debe hacer
   * constar su identificación… con firma autógrafa o electrónica».
   *
   * SIGNING THE CONSULTATION NOTE DISCHARGES THE ATTENTION (EN-138), in the
   * same transaction, and that is why the body carries the discharge
   * condition: `encounter_discharge_states_a_condition` refuses a discharge
   * without one, and the signature is the only moment at which the outcome is
   * a clinical fact rather than a guess.
   */
  @Post(':noteId/sign')
  @RequirePermission('record:sign', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Firmar una nota clínica' })
  @ApiOkResponse({ type: ClinicalNoteDto })
  async sign(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: SignNoteDto,
    @Req() req: Request,
  ): Promise<ClinicalNoteResponse> {
    const note = await this.notes.sign(
      {
        encounterId,
        noteId,
        dischargeCondition: dto.dischargeCondition,
      },
      this.requester(req, 'record:sign'),
    );
    return toNoteResponse(note);
  }

  /**
   * EN-025. Amends a signed note.
   *
   * 201, AND IT IS THE WHOLE REQUIREMENT IN ONE STATUS CODE: what this leaves
   * behind is a NEW version. The previous one is not edited — it keeps its
   * content, its signer, its instant and its hash, and stays readable and
   * printable for ever. Answering 200 would say «la nota que usted conoce
   * cambió», which is exactly what REQ-005 forbids happening.
   */
  @Post(':noteId/amend')
  @RequirePermission('record:sign', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Enmendar una nota clínica firmada' })
  @ApiCreatedResponse({ type: ClinicalNoteDto })
  async amend(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: AmendNoteDto,
    @Req() req: Request,
  ): Promise<ClinicalNoteResponse> {
    const note = await this.notes.amend(
      {
        encounterId,
        noteId,
        content: dto.content,
        amendmentReason: dto.amendmentReason,
      },
      this.requester(req, 'record:sign'),
    );
    return toNoteResponse(note);
  }

  /**
   * EN-026. Retracts a signed note WITHOUT a replacement.
   *
   * `ENTERED_IN_ERROR`, distinct from `SUPERSEDED`: «esto lo escribí mal y
   * aquí está lo correcto» and «esto no debió escribirse nunca» — the note
   * filed in the wrong patient's history — are two statements, and collapsing
   * them would force inventing an empty amendment to retract, which tells the
   * reader the act happened.
   *
   * ⚠️ NOT A `DELETE`, and not because of taste: nothing is deleted. The row
   * survives with its content, its signer and its instant, and a `DELETE` verb
   * would advertise an operation `trg_clinical_note_immutable` refuses.
   *
   * NO REASON ASKED FOR, unlike the amendment. EN-026 does not demand one and
   * the act says everything a reader needs: `ENTERED_IN_ERROR` on a version
   * whose content stays visible IS the explanation. Demanding free text here
   * would be one more box on a screen whose whole point is withdrawing
   * something quickly — the same line AG-114 drew for undoing a block.
   */
  @Post(':noteId/retract')
  @RequirePermission('record:sign', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retractar una nota clínica firmada' })
  @ApiOkResponse({ type: ClinicalNoteDto })
  async retract(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Req() req: Request,
  ): Promise<ClinicalNoteResponse> {
    const note = await this.notes.retract(
      { encounterId, noteId },
      this.requester(req, 'record:sign'),
    );
    return toNoteResponse(note);
  }

  /** Who is asking, for the access trail and for the site scope. */
  private requester(req: Request, permission: Permission): Requester {
    const scope = this.currentUser.requirePrincipal().sitesFor(permission);

    return {
      userId: this.currentUser.requireUserId(),
      sites: scope === ALL_SITES ? 'all' : scope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/** Instants leave as ISO 8601; the client renders them in Ecuadorian time. */
function toNoteResponse(note: NoteWithTemplate): ClinicalNoteResponse {
  return {
    id: note.id,
    encounterId: note.encounterId,
    chainId: note.chainId,
    version: note.version,
    formCode: note.formCode,
    formVersion: note.formVersion,
    status: note.status,
    content: note.content,
    authorId: note.authorId,
    signedById: note.signedById,
    signedAt: note.signedAt?.toISOString() ?? null,
    // EN-027. Published so the digest can be verified from outside the
    // database, which is what SC-012 counts.
    contentHash: note.contentHash,
    supersedesId: note.supersedesId,
    amendmentReason: note.amendmentReason,
    createdAt: note.createdAt.toISOString(),
    template: toTemplateResponse(note.template),
  };
}
