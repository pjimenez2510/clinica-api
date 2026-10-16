import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import {
  ASSISTANT_SITE_SWITCH,
  type AssistantSiteSwitch,
} from '../../shared/clinical/assistant-site-switch.port';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { OrderProposalService } from './application/order-proposal.service';
import { ASSISTANT_ENABLED } from './assistant-diagnosis.controller';
import { assistantRequester } from './assistant-requester';
import { CertificateProposalDto } from './dto/certificate-proposal.dto';

/**
 * AS-299 (D-265 §4). The certificate said aloud, proposed in Certificados.
 * Read by rules, with no model; the same door as the exams (AS-026). ⚠️
 * Nothing is issued here: the physician issues it through the certificate's
 * own route, as always.
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant/certificate', version: '1' }) // prettier-ignore
export class AssistantCertificateController {
  constructor(
    private readonly proposals: OrderProposalService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_ENABLED) private readonly enabled: boolean,
    @Inject(ASSISTANT_SITE_SWITCH)
    private readonly siteSwitch: AssistantSiteSwitch,
  ) {}

  @Get()
  @RequirePermission('assistant:use', 'query')
  @ApiOperation({ summary: 'Certificado dicho en la consulta' })
  @ApiOkResponse({ type: CertificateProposalDto })
  async certificate(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<CertificateProposalDto> {
    // AS-026. Off: the answer of a route that does not exist.
    if (!this.enabled) throw new NotFoundException();
    return {
      certificate: await this.proposals.certificate(
        encounterId,
        await assistantRequester(this.currentUser, this.siteSwitch, req),
      ),
    };
  }
}
