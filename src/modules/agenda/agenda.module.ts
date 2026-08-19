import './infrastructure/agenda.constraints';
import { Module } from '@nestjs/common';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';

import { AgendaController } from './agenda.controller';
import { AgendaMetricsController } from './agenda-metrics.controller';
import { AgendaReferenceController } from './agenda-reference.controller';
import { AgendaService } from './application/agenda.service';
import { WaitlistService } from './application/waitlist.service';
import { AGENDA_REPOSITORY } from './domain/agenda.repository';
import { WAITLIST_REPOSITORY } from './domain/waitlist.repository';
import { PrismaAgendaRepository } from './infrastructure/prisma-agenda.repository';
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
 * NO ACCESS AUDIT RECORDER, and that is a decision rather than an oversight
 * (AG-072, SC-004): nothing this module serves is clinical content, and a
 * recorder wired in here would eventually be called once per listed row.
 */
@Module({
  controllers: [
    AgendaController,
    AgendaMetricsController,
    AgendaReferenceController,
    WaitlistController,
  ],
  providers: [
    AgendaService,
    // E5. A service of its own because the waiting list is another aggregate
    // (ADR-008 §2): it shares no method with booking and changes for different
    // reasons. It reads the agenda's port for the two facts that live there —
    // which interval came free, and whose chart an appointment is.
    WaitlistService,
    CurrentUserService,
    { provide: AGENDA_REPOSITORY, useClass: PrismaAgendaRepository },
    { provide: WAITLIST_REPOSITORY, useClass: PrismaWaitlistRepository },
  ],
})
export class AgendaModule {}
