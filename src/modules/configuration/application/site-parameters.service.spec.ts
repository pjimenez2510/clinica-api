import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import {
  ParameterOutOfRangeError,
  SiteParametersNotFoundError,
} from '../domain/configuration.errors';
import type {
  SiteParameterChange,
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
  slotAtomMinutes: 10,
  allowPastBooking: false,
  cancelledRetention: 'NEVER',
};

interface Call {
  method: string;
  args: unknown[];
}

class RepositoryDouble implements SiteParameterRepository {
  readonly calls: Call[] = [];
  findAnswer: SiteParameterView | null = CURRENT;
  /** D-021: what the whole clinic has configured. */
  durationsAnswer: number[] = [10, 20, 30];

  configuredDurations(): Promise<readonly number[]> {
    this.calls.push({ method: 'configuredDurations', args: [] });
    return Promise.resolve(this.durationsAnswer);
  }

  find(siteId: string): Promise<SiteParameterView | null> {
    this.calls.push({ method: 'find', args: [siteId] });
    return Promise.resolve(this.findAnswer);
  }

  /**
   * AG-097, CF-066, D-017: the adapter hands back both sides of the write, so
   * the trail's «desde qué valor» is the row this statement replaced and not
   * whatever a separate read happened to see.
   */
  update(
    siteId: string,
    patch: SiteParametersPatch,
  ): Promise<SiteParameterChange | null> {
    this.calls.push({ method: 'update', args: [siteId, patch] });
    if (!this.findAnswer) return Promise.resolve(null);

    return Promise.resolve({
      before: this.findAnswer,
      after: { ...this.findAnswer, ...patch },
    });
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

  it('CF-062 devuelve los parámetros de operación de la sede', async () => {
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
      allowPastBooking: undefined,
      cancelledRetention: undefined,
    });
  });

  it('AG-094 apaga la reserva en el pasado sin confundir `false` con «no lo envió»', async () => {
    // The site had it open and closes it again. `false` is a value somebody
    // chose, and any falsy shortcut on the way to the row would keep the
    // switch open while answering that it had been saved.
    repository.findAnswer = { ...CURRENT, allowPastBooking: true };

    const updated = await service.update(
      'site-1',
      { allowPastBooking: false },
      REQUESTER,
    );

    expect(repository.calls[1]?.args[1]).toMatchObject({
      allowPastBooking: false,
    });
    expect(updated.allowPastBooking).toBe(false);
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
        before: CURRENT,
        after: { ...CURRENT, overbookingCap: 4 },
      },
    ]);
  });

  it('AG-097 registra desde qué valor cambió, no sólo hasta cuál', async () => {
    // D-017. The entry carries the domain view of the site's parameters —
    // four numbers and two flags, no PHI anywhere near it — and NOT the row
    // the ORM handed back: `createdAt`/`updatedAt` would be noise, because the
    // instant is already the trail row's own.
    await service.update('site-1', { overbookingCap: 4 }, REQUESTER);

    expect(recorded[0]?.before).toEqual({
      siteId: 'site-1',
      minLeadMinutes: 0,
      maxLeadDays: 180,
      overbookingCap: 2,
      slotAtomMinutes: 10,
      allowPastBooking: false,
      cancelledRetention: 'NEVER',
    });
    expect(recorded[0]?.after).toMatchObject({ overbookingCap: 4 });
  });

  it('AG-097 el valor registrado es el que la escritura reemplazó, no el que se leyó antes', async () => {
    // The service reads once to judge coherence and the adapter reads again
    // inside the transaction that writes. Only the second can be the trail's
    // «desde qué valor»: between the two, somebody else's PUT can land.
    const overtaken: SiteParameterView = { ...CURRENT, overbookingCap: 7 };
    repository.update = (siteId, patch) => {
      repository.calls.push({ method: 'update', args: [siteId, patch] });
      return Promise.resolve({
        before: overtaken,
        after: { ...overtaken, ...patch },
      });
    };

    await service.update('site-1', { overbookingCap: 4 }, REQUESTER);

    expect(recorded[0]?.before).toEqual(overtaken);
  });

  /**
   * D-021. Changing the atom is the OTHER door into the incoherence AG-012
   * used to refuse at the counter, and it has to answer to what is already
   * stored — otherwise the guarantee holds in one direction only.
   */
  it('D-021 rechaza un turno que dejaría sin reservar una duración ya configurada', async () => {
    repository.durationsAnswer = [10, 20, 30];

    const rejection = await service
      .update('site-1', { slotAtomMinutes: 20 }, REQUESTER)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ParameterOutOfRangeError);
    expect(
      (rejection as ParameterOutOfRangeError).fieldErrors?.[0]?.field,
    ).toBe('slotAtomMinutes');
    // Y no escribió: el rechazo es antes de la transacción.
    expect(repository.calls.map((call) => call.method)).not.toContain('update');
  });

  it('D-021 no consulta las duraciones cuando el turno no se está tocando', async () => {
    // Leer todos los tipos de atención en una petición que sólo mueve la
    // antelación mínima es una consulta que nadie necesita.
    await service.update('site-1', { minLeadMinutes: 30 }, REQUESTER);

    expect(repository.calls.map((call) => call.method)).not.toContain(
      'configuredDurations',
    );
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
