import type { INestApplication } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as z from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { DERIVED_SUBJECT_STATUSES } from '../../src/modules/agenda/domain/subject-status';

import { closeApp } from './setup/http-server';

/**
 * AG-122. QUE NO HAYA RUTA es lo que se prueba, no que nadie la use.
 *
 * El hallazgo más replicado de veinticinco años de investigación sobre
 * tableros clínicos es que **un tablero que se actualiza a mano miente**: en
 * el estudio longitudinal de referencia, a los 8-9 meses de implantar la
 * pizarra electrónica la única expectativa que NO se cumplió fue «mantener la
 * información actualizada», y en un servicio que añadió un marcador al
 * tablero, de 56 852 pacientes sólo el 6,9 % fue marcado. Por eso el requisito
 * es una prohibición de ruta y no una recomendación: si existe la casilla, un
 * día se usa en vez del hecho, el tablero empieza a divergir de la historia
 * clínica, y a partir de ahí ninguna de las dos se puede creer.
 *
 * SE RECORRE LO QUE NESTJS REGISTRÓ DE VERDAD, con la misma máquina de AG-070
 * (`route-authorisation.spec.ts`): una lista mantenida a mano se desactualiza
 * la primera vez que alguien añade un endpoint, que es exactamente el día en
 * que esta prueba tendría que fallar.
 *
 * `ARRIVED` NO ESTÁ EN LA LISTA PROHIBIDA porque es el único que se teclea: el
 * hecho que representa —la persona cruzó la puerta— no deja ningún otro rastro
 * en el sistema. Lo escribe el efecto de `CHECKED_IN` (AG-127), y el cuerpo de
 * esa ruta tampoco lo nombra.
 */
describe('AG-122 · ninguna ruta fija a mano el estado del paciente', () => {
  let app: INestApplication | undefined;
  /** Cada ruta registrada con el esquema de su `@Body()`, en JSON Schema. */
  let bodies: { route: string; schema: string }[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const controllers = moduleRef.get(ModulesContainer, { strict: false });

    bodies = [];
    for (const module of controllers.values()) {
      for (const wrapper of module.controllers.values()) {
        const metatype = wrapper.metatype as (new () => object) | undefined;
        if (!metatype) continue;

        for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
          if (name === 'constructor') continue;
          const handler = (metatype.prototype as Record<string, unknown>)[name];
          if (typeof handler !== 'function') continue;
          // Sólo rutas reales: NestJS estampa un `path` en lo que expone.
          if (Reflect.getMetadata('path', handler) === undefined) continue;

          const dto = bodyDtoOf(metatype, name);
          const schema = (dto as { schema?: unknown } | undefined)?.schema;
          if (!(schema instanceof z.ZodType)) continue;

          bodies.push({
            route: `${metatype.name}.${name}`,
            schema: JSON.stringify(
              z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
            ),
          });
        }
      }
    }

    // Si el recorrido no encuentra nada, todo lo de abajo pasaría en vacío,
    // que es peor que fallar.
    expect(bodies.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await closeApp(app);
  });

  it('AG-122 ningún cuerpo de ninguna ruta admite un estado de paciente derivado', () => {
    const offenders = bodies.filter((body) =>
      DERIVED_SUBJECT_STATUSES.some((status) => body.schema.includes(status)),
    );

    expect(offenders.map((body) => body.route)).toEqual([]);
  });

  it('AG-122 ningún cuerpo de ninguna ruta nombra el campo del eje del paciente', () => {
    // La otra mitad: un campo `subjectStatus` tipado como texto libre
    // esquivaría la comprobación de los valores.
    const offenders = bodies.filter((body) =>
      /"subject_?status/i.test(body.schema),
    );

    expect(offenders.map((body) => body.route)).toEqual([]);
  });

  it('AG-135 ningún cuerpo admite el tiempo en el estado actual como dato de entrada', () => {
    // Un número que se escribe a mano envejece en el minuto siguiente; éste
    // sale de las filas append-only de AG-004 y AG-126.
    const offenders = bodies.filter((body) =>
      /"(timeInCurrentStatus|minutesInStatus|time_in_status)"/i.test(
        body.schema,
      ),
    );

    expect(offenders.map((body) => body.route)).toEqual([]);
  });
});

/**
 * La clase DTO con la que NestJS rellenará el parámetro `@Body()`, o
 * `undefined`. Se lee como la lee el framework — copiado de
 * `route-authorisation.spec.ts`, donde está el porqué: una lista de «este
 * handler recibe este DTO» mantenida a mano se desactualiza sola.
 */
function bodyDtoOf(
  controller: new (...args: never[]) => object,
  handlerName: string,
): unknown {
  const args: unknown = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    controller,
    handlerName,
  );
  const parameters: unknown = Reflect.getMetadata(
    'design:paramtypes',
    controller.prototype as object,
    handlerName,
  );
  if (typeof args !== 'object' || args === null) return undefined;
  if (!Array.isArray(parameters)) return undefined;

  const entry = Object.entries(args as Record<string, { index: number }>).find(
    ([key]) => key.startsWith(`${RouteParamtypes.BODY}:`),
  );

  return entry ? (parameters as unknown[])[entry[1].index] : undefined;
}
