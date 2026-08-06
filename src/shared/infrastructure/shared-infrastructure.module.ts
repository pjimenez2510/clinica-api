import { Global, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health/health.controller';
import { LivenessController } from './health/liveness.controller';
import { PrismaService } from './prisma/prisma.service';

/**
 * Infraestructura transversal: acceso a datos y sondeos.
 *
 * Es `@Global` a propósito. PrismaService lo necesita casi todo módulo de
 * negocio, e importarlo explícitamente en cada uno sería ruido sin beneficio:
 * no hay una segunda implementación entre la que elegir.
 */
@Global()
@Module({
  imports: [TerminusModule],
  controllers: [HealthController, LivenessController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class SharedInfrastructureModule {}
