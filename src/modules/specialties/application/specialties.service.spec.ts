import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import {
  InactiveSpecialtyAssignmentError,
  PractitionerNotFoundError,
  PrimarySpecialtyRequiredError,
  ServiceTypeNotFoundError,
  SpecialtyNotFoundError,
} from '../domain/specialties.errors';
import type {
  SpecialtiesRepository,
  PractitionerDurationRow,
  PractitionerSpecialtyView,
  ServiceTypeView,
  SpecialtyView,
} from '../domain/specialties.repository';
import { SpecialtiesService, type Requester } from './specialties.service';

/**
 * The rules that are the SERVICE's to enforce, against doubles of its port:
 * exactly one primary (SP-005), no deactivated specialty for a NEW
 * assignment (SP-004), and an audit entry on every mutation (SP-002,
 * SP-027). What the database guarantees — duplicates, in-use, the CHECK —
 * is exercised in `test/integration/specialties-http.spec.ts` against a
 * real PostgreSQL, because a double that returns what we programmed cannot
 * prove an index exists.
 */

const REQUESTER: Requester = { userId: 'user-1', ip: '10.0.0.1' };

const SPECIALTY: SpecialtyView = {
  id: 'spec-1',
  code: 'cardiologia',
  name: 'Cardiología',
  active: true,
};

