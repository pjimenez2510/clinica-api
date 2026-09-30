import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
} from './prescription.presenter';
import {
  DiscardPrescriptionDto,
  PrescriptionDocumentDto,
  PrescriptionDto,
  type PrescriptionDocumentResponse,
  type PrescriptionResponse,
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
   * ⚠️ AND THE REASON IS OBLIGATORY HERE, WHERE `/cancel` ASKS FOR NONE. The
   * difference is not politeness: `discard_reason` is a column and
   * `prescription_discard_states_who_when_and_why` refuses the row without it,
   * so what is written is kept. On the annulment there is nowhere to keep it
   * (⚠️ **Falta esquema**, PR-010, PR-073).
   *
   * 200 AND NOT 204: what comes back is the prescription in its new state, so
   * the screen that listed it does not have to ask again to redraw the row.
   */
  @Post(':prescriptionId/discard')
  @RequirePermission('prescription:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Descartar un borrador de receta, diciendo por qué',
  })
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
   * PR-010, PR-093. Annuls an ISSUED prescription. NOTHING IS DELETED.
   *
   * ⚠️ AN EMITTED ONE, AND NOT A DRAFT. Art. 70 describes the procedure for the
   * receta that WAS emitted and then lost, altered or must not be dispensed:
   * there is paper in somebody's hand and a pharmacy may have dispensed against
   * it. A wrong draft has no legal act to undo — it is DISCARDED, above.
   *
   * ⚠️ NO REASON IS ASKED FOR, AND THE ABSENCE IS THE REQUIREMENT. Art. 70 wants
   * a register of annulled and lost prescriptions and there is no column to
   * keep the reason in (⚠️ **Falta esquema**, PR-010, PR-073). A mandatory
   * reason that is dropped on the floor makes everybody believe there is a
   * record; what there is, until the columns exist, is the audit row. The
   * discard above asks for one PRECISELY BECAUSE it has a column to keep it in.
   */
  @Post(':prescriptionId/cancel')
  @RequirePermission('prescription:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular una receta emitida' })
  @ApiOkResponse({ type: PrescriptionDto })
  async cancel(
    @Param('prescriptionId', ParseUUIDPipe) prescriptionId: string,
    @Req() req: Request,
  ): Promise<PrescriptionResponse> {
    const cancelled = await this.prescriptions.cancel(
      prescriptionId,
      this.requester(req, 'prescription:write'),
    );
    return toPrescriptionResponse(cancelled);
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
