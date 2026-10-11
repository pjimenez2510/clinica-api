import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import { SpecialtyNotFoundError } from '../../../shared/domain/errors/master-data.errors';
import type {
  SpecialtiesRepository,
  SpecialtyView,
} from '../domain/specialties.repository';
import { SpecialtiesService, type Requester } from './specialties.service';

/**
 * The rules that are the SERVICE's to enforce, against doubles of its port:
 * the code is derived once (SP-009, SP-010) and every mutation leaves an
 * audit entry (SP-002, SP-029). What the database guarantees — duplicates,
 * in-use — is exercised in
 * `test/integration/specialties-http.spec.ts` against a real PostgreSQL,
 * because a double that returns what we programmed cannot prove an index
 * exists.
 *
 * WHAT IS NO LONGER HERE: everything about a PRACTITIONER. SP-005, SP-008 and
 * SP-022 are implemented by ST-008 and ST-009 in `staff` since 13-08-2026, and
 * their tests moved with them. Nor the service types (SP-020..SP-031): since
 * ADR-013 a consultation is a service, administered by `billing`.
 */

const REQUESTER: Requester = { userId: 'user-1', ip: '10.0.0.1' };

const SPECIALTY: SpecialtyView = {
  id: 'spec-1',
  code: 'cardiologia',
  name: 'Cardiología',
  active: true,
};

/** What each test may tune before calling the service. */
interface Answers {
  findSpecialty: SpecialtyView | null;
  updateSpecialty: SpecialtyView | null;
  deleteSpecialty: boolean;
}

/** Every call the double receives, in order: writes AND reads. */
interface Call {
  method: string;
  args: unknown[];
}

function makeDouble(answers: Answers): {
  repository: SpecialtiesRepository;
  calls: Call[];
} {
  const calls: Call[] = [];
  const note = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };

  const repository: SpecialtiesRepository = {
    listSpecialties: (includeInactive) => {
      note('listSpecialties', includeInactive);
      return Promise.resolve([SPECIALTY]);
    },
    findSpecialty: (id) => {
      note('findSpecialty', id);
      return Promise.resolve(answers.findSpecialty);
    },
    createSpecialty: (input) => {
      note('createSpecialty', input);
      return Promise.resolve(SPECIALTY);
    },
    updateSpecialty: (id, patch) => {
      note('updateSpecialty', id, patch);
      return Promise.resolve(answers.updateSpecialty);
    },
    deleteSpecialty: (id) => {
      note('deleteSpecialty', id);
      return Promise.resolve(answers.deleteSpecialty);
    },
  };

  return { repository, calls };
}

const WRITE_METHODS = ['createSpecialty', 'updateSpecialty', 'deleteSpecialty'];

describe('SpecialtiesService', () => {
  let answers: Answers;
  let calls: Call[];
  let recorded: AccessAuditEntry[];
  let service: SpecialtiesService;

  beforeEach(() => {
    answers = {
      findSpecialty: SPECIALTY,
      updateSpecialty: SPECIALTY,
      deleteSpecialty: true,
    };
    const double = makeDouble(answers);
    calls = double.calls;
    recorded = [];
    service = new SpecialtiesService(double.repository, {
      record: (entry) => {
        recorded.push(entry);
        return Promise.resolve();
      },
    });
  });

  const writes = () =>
    calls.filter((call) => WRITE_METHODS.includes(call.method));

  describe('especialidades', () => {
    it('SP-002 crear una especialidad deja bitácora con autor y entidad', async () => {
      await service.createSpecialty({ name: 'Pediatría' }, REQUESTER);

      expect(recorded).toEqual([
        expect.objectContaining({
          userId: 'user-1',
          resourceType: 'configuration',
          resourceId: SPECIALTY.id,
          action: 'CREATE',
          ip: '10.0.0.1',
        }),
      ]);
    });

    it('SP-009 crear deriva el código del nombre: nadie lo teclea', async () => {
      await service.createSpecialty(
        { name: 'Ginecología y Obstetricia' },
        REQUESTER,
      );

      expect(calls.filter((call) => call.method === 'createSpecialty')).toEqual(
        [
          {
            method: 'createSpecialty',
            args: [
              { code: 'ginecologia-obstetricia', name: 'Ginecología y Obstetricia' }, // prettier-ignore
            ],
          },
        ],
      );
    });

    it('SP-010 renombrar NO vuelve a derivar el código: la fila no cambia de identidad', async () => {
      // Corregir la tilde de «Ginecologia» es el caso real, y es exactamente
      // el que se llevaría por delante `practitioner_specialty`, los informes
      // y el emparejamiento de la semilla si el código se recalculara.
      await service.updateSpecialty(
        SPECIALTY.id,
        { name: 'Ginecología y Obstetricia' },
        REQUESTER,
      );

      const patches = calls
        .filter((call) => call.method === 'updateSpecialty')
        .map((call) => call.args[1]);
      expect(patches).toEqual([{ name: 'Ginecología y Obstetricia' }]);
      // La aserción que sostiene el requisito es la AUSENCIA de `code`.
      expect(patches[0]).not.toHaveProperty('code');
    });

    it('SP-002 renombrar una especialidad deja bitácora como UPDATE', async () => {
      await service.updateSpecialty(
        SPECIALTY.id,
        { name: 'Cardiología clínica' },
        REQUESTER,
      );

      expect(recorded[0]).toMatchObject({
        action: 'UPDATE',
        resourceId: SPECIALTY.id,
      });
    });

    it('SP-007 el listado pasa el interruptor tal cual: por defecto solo activas', async () => {
      await service.listSpecialties(false);
      await service.listSpecialties(true);

      expect(
        calls
          .filter((call) => call.method === 'listSpecialties')
          .map((call) => call.args[0]),
      ).toEqual([false, true]);
    });

    it('SP-003 borrar una especialidad inexistente responde 404 y no deja bitácora', async () => {
      answers.deleteSpecialty = false;

      await expect(
        service.deleteSpecialty('missing', REQUESTER),
      ).rejects.toBeInstanceOf(SpecialtyNotFoundError);
      expect(recorded).toEqual([]);
    });
  });

  describe('bitácora con antes y después (SP-029)', () => {
    it('SP-029 records the specialty before and after a rename', async () => {
      answers.updateSpecialty = { ...SPECIALTY, name: 'Cardiología Clínica' };

      await service.updateSpecialty(
        SPECIALTY.id,
        { name: 'Cardiología Clínica' },
        REQUESTER,
      );

      expect(recorded[0]).toMatchObject({
        action: 'UPDATE',
        resourceType: 'configuration',
        resourceId: SPECIALTY.id,
      });
      expect(recorded[0]?.before).toEqual({
        code: 'cardiologia',
        name: 'Cardiología',
        active: true,
      });
      expect(recorded[0]?.after).toEqual({
        code: 'cardiologia',
        name: 'Cardiología Clínica',
        active: true,
      });
    });

    it('SP-029 editing a specialty that does not exist answers 404, writes nothing and records nothing', async () => {
      answers.findSpecialty = null;

      await expect(
        service.updateSpecialty('ghost', { name: 'X' }, REQUESTER),
      ).rejects.toBeInstanceOf(SpecialtyNotFoundError);
      expect(writes()).toEqual([]);
      expect(recorded).toEqual([]);
    });

    it('SP-029 a new specialty carries only the after half', async () => {
      await service.createSpecialty({ name: 'Cardiología' }, REQUESTER);

      expect(recorded[0]?.before).toBeUndefined();
      expect(recorded[0]?.after).toMatchObject({ name: 'Cardiología' });
    });
  });
});
