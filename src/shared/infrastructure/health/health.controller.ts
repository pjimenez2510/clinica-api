import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthIndicatorResult,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { PrismaService } from '../prisma/prisma.service';

@ApiTags('salud')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memoria: MemoryHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Sondeo de preparación (readiness): comprueba también las dependencias.
   *
   * Se exceptúa del rate limiting a propósito: el orquestador sondea con mucha
   * frecuencia y un 429 lo interpretaría como servicio caído.
   *
   * OJO: hay que nombrar cada throttler explícitamente. `@SkipThrottle()` sin
   * argumentos solo exceptúa el throttler llamado `default`, y aquí todos
   * tienen nombre — el resultado sería que el sondeo se sigue limitando sin
   * que nada avise.
   */
  @Get()
  @SkipThrottle({ corta: true, media: true, larga: true })
  @HealthCheck()
  @ApiOperation({ summary: 'Estado del servicio y sus dependencias' })
  comprobar() {
    return this.health.check([
      (): Promise<HealthIndicatorResult> => this.comprobarBaseDeDatos(),
      () => this.memoria.checkHeap('memoria_heap', 512 * 1024 * 1024),
    ]);
  }

  private async comprobarBaseDeDatos(): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.ping();
      return { base_de_datos: { status: 'up' } };
    } catch {
      // El mensaje del error NO se propaga: puede llevar la cadena de conexión
      // con credenciales, y este endpoint suele estar expuesto.
      return { base_de_datos: { status: 'down' } };
    }
  }
}
