import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import { HolidayNotFoundError } from '../domain/configuration.errors';
import type {
  HolidayInput,
  HolidayPatch,
  HolidayQuery,
  HolidayRepository,
  HolidayView,
} from '../domain/holiday.repository';

import { ConfigurationAuditTrail } from './configuration-audit.trail';
import { HolidaysService } from './holidays.service';

/**
 * The rules that are the SERVICE's to enforce, against a double of its port:
 * the scope defaulting to «todas las sedes» (CF-060), the refusal when the row
 * is gone, and an audit entry on every mutation and on no read (CF-066).
 *
 * What the DATABASE guarantees — that two holidays cannot share a date and a
 * scope, in BOTH scopes (CF-061) — is exercised in
 * `test/integration/configuration-http.spec.ts` against a real PostgreSQL,
 * because a double that returns what we programmed cannot prove that
 * `UNIQUE NULLS NOT DISTINCT` exists.
 */

const REQUESTER = { userId: 'user-1', ip: '10.0.0.1' };

const HOLIDAY: HolidayView = {
  id: 'holiday-1',
  date: '2026-01-01',
  name: 'Año Nuevo',
  siteId: null,
};

interface Call {
  method: string;
  args: unknown[];
}

class RepositoryDouble implements HolidayRepository {
  readonly calls: Call[] = [];
  updateAnswer: HolidayView | null = HOLIDAY;
  deleteAnswer = true;

  list(query: HolidayQuery): Promise<readonly HolidayView[]> {
    this.calls.push({ method: 'list', args: [query] });
    return Promise.resolve([HOLIDAY]);
  }

  create(input: HolidayInput): Promise<HolidayView> {
    this.calls.push({ method: 'create', args: [input] });
    return Promise.resolve({ ...HOLIDAY, ...input });
  }

  update(id: string, patch: HolidayPatch): Promise<HolidayView | null> {
    this.calls.push({ method: 'update', args: [id, patch] });
    return Promise.resolve(this.updateAnswer);
  }

  delete(id: string): Promise<boolean> {
    this.calls.push({ method: 'delete', args: [id] });
    return Promise.resolve(this.deleteAnswer);
  }
}

describe('la administración de feriados', () => {
  let repository: RepositoryDouble;
  let recorded: AccessAuditEntry[];
  let service: HolidaysService;

  beforeEach(() => {
    repository = new RepositoryDouble();
    recorded = [];
    service = new HolidaysService(
      repository,
      new ConfigurationAuditTrail({
        record: (entry) => {
          recorded.push(entry);
          return Promise.resolve();
        },
      }),
    );
  });

  it('CF-060 crea un feriado sin sede como feriado de TODAS las sedes', () => {
    // `undefined` and `null` must land on the same row. If «no elegí sede» ever
    // became a site chosen by default, the holiday would stop applying to the
    // rest of the clinic without anybody noticing.
    return service
      .create({ date: '2026-05-01', name: 'Día del Trabajo' }, REQUESTER) // prettier-ignore
      .then(() => {
        expect(repository.calls[0]?.args[0]).toEqual({
          date: '2026-05-01',
          name: 'Día del Trabajo',
          siteId: null,
        });
      });
  });

  it('CF-060 conserva el alcance de una sede cuando se indica', async () => {
    await service.create(
      { date: '2026-05-01', name: 'Fiestas de la sede', siteId: 'site-9' },
      REQUESTER,
    );

    expect(repository.calls[0]?.args[0]).toMatchObject({ siteId: 'site-9' });
  });

  it('CF-066 deja en la bitácora quién creó el feriado', async () => {
    const created = await service.create(
      { date: '2026-01-01', name: 'Año Nuevo' },
      REQUESTER,
    );

    expect(recorded).toEqual([
      {
        userId: 'user-1',
        resourceType: 'configuration',
        resourceId: created.id,
        action: 'CREATE',
        ip: '10.0.0.1',
        userAgent: undefined,
      },
    ]);
  });

  it('CF-066 no escribe en la bitácora al listar', async () => {
    // REQ-111: registrar cada listado entierra los accesos que importan. Un
    // calendario de feriados no es contenido clínico.
    await service.list({ year: 2026 });

    expect(recorded).toEqual([]);
  });

  it('CF-060 no toca el alcance cuando la edición no lo menciona', async () => {
    // `undefined` es «déjalo como está» y `null` es «que valga para todas».
    // Colapsar los dos ampliaría el feriado de una sede a toda la clínica en
    // cada cambio de nombre.
    await service.update('holiday-1', { name: 'Año Nuevo (corregido)' }, REQUESTER); // prettier-ignore

    expect(repository.calls[0]?.args[1]).toEqual({
      date: undefined,
      name: 'Año Nuevo (corregido)',
    });
  });

  it('CF-060 amplía el alcance a todas las sedes cuando se envía nulo', async () => {
    await service.update('holiday-1', { siteId: null }, REQUESTER);

    expect(repository.calls[0]?.args[1]).toMatchObject({ siteId: null });
  });

  it('CF-060 responde HOLIDAY_NOT_FOUND al editar uno que ya no está', async () => {
    repository.updateAnswer = null;

    await expect(
      service.update('holiday-1', { name: 'X' }, REQUESTER),
    ).rejects.toBeInstanceOf(HolidayNotFoundError);
    expect(recorded).toEqual([]);
  });

  it('CF-060 responde HOLIDAY_NOT_FOUND al borrar uno que ya no está', async () => {
    repository.deleteAnswer = false;

    await expect(service.delete('holiday-1', REQUESTER)).rejects.toBeInstanceOf(
      HolidayNotFoundError,
    );
    expect(recorded).toEqual([]);
  });

  it('CF-066 deja constancia del borrado, que es lo único que queda de él', async () => {
    await service.delete('holiday-1', REQUESTER);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      resourceType: 'configuration',
      resourceId: 'holiday-1',
    });
  });
});