const INACTIVE: SpecialtyView = {
  id: 'spec-2',
  code: 'dermatologia',
  name: 'Dermatología',
  active: false,
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
  findSpecialtiesByIds: SpecialtyView[];
  findServiceType: ServiceTypeView | null;
  updateSpecialty: SpecialtyView | null;
  updateServiceType: ServiceTypeView | null;
  deleteSpecialty: boolean;
  deleteServiceType: boolean;
  deleteDurationException: boolean;
  practitionerExists: boolean;
  practitionerSpecialties: PractitionerSpecialtyView[];
  practitionerDurations: PractitionerDurationRow[];
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
    findSpecialtiesByIds: (ids) => {
      note('findSpecialtiesByIds', ids);
      return Promise.resolve(answers.findSpecialtiesByIds);
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
    findServiceType: (id) => {
      note('findServiceType', id);
      return Promise.resolve(answers.findServiceType);
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
    practitionerExists: (id) => {
      note('practitionerExists', id);
      return Promise.resolve(answers.practitionerExists);
    },
    listPractitionerSpecialties: (practitionerId) => {
      note('listPractitionerSpecialties', practitionerId);
      return Promise.resolve(answers.practitionerSpecialties);
    },
    replacePractitionerSpecialties: (practitionerId, items) => {
      note('replacePractitionerSpecialties', practitionerId, items);
      return Promise.resolve();
    },
    listPractitionerDurations: (practitionerId) => {
      note('listPractitionerDurations', practitionerId);
      return Promise.resolve(answers.practitionerDurations);
    },
    upsertDurationException: (practitionerId, serviceTypeId, minutes) => {
      note('upsertDurationException', practitionerId, serviceTypeId, minutes);
      return Promise.resolve();
    },
    deleteDurationException: (practitionerId, serviceTypeId) => {
      note('deleteDurationException', practitionerId, serviceTypeId);
      return Promise.resolve(answers.deleteDurationException);
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
  'replacePractitionerSpecialties',
  'upsertDurationException',
  'deleteDurationException',
];

describe('SpecialtiesService', () => {
  let answers: Answers;
  let calls: Call[];
  let recorded: AccessAuditEntry[];
  let service: SpecialtiesService;

  beforeEach(() => {
    answers = {
      findSpecialty: SPECIALTY,
      findSpecialtiesByIds: [SPECIALTY],
      findServiceType: SERVICE_TYPE,
      updateSpecialty: SPECIALTY,
      updateServiceType: { ...SERVICE_TYPE, durationMinutes: 25 },
      deleteSpecialty: true,
      deleteServiceType: true,
      deleteDurationException: true,
      practitionerExists: true,
      practitionerSpecialties: [],
      practitionerDurations: [],
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
      await service.createSpecialty(
        { code: 'pediatria', name: 'Pediatría' },
        REQUESTER,
      );

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
        { durationMinutes: 25 },
        REQUESTER,
      );

      // The load-bearing assertion is the ABSENCE: the one write that ran is
      // the service type's own update, so nothing already booked can have
      // been altered by a duration change — it rules forwards only.
      expect(writes()).toEqual([
        {
          method: 'updateServiceType',
          args: ['type-1', { durationMinutes: 25 }],
        },
      ]);
    });

    it('SP-027 toda mutación de tipos y duraciones deja bitácora', async () => {
      await service.createServiceType(
        { specialtyId: SPECIALTY.id, name: 'Control', durationMinutes: 20 },
        REQUESTER,
      );
      await service.updateServiceType('type-1', { durationMinutes: 25 }, REQUESTER); // prettier-ignore
      await service.deleteServiceType('type-1', REQUESTER);
      await service.setDurationException('prac-1', 'type-1', 30, REQUESTER);
      await service.removeDurationException('prac-1', 'type-1', REQUESTER);

      expect(recorded.map((entry) => entry.action)).toEqual([
        'CREATE',
        'UPDATE',
        'UPDATE',
        'UPDATE',
        'UPDATE',
      ]);
      expect(
        recorded.every((entry) => entry.resourceType === 'configuration'),
      ).toBe(true);
    });
  });

  describe('especialidades por profesional', () => {
    it('SP-005 rechaza la asignación sin ninguna principal', async () => {
      await expect(
        service.replacePractitionerSpecialties(
          'prac-1',
          [{ specialtyId: SPECIALTY.id, isPrimary: false }],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(PrimarySpecialtyRequiredError);
      expect(writes()).toEqual([]);
    });

    it('SP-005 rechaza la asignación con dos principales', async () => {
      await expect(
        service.replacePractitionerSpecialties(
          'prac-1',
          [
            { specialtyId: 'spec-1', isPrimary: true },
            { specialtyId: 'spec-2', isPrimary: true },
          ],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(PrimarySpecialtyRequiredError);
    });

    it('SP-005 rechaza la asignación vacía: al menos una especialidad', async () => {
      await expect(
        service.replacePractitionerSpecialties('prac-1', [], REQUESTER),
      ).rejects.toBeInstanceOf(PrimarySpecialtyRequiredError);
    });

    it('SP-004 rechaza una especialidad desactivada para una asignación NUEVA', async () => {
      answers.findSpecialtiesByIds = [INACTIVE];

      await expect(
        service.replacePractitionerSpecialties(
          'prac-1',
          [{ specialtyId: INACTIVE.id, isPrimary: true }],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(InactiveSpecialtyAssignmentError);
      expect(writes()).toEqual([]);
    });

    it('SP-004 conserva intacta una especialidad desactivada que el profesional ya tenía', async () => {
      answers.findSpecialtiesByIds = [INACTIVE];
      answers.practitionerSpecialties = [
        {
          specialtyId: INACTIVE.id,
          code: INACTIVE.code,
          name: INACTIVE.name,
          active: false,
          isPrimary: true,
        },
      ];

      await service.replacePractitionerSpecialties(
        'prac-1',
        [{ specialtyId: INACTIVE.id, isPrimary: true }],
        REQUESTER,
      );

      expect(writes()).toEqual([
        {
          method: 'replacePractitionerSpecialties',
          args: ['prac-1', [{ specialtyId: INACTIVE.id, isPrimary: true }]],
        },
      ]);
    });

    it('SP-005 una especialidad desconocida en la asignación responde 404', async () => {
      answers.findSpecialtiesByIds = [];

      await expect(
        service.replacePractitionerSpecialties(
          'prac-1',
          [{ specialtyId: 'ghost', isPrimary: true }],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(SpecialtyNotFoundError);
    });

    it('SP-008 el profesional inexistente responde 404 antes de listar', async () => {
      answers.practitionerExists = false;

      await expect(
        service.listPractitionerSpecialties('ghost'),
      ).rejects.toBeInstanceOf(PractitionerNotFoundError);
    });
  });

  describe('excepciones de duración', () => {
    it('SP-022 fija la excepción tras comprobar profesional y tipo', async () => {
      await service.setDurationException('prac-1', 'type-1', 45, REQUESTER);

      expect(writes()).toEqual([
        {
          method: 'upsertDurationException',
          args: ['prac-1', 'type-1', 45],
        },
      ]);
    });

    it('SP-022 rechaza la excepción sobre un tipo inexistente', async () => {
      answers.findServiceType = null;

      await expect(
        service.setDurationException('prac-1', 'ghost', 45, REQUESTER),
      ).rejects.toBeInstanceOf(ServiceTypeNotFoundError);
      expect(writes()).toEqual([]);
    });

    it('SP-022 retirar una excepción que no existe no es un error ni deja bitácora', async () => {
      answers.deleteDurationException = false;

      await service.removeDurationException('prac-1', 'type-1', REQUESTER);

      expect(recorded).toEqual([]);
    });

    it('SP-023/SP-028 el listado resuelve excepción → base con la función del dominio', async () => {
      answers.practitionerDurations = [
        {
          serviceTypeId: 'type-1',
          serviceTypeName: 'Control',
          specialtyId: SPECIALTY.id,
          specialtyName: SPECIALTY.name,
          baseMinutes: 20,
          exceptionMinutes: 45,
        },
        {
          serviceTypeId: 'type-2',
          serviceTypeName: 'Primera vez',
          specialtyId: SPECIALTY.id,
          specialtyName: SPECIALTY.name,
          baseMinutes: 30,
          exceptionMinutes: null,
        },
      ];

      const rows = await service.listPractitionerDurations('prac-1');

      expect(rows.map((row) => row.resolvedMinutes)).toEqual([45, 30]);
    });
  });
});
