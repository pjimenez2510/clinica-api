import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

/**
 * Sondeo de vida (liveness), separado del de preparación (readiness).
 *
 * La distinción importa en producción: si `/health` fallara porque PostgreSQL
 * está caído y el orquestador usara ese endpoint como liveness, reiniciaría la
 * API en bucle sin arreglar nada — el problema está en la base, no en el proceso.
 *
 * Liveness responde "el proceso está vivo". Readiness responde "puedo atender
 * peticiones". A diferencia de `/health`, este SÍ pasa por el rate limiting.
 */
@ApiTags('salud')
@Controller({ path: 'ping', version: '1' })
export class LivenessController {
  @Get()
  @ApiOperation({ summary: 'El proceso responde (liveness)' })
  ping(): { estado: string; hora: string } {
    return { estado: 'vivo', hora: new Date().toISOString() };
  }
}
