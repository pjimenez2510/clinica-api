import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import { HolidayNotFoundError } from '../domain/configuration.errors';
import type {
  HolidayChange,
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
  workedBySiteIds: [],
};

interface Call {
  method: string;
  args: unknown[];
}

const RENAMED: HolidayView = { ...HOLIDAY, name: 'Año Nuevo (corregido)' };
const WORKED: HolidayView = { ...HOLIDAY, workedBySiteIds: ['site-9'] };

class RepositoryDouble implements HolidayRepository {
  readonly calls: Call[] = [];
  /**
   * AG-097, CF-066, D-017: a mutation answers with BOTH sides. The adapter
   * reads the previous row inside the transaction that overwrites it, which is
   * the only read that can honestly be called «desde qué valor».
   */
  updateAnswer: HolidayChange | null = { before: HOLIDAY, after: RENAMED };
  /** The row that disappeared, which is all a deletion leaves behind. */
  deleteAnswer: HolidayView | null = HOLIDAY;
  /** AG-092. `null` is «that holiday is gone», for both exception methods. */
  exceptionAnswer: HolidayChange | null = { before: HOLIDAY, after: WORKED };

  list(query: HolidayQuery): Promise<readonly HolidayView[]> {
    this.calls.push({ method: 'list', args: [query] });
    return Promise.resolve([HOLIDAY]);
  }

  create(input: HolidayInput): Promise<HolidayView> {
    this.calls.push({ method: 'create', args: [input] });
    return Promise.resolve({ ...HOLIDAY, ...input });
  }

  update(id: string, patch: HolidayPatch): Promise<HolidayChange | null> {
    this.calls.push({ method: 'update', args: [id, patch] });
    return Promise.resolve(this.updateAnswer);
  }

  delete(id: string): Promise<HolidayView | null> {
    this.calls.push({ method: 'delete', args: [id] });
    return Promise.resolve(this.deleteAnswer);
  }

  markWorkedBy(
    holidayId: string,
    siteId: string,
  ): Promise<HolidayChange | null> {
    this.calls.push({ method: 'markWorkedBy', args: [holidayId, siteId] });
    return Promise.resolve(this.exceptionAnswer);
  }

  unmarkWorkedBy(
    holidayId: string,
    siteId: string,
  ): Promise<HolidayChange | null> {
    this.calls.push({ method: 'unmarkWorkedBy', args: [holidayId, siteId] });
    return Promise.resolve(this.exceptionAnswer);
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
        // Nothing was replaced, so there is no previous value to claim.
        before: undefined,
        after: created,
      },
    ]);
  });

  it('AG-097 registra desde qué valor cambió el feriado', async () => {
    // D-017. A holiday is a date, a name and a scope — no PHI anywhere in it,
    // which is what makes it one of the resource types the base lets carry a
    // payload at all.
    await service.update('holiday-1', { name: 'Año Nuevo (corregido)' }, REQUESTER); // prettier-ignore

    expect(recorded[0]?.before).toEqual(HOLIDAY);
    expect(recorded[0]?.after).toEqual(RENAMED);
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
    repository.deleteAnswer = null;

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

  it('AG-097 el borrado deja el valor que desapareció y nada después', async () => {
    // The one mutation where `before` is the whole record: after it, the row
    // does not exist anywhere else.
    await service.delete('holiday-1', REQUESTER);

    expect(recorded[0]?.before).toEqual(HOLIDAY);
    expect(recorded[0]?.after).toBeUndefined();
  });

  it('AG-092 marca que una sede trabaja el feriado sin borrarlo para las demás', async () => {
    // El feriado sigue existiendo con su alcance intacto: lo que se añade es
    // la excepción de esa sede. Borrarlo abriría también a las demás, que es
    // justo lo que AG-092 existe para evitar.
    const holiday = await service.markWorkedBy(
      'holiday-1',
      'site-9',
      REQUESTER,
    );

    expect(repository.calls[0]).toEqual({
      method: 'markWorkedBy',
      args: ['holiday-1', 'site-9'],
    });
    expect(holiday).toMatchObject({
      siteId: null,
      workedBySiteIds: ['site-9'],
    });
  });

  it('AG-092 responde HOLIDAY_NOT_FOUND al marcar un feriado que ya no está', async () => {
    repository.exceptionAnswer = null;

    await expect(
      service.markWorkedBy('holiday-1', 'site-9', REQUESTER),
    ).rejects.toBeInstanceOf(HolidayNotFoundError);
    expect(recorded).toEqual([]);
  });

  it('AG-092 devuelve la sede a observar el feriado', async () => {
    repository.exceptionAnswer = { before: WORKED, after: HOLIDAY };

    const holiday = await service.unmarkWorkedBy(
      'holiday-1',
      'site-9',
      REQUESTER,
    );

    expect(repository.calls[0]).toEqual({
      method: 'unmarkWorkedBy',
      args: ['holiday-1', 'site-9'],
    });
    expect(holiday.workedBySiteIds).toEqual([]);
  });

  it('AG-092 responde HOLIDAY_NOT_FOUND al desmarcar un feriado que ya no está', async () => {
    repository.exceptionAnswer = null;

    await expect(
      service.unmarkWorkedBy('holiday-1', 'site-9', REQUESTER),
    ).rejects.toBeInstanceOf(HolidayNotFoundError);
    expect(recorded).toEqual([]);
  });

  it('CF-066 deja en la bitácora quién cambió la excepción de AG-092', async () => {
    // La mutación es sobre el FERIADO —es su lista de excepciones la que
    // cambia—, así que la bitácora nombra el feriado y no la sede.
    await service.markWorkedBy('holiday-1', 'site-9', REQUESTER);
    await service.unmarkWorkedBy('holiday-1', 'site-9', REQUESTER);

    expect(recorded).toEqual([
      {
        userId: 'user-1',
        resourceType: 'configuration',
        resourceId: 'holiday-1',
        action: 'UPDATE',
        ip: '10.0.0.1',
        userAgent: undefined,
        before: HOLIDAY,
        after: WORKED,
      },
      {
        userId: 'user-1',
        resourceType: 'configuration',
        resourceId: 'holiday-1',
        action: 'UPDATE',
        ip: '10.0.0.1',
        userAgent: undefined,
        before: HOLIDAY,
        after: WORKED,
      },
    ]);
  });

  it('AG-097 la excepción de AG-092 también dice qué sedes trabajaban antes', async () => {
    // Which sites worked the holiday IS the value that changed here, so a
    // trail without it says a holiday was touched and not what happened to it.
    repository.exceptionAnswer = { before: HOLIDAY, after: WORKED };
    await service.markWorkedBy('holiday-1', 'site-9', REQUESTER);

    expect(recorded[0]?.before).toMatchObject({ workedBySiteIds: [] });
    expect(recorded[0]?.after).toMatchObject({ workedBySiteIds: ['site-9'] });
  });
});
