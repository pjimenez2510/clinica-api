import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthIndicatorResult,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../prisma/prisma.service';

@ApiTags('salud')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memoria: MemoryHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HealthController.name);
  }

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
    } catch (error) {
      /**
       * Dos destinos distintos para la misma causa, a propósito:
       *
       *  - Al LOG va el motivo saneado, para poder diagnosticar. Sin esto el
       *    endpoint solo dice "down" y no hay forma de saber si es la red, las
       *    credenciales o que el motor no arrancó.
       *  - A la RESPUESTA no va nada. El mensaje puede arrastrar la cadena de
       *    conexión con usuario y contraseña, y este endpoint suele quedar
       *    accesible desde fuera.
       */
      const causa = error instanceof Error ? error : new Error('desconocida');
      this.logger.error(
        { err: causa, dependencia: 'postgresql' },
        'comprobacion de dependencia fallida',
      );
      return { base_de_datos: { status: 'down' } };
    }
  }
}
