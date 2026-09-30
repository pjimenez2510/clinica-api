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

import { PrescriptionService } from './application/prescription.service';
import { toPrescriptionResponse } from './prescription.presenter';
import {
  ComposePrescriptionDto,
  ComposedPrescriptionDto,
  PrescriptionListDto,
  type ComposedPrescriptionResponse,
  type PrescriptionListResponse,
} from './dto/prescription.dto';
import type { Requester } from './application/prescription.service';

/**
 * The prescriptions of one attention: composing them and listing them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `prescription:write` TO WRITE, `record:read` TO READ, AND THE SPLIT IS THE
 * REQUIREMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Art. 168 of the Ley Orgánica de Salud reserves prescribing to doctors,
 * dentists and obstetricians; reading the prescription is done by whoever
 * prints it and hands it to the patient. They are two acts and two permissions.
 * `prescription:write` has existed in `permission.catalogue.ts` since the
 * authorisation module was built and `MEDICO` has carried it since
 * `default-roles.ts` was written — and until this controller existed it checked
 * nothing, which is exactly what that file calls «una promesa que el sistema no
 * cumple».
 *
 * ⚠️ AND `nursing:write` APPEARS ON NO ROUTE OF THIS MODULE (PR-081). That
 * absence is the separation of functions of LOS art. 198 written as a table of
 * routes rather than as a paragraph somebody has to remember: nursing takes the
 * weight and fills forms 020, 120 and 022, and nursing does not prescribe.
 *
 * ⚠️ EVERY ROUTE DECLARES `'query'` SITE SCOPE: a prescription is addressed
 * through the attention it belongs to, the site is not in the URL, and the
 * guard cannot check what it cannot see. The HANDLER narrows with the caller's
 * own resolved scope (PR-091), which is also art. 10 — «en ningún caso pueden
 * ser utilizadas en otros establecimientos de salud».
 */
@ApiTags('prescription')
@Controller({ path: 'encounters/:encounterId/prescriptions', version: '1' })
export class EncounterPrescriptionsController {
  constructor(
    private readonly prescriptions: PrescriptionService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * PR-001 to PR-009, PR-067. Composes a prescription as a draft.
   *
   * 201, because what it leaves behind is a row that did not exist — and the
   * body carries the allergy alerts alongside it (PR-067): informing while the
   * doctor is still composing is what makes the ONE blocking alert of the issue
   * credible.
   */
  @Post()
  @RequirePermission('prescription:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Componer una receta en borrador para la atención' })
  @ApiCreatedResponse({ type: ComposedPrescriptionDto })
  async compose(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: ComposePrescriptionDto,
    @Req() req: Request,
  ): Promise<ComposedPrescriptionResponse> {
    const composed = await this.prescriptions.compose(
      {
        encounterId,
        items: dto.items.map((item) => ({
          conceptId: item.conceptId ?? null,
          // PR-008. Only read when there is no concept: with one, the DCI comes
          // from the CNMB row the adapter reads in the write's transaction.
          genericName: item.genericName ?? null,
          presentation: item.presentation,
          concentration: item.concentration,
          routeCode: item.routeCode,
          quantity: item.quantity,
          doseText: item.doseText,
          frequencyText: item.frequencyText,
          durationDays: item.durationDays,
          instructions: item.instructions ?? null,
          offFormularyJustification: item.offFormularyJustification ?? null,
        })),
      },
      this.requester(req, 'prescription:write'),
    );

    return {
      prescription: toPrescriptionResponse(composed.prescription),
      allergyAlerts: [...composed.allergyAlerts],
    };
  }

  /**
   * PR-006, PR-092. The prescriptions of one attention, newest first.
   *
   * NOT AUDITED, unlike the document: what travels here are identifiers, states
   * and medicines, and a row per listed prescription would bury the accountable
   * act — opening the document of one — exactly as a row per listed appointment
   * would (EN-123).
   */
  @Get()
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Listar las recetas de la atención' })
  @ApiOkResponse({ type: PrescriptionListDto })
  async list(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<PrescriptionListResponse> {
    const items = await this.prescriptions.listOfEncounter(
      encounterId,
      this.requester(req, 'record:read'),
    );
    return { items: items.map(toPrescriptionResponse) };
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
