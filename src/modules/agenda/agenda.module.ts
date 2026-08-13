import './infrastructure/agenda.constraints';
import { Module } from '@nestjs/common';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';

import { AgendaController } from './agenda.controller';
import { AgendaReferenceController } from './agenda-reference.controller';
import { AgendaService } from './application/agenda.service';
import { AGENDA_REPOSITORY } from './domain/agenda.repository';
import { PrismaAgendaRepository } from './infrastructure/prisma-agenda.repository';

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
  controllers: [AgendaController, AgendaReferenceController],
  providers: [
    AgendaService,
    CurrentUserService,
    { provide: AGENDA_REPOSITORY, useClass: PrismaAgendaRepository },
  ],
})
export class AgendaModule {}
