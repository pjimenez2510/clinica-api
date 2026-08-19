import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import { SpecialtyNotFoundError } from '../../../shared/domain/errors/master-data.errors';
import { DurationNotSlotMultipleError } from '../../../shared/domain/errors/slot-atom.errors';
import type {
  SpecialtiesRepository,
  ServiceTypeView,
  SpecialtyView,
} from '../domain/specialties.repository';
import { SpecialtiesService, type Requester } from './specialties.service';

/**
 * The rules that are the SERVICE's to enforce, against doubles of its port:
 * the specialty must exist before a service type hangs from it (SP-020), a
 * duration change touches nothing already booked (SP-024), and every mutation
 * leaves an audit entry (SP-002, SP-027). What the database guarantees —
 * duplicates, in-use, the CHECK — is exercised in
 * `test/integration/specialties-http.spec.ts` against a real PostgreSQL,
 * because a double that returns what we programmed cannot prove an index
 * exists.
 *
 * WHAT IS NO LONGER HERE: everything about a PRACTITIONER. SP-005, SP-008 and
 * SP-022 are implemented by ST-008 and ST-009 in `staff` since 13-08-2026, and
 * their tests moved with them.
 */

const REQUESTER: Requester = { userId: 'user-1', ip: '10.0.0.1' };

const SPECIALTY: SpecialtyView = {
  id: 'spec-1',
  code: 'cardiologia',
  name: 'Cardiología',
  active: true,
};

const SERVICE_TYPE: ServiceTypeView = {
  id: 'type-1',
  specialtyId: SPECIALTY.id,
  name: 'Control',
  durationMinutes: 20,
  active: true,
};

/** What each test may tune before calling the service. */
interface Answers {
  findSpecialty: SpecialtyView | null;
  updateSpecialty: SpecialtyView | null;
  updateServiceType: ServiceTypeView | null;
  deleteSpecialty: boolean;
  deleteServiceType: boolean;
  /** D-021: what each site dices its day into. */
  siteSlotAtoms: number[];
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
    listServiceTypes: (specialtyId, includeInactive) => {
      note('listServiceTypes', specialtyId, includeInactive);
      return Promise.resolve([SERVICE_TYPE]);
    },
    createServiceType: (input) => {
      note('createServiceType', input);
      return Promise.resolve(SERVICE_TYPE);
    },
    updateServiceType: (id, patch) => {
      note('updateServiceType', id, patch);
      return Promise.resolve(answers.updateServiceType);
    },
    deleteServiceType: (id) => {
      note('deleteServiceType', id);
      return Promise.resolve(answers.deleteServiceType);
    },
    siteSlotAtoms: () => {
      note('siteSlotAtoms');
      return Promise.resolve(answers.siteSlotAtoms);
    },
  };

  return { repository, calls };
}

const WRITE_METHODS = [
  'createSpecialty',
  'updateSpecialty',
  'deleteSpecialty',
  'createServiceType',
  'updateServiceType',
  'deleteServiceType',
];

describe('SpecialtiesService', () => {
  let answers: Answers;
  let calls: Call[];
  let recorded: AccessAuditEntry[];
  let service: SpecialtiesService;

  beforeEach(() => {
    answers = {
      findSpecialty: SPECIALTY,
      updateSpecialty: SPECIALTY,
      updateServiceType: { ...SERVICE_TYPE, durationMinutes: 30 },
      deleteSpecialty: true,
      deleteServiceType: true,
      siteSlotAtoms: [10],
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

  describe('tipos de atención', () => {
    it('SP-020 crear un tipo exige que la especialidad exista', async () => {
      answers.findSpecialty = null;

      await expect(
        service.createServiceType(
          { specialtyId: 'missing', name: 'Control', durationMinutes: 20 },
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(SpecialtyNotFoundError);
      expect(writes()).toEqual([]);
    });

    it('SP-024 cambiar una duración toca solo el tipo: ninguna otra escritura', async () => {
      await service.updateServiceType(
        'type-1',
        { durationMinutes: 30 },
        REQUESTER,
      );

      // The load-bearing assertion is the ABSENCE: the one write that ran is
      // the service type's own update, so nothing already booked can have
      // been altered by a duration change — it rules forwards only.
      expect(writes()).toEqual([
        {
          method: 'updateServiceType',
          args: ['type-1', { durationMinutes: 30 }],
        },
      ]);
    });

    it('SP-027 toda mutación de tipos de atención deja bitácora', async () => {
      await service.createServiceType(
        { specialtyId: SPECIALTY.id, name: 'Control', durationMinutes: 20 },
        REQUESTER,
      );
      await service.updateServiceType('type-1', { durationMinutes: 30 }, REQUESTER); // prettier-ignore
      await service.deleteServiceType('type-1', REQUESTER);

      expect(recorded.map((entry) => entry.action)).toEqual([
        'CREATE',
        'UPDATE',
        'UPDATE',
      ]);
      expect(
        recorded.every((entry) => entry.resourceType === 'configuration'),
      ).toBe(true);
    });

    /**
     * SP-021 since D-021: the base duration has to tile the grid, and it is
     * refused AT SAVE TIME rather than at the counter.
     */
    describe('SP-021 la duración es múltiplo del turno de la agenda', () => {
      it('SP-021 rechaza al CREAR una duración que no es múltiplo, sin escribir', async () => {
        const rejection = await service
          .createServiceType(
            { specialtyId: SPECIALTY.id, name: 'Control', durationMinutes: 25 },
            REQUESTER,
          )
          .catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(DurationNotSlotMultipleError);
        const failure = rejection as DurationNotSlotMultipleError;
        expect(failure.fieldErrors?.[0]?.field).toBe('durationMinutes');
        // NOMBRA EL ÁTOMO: es lo único que le dice a quien administra qué
        // escribir en su lugar.
        expect(failure.fieldErrors?.[0]?.message).toContain('10 minutos');
        expect(writes()).toEqual([]);
        expect(recorded).toEqual([]);
      });

      it('SP-021 rechaza al EDITAR una duración que no es múltiplo, sin escribir', async () => {
        await expect(
          service.updateServiceType(
            'type-1',
            { durationMinutes: 25 },
            REQUESTER,
          ),
        ).rejects.toBeInstanceOf(DurationNotSlotMultipleError);
        expect(writes()).toEqual([]);
      });

      it('SP-021 exige el múltiplo de TODAS las sedes, porque el tipo no es de ninguna', async () => {
        // Sedes de 10 y de 15: sólo los múltiplos de 30 se pueden reservar en
        // las dos, y un tipo de atención se puede dar en cualquiera.
        answers.siteSlotAtoms = [10, 15];

        await expect(
          service.createServiceType(
            { specialtyId: SPECIALTY.id, name: 'Control', durationMinutes: 20 },
            REQUESTER,
          ),
        ).rejects.toBeInstanceOf(DurationNotSlotMultipleError);

        await expect(
          service.createServiceType(
            { specialtyId: SPECIALTY.id, name: 'Control', durationMinutes: 30 },
            REQUESTER,
          ),
        ).resolves.toBeDefined();
      });

      it('SP-021 no estorba a un cambio que no toca la duración', async () => {
        // `undefined` significa «déjala como está», y una duración que ya
        // estaba guardada no se vuelve inválida por renombrar el tipo.
        await expect(
          service.updateServiceType('type-1', { name: 'Control largo' }, REQUESTER), // prettier-ignore
        ).resolves.toBeDefined();
        expect(calls.filter((call) => call.method === 'siteSlotAtoms')).toEqual(
          [],
        );
      });
    });
  });
});
