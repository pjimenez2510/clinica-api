import './infrastructure/agenda.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';

import { AgendaAlertsController } from './agenda-alerts.controller';
import { AgendaController } from './agenda.controller';
import { AgendaMetricsController } from './agenda-metrics.controller';
import { AgendaReferenceController } from './agenda-reference.controller';
import { AgendaService } from './application/agenda.service';
import { BoardService } from './application/board.service';
import { BoardController } from './board.controller';
import { BOARD_REPOSITORY } from './domain/board.repository';
import { PrismaBoardRepository } from './infrastructure/prisma-board.repository';
import { EmergencyAlertService } from './application/emergency-alert.service';
import { WaitlistService } from './application/waitlist.service';
import { AGENDA_REPOSITORY } from './domain/agenda.repository';
import { EMERGENCY_ALERT_REPOSITORY } from './domain/emergency-alert.repository';
import { WAITLIST_REPOSITORY } from './domain/waitlist.repository';
import { PrismaAgendaRepository } from './infrastructure/prisma-agenda.repository';
import { PrismaEmergencyAlertRepository } from './infrastructure/prisma-emergency-alert.repository';
import { PrismaWaitlistRepository } from './infrastructure/prisma-waitlist.repository';
import { WaitlistController } from './waitlist.controller';

/**
 * The agenda.
 *
 * Composition root for this module: the only place where the application's
 * port meets concrete infrastructure. `AgendaService` never sees Prisma, which
 * is what lets the booking rules be exercised with in-memory doubles while the
 * overlap guarantees are exercised against a real PostgreSQL.
 *
 * `CurrentUserService` is PROVIDED here rather than imported from
 * `AuthModule`: no module imports another, and the service itself lives in
 * `shared/authorisation` because every module needs to know who is asking. It
 * reads `ClsService`, which is global, so providing it twice costs nothing.
 *
 * THE ACCESS AUDIT RECORDER IS FOR THE BOARD ONLY (AG-139). Nothing else this
 * module serves is clinical content and none of it is audited (AG-072,
 * SC-004); `BoardService` writes ONE row per consultation of the board —
 * never one per listed row — and is the only provider that receives it.
 */
@Module({
  controllers: [
    AgendaController,
    AgendaAlertsController,
    AgendaMetricsController,
    AgendaReferenceController,
    BoardController,
    WaitlistController,
  ],
  providers: [
    AgendaService,
    // E5. A service of its own because the waiting list is another aggregate
    // (ADR-008 §2): it shares no method with booking and changes for different
    // reasons. It reads the agenda's port for the two facts that live there —
    // which interval came free, and whose chart an appointment is.
    WaitlistService,
    // AG-175. The recipient's side of the emergency notice: another reason
    // to change (D-170.1), and no method shared with booking.
    EmergencyAlertService,
    // E9. The board: its projections, its note and its views per role — its
    // own reasons to change (D-176), and the module's only audited reader.
    BoardService,
    CurrentUserService,
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
    { provide: BOARD_REPOSITORY, useClass: PrismaBoardRepository },
    { provide: AGENDA_REPOSITORY, useClass: PrismaAgendaRepository },
    { provide: WAITLIST_REPOSITORY, useClass: PrismaWaitlistRepository },
    {
      provide: EMERGENCY_ALERT_REPOSITORY,
      useClass: PrismaEmergencyAlertRepository,
    },
  ],
})
export class AgendaModule {}
