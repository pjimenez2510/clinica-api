import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';
import type { Permission } from '../../shared/authorisation/permission.catalogue';

import { PrescriptionService } from './application/prescription.service';
import {
  toDocumentResponse,
  toPrescriptionResponse,
  toVocabularyResponse,
  toWrittenItem,
} from './prescription.presenter';
import {
  CancelPrescriptionDto,
  ComposedPrescriptionDto,
  CorrectPrescriptionDto,
  CancelledPrescriptionDto,
  CorrectedPrescriptionDto,
  DiscardPrescriptionDto,
  PrescriptionDocumentDto,
  PrescriptionDto,
  PrescriptionVocabularyDto,
  RewritePrescriptionDto,
  VocabularyQueryDto,
  type ComposedPrescriptionResponse,
  type CancelledPrescriptionResponse,
  type CorrectedPrescriptionResponse,
  type PrescriptionDocumentResponse,
  type PrescriptionResponse,
  type PrescriptionVocabularyResponse,
} from './dto/prescription.dto';
import type { Requester } from './application/prescription.service';

/**
 * One prescription: the document it is, issuing it, discarding the draft and
 * annulling the emitted one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ISSUING IS A ROUTE OF ITS OWN AND NOT A `PATCH` OF THE STATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The same reason `…/notes/:noteId/sign` is: it is a legal act with an author,
 * an instant and a document that did not exist before it — art. 6 calls the
 * receta «el único documento legal que avale la prescripción». A `PATCH
 * /prescriptions/:id { status: 'ACTIVE' }` would let a client set the state
 * directly, which is the box that every rule of this module exists to keep
 * nobody from ticking.
 *
 * ⚠️ THERE IS NO ROUTE THAT ADDS OR REMOVES A LINE (PR-005). A prescription is
 * written whole and issued whole; a «añadir línea» route opens a window in
 * which a half-written prescription exists and somebody can issue it.
 *
 * ⚠️ AND THERE IS NO ROUTE THAT ISSUES A CONTROLLED PRESCRIPTION (PR-070).
 * Psychotropics and narcotics go on a pre-printed pad the ACESS sells, under
 * the doctor's nominal custody, whose original stays at the pharmacy. What this
 * system owes there is the internal register of the pad and the monthly report
 * — neither of which has a table yet (PR-071, PR-072).
 */
@ApiTags('prescription')
@Controller({ path: 'prescriptions', version: '1' })
export class PrescriptionController {
  constructor(
    private readonly prescriptions: PrescriptionService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * PR-103. The lists a line is written with. DECLARED BEFORE
   * `:prescriptionId`: NestJS matches in declaration order, and the literal
   * segment would otherwise be swallowed by the parameter.
   */
  @Get('vocabulary')
  @RequirePermission('prescription:write', 'query')
  @ApiOperation({ summary: 'Listas para escribir una línea de receta' })
  @ApiOkResponse({ type: PrescriptionVocabularyDto })
  async vocabulary(
    @Query() query: VocabularyQueryDto,
  ): Promise<PrescriptionVocabularyResponse> {
    const presentations =
      query.conceptId === undefined
        ? []
        : await this.prescriptions.presentationsOf(query.conceptId);
    return toVocabularyResponse(presentations);
  }

  /**
   * PR-100. Rewrites a DRAFT whole: its lines and its indications. A `PUT`
   * because the body IS the draft — there is no route that adds one line, so
   * there is never a receta half written between two requests (PR-005).
   */
  @Put(':prescriptionId')
  @RequirePermission('prescription:write', 'query')
  @ApiOperation({ summary: 'Corregir un borrador de receta' })
  @ApiOkResponse({ type: ComposedPrescriptionDto })
  async rewrite(
    @Param('prescriptionId', ParseUUIDPipe) prescriptionId: string,
    @Body() dto: RewritePrescriptionDto,
    @Req() req: Request,
  ): Promise<ComposedPrescriptionResponse> {
    const rewritten = await this.prescriptions.rewrite(
      {
        prescriptionId,
        warningSigns: dto.warningSigns ?? null,
        nonPharmacologicalAdvice: dto.nonPharmacologicalAdvice ?? null,
        items: dto.items.map(toWrittenItem),
      },
      this.requester(req, 'prescription:write'),
    );
    return {
      prescription: toPrescriptionResponse(rewritten.prescription),
      allergyAlerts: [...rewritten.allergyAlerts],
    };
  }

  /**
   * PR-020 to PR-053, PR-092. The prescription as art. 5 obliges it.
   *
   * ⚠️ THE ONLY AUDITED READ OF THIS MODULE. What comes back is the name, the
   * age, the diagnoses, the allergies and the medication of an identifiable
   * person — it is what is printed and handed over — so «¿quién abrió esta
   * receta?» has to be answerable (REQ-110).
   */
  @Get(':prescriptionId')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Obtener la receta con el contenido que exige la norma' }) // prettier-ignore
  @ApiOkResponse({ type: PrescriptionDocumentDto })
  async document(
    @Param('prescriptionId', ParseUUIDPipe) prescriptionId: string,
    @Req() req: Request,
  ): Promise<PrescriptionDocumentResponse> {
    const document = await this.prescriptions.document(
      prescriptionId,
      this.requester(req, 'record:read'),
    );
    return toDocumentResponse(document);
  }

  /**
   * PR-005, PR-021, PR-032 to PR-034, PR-050, PR-060, PR-093. Issues it.
   *
   * 200 AND NOT 201: the row already existed. What this creates is not a
   * resource but a fact about one — the same shape `…/notes/:noteId/sign` uses.
   */
  @Post(':prescriptionId/issue')
  @RequirePermission('prescription:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Emitir la receta' })
  @ApiOkResponse({ type: PrescriptionDto })
  async issue(
    @Param('prescriptionId', ParseUUIDPipe) prescriptionId: string,
    @Req() req: Request,
  ): Promise<PrescriptionResponse> {
    const issued = await this.prescriptions.issue(
      prescriptionId,
      this.requester(req, 'prescription:write'),
    );
    return toPrescriptionResponse(issued);
  }

