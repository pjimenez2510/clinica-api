import { Injectable } from '@nestjs/common';

import type { AssistantSiteSwitch } from '../../clinical/assistant-site-switch.port';
import { PrismaService } from '../prisma/prisma.service';

/** AS-161. `site_parameter.assistant_enabled`, as it stands now. */
@Injectable()
export class PrismaAssistantSiteSwitch implements AssistantSiteSwitch {
  constructor(private readonly prisma: PrismaService) {}

  async enabledSites(): Promise<string[]> {
    const rows = await this.prisma.siteParameter.findMany({
      where: { assistantEnabled: true },
      select: { siteId: true },
    });
    return rows.map((row) => row.siteId);
  }
}
