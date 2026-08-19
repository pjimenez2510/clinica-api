import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { PatientsService } from './application/patients.service';
import {
  SexualOrientationDto,
  type SexualOrientationResponse,
} from './dto/patient.dto';

/**
 * La orientación sexual del paciente (PA-057, PA-058, D-039 (b)).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN CONTROLADOR APARTE, PORQUE LA PUERTA ES APARTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es la columna 7 del formulario del RDACAA y es **dato de categoría especial
 * bajo la LOPDP**, como el motivo de la prioridad. Esta ruta exige
 * `patient:sexual-orientation`, que `patient:read` no implica y que **no trae
 * ningún rol de fábrica**: la clínica se lo concede a alguien a propósito o no
 * lo tiene nadie. Recepción y caja siguen trabajando con `patient:read` — la
 * ficha no lleva este dato y el listado tampoco.
 *
 * Poner este manejador junto a los del registro lo dejaría a un decorador
 * olvidado de desaparecer, que es exactamente el argumento de
 * `PatientPriorityController`.
 *
 * ⚠️ SÓLO LECTURA, Y ESA ASIMETRÍA ES LA DECISIÓN. Escribir la orientación
 * sexual va por el alta y por la corrección con `patient:write`, como las demás
 * columnas del formulario: se teclea en el mostrador en la misma pantalla, y
 * exigir aquí el permiso también para escribir dejaría la columna 7 imposible
 * de llenar mientras nadie lo tenga —o sea, siempre—. Lo que queda tras la
 * puerta es VOLVER A LEERLA.
 *
 * `siteScope: 'global'` por lo mismo que el registro: una persona es una ficha
 * en toda la clínica, no una por sede (PA-051).
 */
@ApiTags('patients')
@Controller({ path: 'patients/:id/sexual-orientation', version: '1' })
export class PatientSexualOrientationController {
  constructor(
    private readonly patients: PatientsService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get()
  @RequirePermission('patient:sexual-orientation', 'global')
  @ApiOperation({ summary: "Read a patient's recorded sexual orientation" })
  @ApiOkResponse({ type: SexualOrientationDto })
  async read(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<SexualOrientationResponse> {
    const { orientation } = await this.patients.getSexualOrientation(id, {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    return { sexualOrientation: orientation };
  }
}