  /**
   * PR-011, PR-093. Discards a DRAFT. NOTHING IS DELETED.
   *
   * ⚠️ IT IS NOT `/cancel` UNDER ANOTHER NAME. Annulling bears on an EMITTED
   * prescription — art. 70, with paper in somebody's hand — and discarding
   * closes a draft that never left the room. Two acts, two states, and the
   * database keeps them apart with
   * `prescription_discard_only_from_draft`.
   *
   * ⚠️ AND NOTHING IS ASKED (D-126, PR-107). The body may carry a reason and
   * `discard_reason` keeps it, but none is required: the screen discards with
   * one click and offers «Deshacer», which is `/restore` below.
   *
   * 200 AND NOT 204: what comes back is the prescription in its new state, so
   * the screen that listed it does not have to ask again to redraw the row.
   */
  @Post(':prescriptionId/discard')
  @RequirePermission('prescription:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descartar un borrador de receta' })
  @ApiOkResponse({ type: PrescriptionDto })
  async discard(
    @Param('prescriptionId', ParseUUIDPipe) prescriptionId: string,
    @Body() body: DiscardPrescriptionDto,
    @Req() req: Request,
  ): Promise<PrescriptionResponse> {
    const discarded = await this.prescriptions.discard(
      prescriptionId,
      body.reason,
      this.requester(req, 'prescription:write'),
    );
    return toPrescriptionResponse(discarded);
  }

  /**
   * PR-107. Undoes a discard: DISCARDED back to DRAFT, as it was. Only the
   * draft's prescriber, with the permission of composing it.
   */
  @Post(':prescriptionId/restore')
  @RequirePermission('prescription:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recuperar un borrador de receta descartado' })
  @ApiOkResponse({ type: PrescriptionDto })
  async restore(
    @Param('prescriptionId', ParseUUIDPipe) prescriptionId: string,
    @Req() req: Request,
  ): Promise<PrescriptionResponse> {
    const restored = await this.prescriptions.restore(
      prescriptionId,
      this.requester(req, 'prescription:write'),
    );
    return toPrescriptionResponse(restored);
  }

  /**
   * PR-010, PR-093, PR-108. Annuls an ISSUED prescription, saying why.
   * NOTHING IS DELETED.
   *
   * ⚠️ AN EMITTED ONE, AND NOT A DRAFT. Art. 70 describes the procedure for the
   * receta that WAS emitted and then lost, altered or must not be dispensed:
   * there is paper in somebody's hand and a pharmacy may have dispensed against
   * it. A wrong draft has no legal act to undo — it is DISCARDED, above.
   *
   * ⚠️ THE REASON IS OBLIGATORY (PR-108): `cancelled_at`, `cancelled_by_id`
   * and `cancel_reason` are the register art. 70 asks for, and the database
   * demands the three together.
   */
  @Post(':prescriptionId/cancel')
  @RequirePermission('prescription:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular una receta emitida, diciendo por qué' })
  @ApiOkResponse({ type: CancelledPrescriptionDto })
  async cancel(
    @Param('prescriptionId', ParseUUIDPipe) prescriptionId: string,
    @Body() body: CancelPrescriptionDto,
    @Req() req: Request,
  ): Promise<CancelledPrescriptionResponse> {
    const cancelled = await this.prescriptions.cancel(
      prescriptionId,
      body.reason,
      this.requester(req, 'prescription:write'),
    );
    return {
      ...toPrescriptionResponse(cancelled),
      documentArchived: cancelled.documentArchived,
    };
  }

  /**
   * PR-109. «Corregir» an issued prescription: annuls it with its reason and
   * opens a draft in the same attention with the same lines, in one
   * transaction. Only its prescriber, with the permission of annulling it.
   *
   * 200 AND NOT 201: what the caller asked for is the correction of an
   * existing prescription; the draft is part of the answer, not the resource
   * the request names.
   */
  @Post(':prescriptionId/correct')
  @RequirePermission('prescription:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Corregir una receta emitida: anularla y abrir un borrador igual',
  })
  @ApiOkResponse({ type: CorrectedPrescriptionDto })
  async correct(
    @Param('prescriptionId', ParseUUIDPipe) prescriptionId: string,
    @Body() body: CorrectPrescriptionDto,
    @Req() req: Request,
  ): Promise<CorrectedPrescriptionResponse> {
    const corrected = await this.prescriptions.correct(
      prescriptionId,
      body.reason,
      this.requester(req, 'prescription:write'),
    );
    return {
      cancelled: toPrescriptionResponse(corrected.cancelled),
      draft: toPrescriptionResponse(corrected.draft),
      documentArchived: corrected.documentArchived,
    };
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
