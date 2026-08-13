import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import {
  ParameterOutOfRangeError,
  SiteParametersNotFoundError,
} from '../domain/configuration.errors';
import type {
  SiteParameterRepository,
  SiteParameterView,
} from '../domain/site-parameter.repository';
import type { SiteParametersPatch } from '../domain/site-parameters';

import { ConfigurationAuditTrail } from './configuration-audit.trail';
import { SiteParametersService } from './site-parameters.service';

/**
 * The rules that are the SERVICE's to enforce, against a double of its port.
 *
 * The one worth naming is CF-064: the assertion is about what the service does
 * NOT do. It writes one row and never reaches for an appointment, so a change
 * cannot revalidate or cancel anything already booked. The same requirement is
 * proved end to end against real rows in
 * `test/integration/configuration-http.spec.ts`, which is where it can be
 * shown that not a single `agenda_entry` moved.
 */

const REQUESTER = { userId: 'user-1', ip: '10.0.0.1' };

const CURRENT: SiteParameterView = {
  siteId: 'site-1',
  minLeadMinutes: 0,
  maxLeadDays: 180,
  overbookingCap: 2,
  cancelledRetention: 'NEVER',
};

interface Call {
  method: string;
  args: unknown[];
}

class RepositoryDouble implements SiteParameterRepository {
  readonly calls: Call[] = [];
  findAnswer: SiteParameterView | null = CURRENT;

  find(siteId: string): Promise<SiteParameterView | null> {
    this.calls.push({ method: 'find', args: [siteId] });
    return Promise.resolve(this.findAnswer);
  }

  update(
    siteId: string,
    patch: SiteParametersPatch,
  ): Promise<SiteParameterView | null> {
    this.calls.push({ method: 'update', args: [siteId, patch] });
    return Promise.resolve(
      this.findAnswer ? { ...this.findAnswer, ...patch } : null,
    );
  }
}

describe('los parámetros de operación de una sede', () => {
  let repository: RepositoryDouble;
  let recorded: AccessAuditEntry[];
  let service: SiteParametersService;

  beforeEach(() => {
    repository = new RepositoryDouble();
    recorded = [];
    service = new SiteParametersService(
      repository,
      new ConfigurationAuditTrail({
        record: (entry) => {
          recorded.push(entry);
          return Promise.resolve();
        },
      }),
    );
  });

  it('CF-062 devuelve los cuatro parámetros de la sede', async () => {
    await expect(service.get('site-1')).resolves.toEqual(CURRENT);
  });

  it('CF-062 responde SITE_PARAMETERS_NOT_FOUND cuando la sede no tiene fila', async () => {
    // La base escribe la fila al crear la sede, así que no tenerla significa
    // que la sede no existe.
    repository.findAnswer = null;

    await expect(service.get('site-9')).rejects.toBeInstanceOf(
      SiteParametersNotFoundError,
    );
  });

  it('CF-064 escribe una sola fila y no toca nada más', async () => {
    await service.update('site-1', { maxLeadDays: 30 }, REQUESTER);

    // The read is the one CF-065's coherence check needs; the write is the
    // parameter row. Anything else appearing in this list would be the
    // revalidation CF-064 forbids.
    expect(repository.calls.map((call) => call.method)).toEqual([
      'find',
      'update',
    ]);
    expect(repository.calls[1]?.args[1]).toEqual({
      minLeadMinutes: undefined,
      maxLeadDays: 30,
      overbookingCap: undefined,
      cancelledRetention: undefined,
    });
  });

  it('CF-065 rechaza el cambio antes de leer nada cuando está fuera de rango', async () => {
    await expect(
      service.update('site-1', { overbookingCap: 99 }, REQUESTER),
    ).rejects.toBeInstanceOf(ParameterOutOfRangeError);

    expect(repository.calls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('CF-065 juzga la coherencia sobre el RESULTADO, no sobre lo enviado', async () => {
    // La antelación mínima de cinco días es correcta hoy —la máxima son 180—
    // y absurda en cuanto alguien baja la máxima a uno. Validar sólo el cuerpo
    // de la petición dejaría pasar el segundo cambio.
    repository.findAnswer = { ...CURRENT, minLeadMinutes: 7200 };

    await expect(
      service.update('site-1', { maxLeadDays: 1 }, REQUESTER),
    ).rejects.toBeInstanceOf(ParameterOutOfRangeError);
  });

  it('CF-066 deja en la bitácora quién cambió los parámetros', async () => {
    await service.update('site-1', { overbookingCap: 4 }, REQUESTER);

    expect(recorded).toEqual([
      {
        userId: 'user-1',
        resourceType: 'configuration',
        resourceId: 'site-1',
        action: 'UPDATE',
        ip: '10.0.0.1',
        userAgent: undefined,
      },
    ]);
  });

  it('CF-066 no escribe en la bitácora al consultar los parámetros', async () => {
    await service.get('site-1');

    expect(recorded).toEqual([]);
  });

  it('CF-062 responde SITE_PARAMETERS_NOT_FOUND si la sede desaparece entre la lectura y la escritura', async () => {
    repository.update = () => Promise.resolve(null);

    await expect(
      service.update('site-1', { overbookingCap: 4 }, REQUESTER),
    ).rejects.toBeInstanceOf(SiteParametersNotFoundError);
    expect(recorded).toEqual([]);
  });
});
