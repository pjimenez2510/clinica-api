import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import {
  ServiceTypeNotFoundError,
  SpecialtyNotFoundError,
} from '../../../shared/domain/errors/master-data.errors';
import {
  InactiveSpecialtyAssignmentError,
  PractitionerNotFoundError,
  PrimarySpecialtyRequiredError,
} from '../domain/staff.errors';
import type {
  PractitionerDurationRow,
  PractitionerSiteView,
  PractitionerSpecialtyView,
  PractitionerView,
  SpecialtyReference,
  StaffRepository,
} from '../domain/staff.repository';

import { PractitionerAssignmentsService } from './practitioner-assignments.service';
import { type Requester, StaffAuditTrail } from './staff-audit.trail';

/**
 * The rules the SERVICE owns for ST-007, ST-008 and ST-009, against a double
 * of its port. What the base owns — the partial unique index behind «at most
 * one primary», the duration CHECK, the site foreign key — is exercised in
 * `test/integration/staff-http.spec.ts`.
 *
 * THESE TESTS CAME FROM `specialties` ON 13-08-2026 with the endpoints they
 * cover, and they still name SP-004: the requirement about a deactivated
 * specialty is the catalogue's, only its enforcement point moved.
 */
const REQUESTER: Requester = { userId: 'user-1', ip: '10.0.0.1' };

const ACTIVE: SpecialtyReference = { id: 'spec-1', active: true };
const INACTIVE: SpecialtyReference = { id: 'spec-2', active: false };

const PRACTITIONER = { id: 'prac-1' } as PractitionerView;

interface Answers {
  findPractitioner: PractitionerView | null;
  findSpecialtiesByIds: SpecialtyReference[];
  specialties: PractitionerSpecialtyView[];
  durations: PractitionerDurationRow[];
  sites: PractitionerSiteView[];
  serviceTypeExists: boolean;
  deleteDurationException: boolean;
}

interface Call {
  method: string;
  args: unknown[];
}

function makeDouble(answers: Answers): {
  repository: StaffRepository;
  calls: Call[];
} {
  const calls: Call[] = [];
  const note = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };

  const repository = {
    findPractitioner: (id: string) => {
      note('findPractitioner', id);
      return Promise.resolve(answers.findPractitioner);
    },
    listPractitionerSpecialties: (practitionerId: string) => {
      note('listPractitionerSpecialties', practitionerId);
      return Promise.resolve(answers.specialties);
    },
    findSpecialtiesByIds: (ids: readonly string[]) => {
      note('findSpecialtiesByIds', ids);
      return Promise.resolve(answers.findSpecialtiesByIds);
    },
    replacePractitionerSpecialties: (
      practitionerId: string,
      items: unknown,
    ) => {
      note('replacePractitionerSpecialties', practitionerId, items);
      return Promise.resolve();
    },
    listPractitionerDurations: (practitionerId: string) => {
      note('listPractitionerDurations', practitionerId);
      return Promise.resolve(answers.durations);
    },
    serviceTypeExists: (id: string) => {
      note('serviceTypeExists', id);
      return Promise.resolve(answers.serviceTypeExists);
    },
    upsertDurationException: (
      practitionerId: string,
      serviceTypeId: string,
      minutes: number,
    ) => {
      note('upsertDurationException', practitionerId, serviceTypeId, minutes);
      return Promise.resolve();
    },
    deleteDurationException: (
      practitionerId: string,
      serviceTypeId: string,
    ) => {
      note('deleteDurationException', practitionerId, serviceTypeId);
      return Promise.resolve(answers.deleteDurationException);
    },
    listPractitionerSites: (practitionerId: string) => {
      note('listPractitionerSites', practitionerId);
      return Promise.resolve(answers.sites);
    },
    replacePractitionerSites: (practitionerId: string, siteIds: unknown) => {
      note('replacePractitionerSites', practitionerId, siteIds);
      return Promise.resolve();
    },
  } as unknown as StaffRepository;

  return { repository, calls };
}

const WRITE_METHODS = [
  'replacePractitionerSpecialties',
  'replacePractitionerSites',
  'upsertDurationException',
  'deleteDurationException',
];

describe('PractitionerAssignmentsService', () => {
  let answers: Answers;
  let calls: Call[];
  let recorded: AccessAuditEntry[];
  let service: PractitionerAssignmentsService;

  beforeEach(() => {
    answers = {
      findPractitioner: PRACTITIONER,
      findSpecialtiesByIds: [ACTIVE],
      specialties: [],
      durations: [],
      sites: [],
      serviceTypeExists: true,
      deleteDurationException: true,
    };
    const double = makeDouble(answers);
    calls = double.calls;
    recorded = [];
    service = new PractitionerAssignmentsService(
      double.repository,
      new StaffAuditTrail({
        record: (entry) => {
          recorded.push(entry);
          return Promise.resolve();
        },
      }),
    );
  });

  const writes = () =>
    calls.filter((call) => WRITE_METHODS.includes(call.method));

  describe('sedes donde atiende', () => {
    it('ST-007 fijar las sedes es un reemplazo completo y deja bitácora', async () => {
      await service.replaceSites('prac-1', ['site-1', 'site-2'], REQUESTER);

      expect(writes()).toEqual([
        {
          method: 'replacePractitionerSites',
          args: ['prac-1', ['site-1', 'site-2']],
        },
      ]);
      expect(recorded[0]).toMatchObject({
        action: 'UPDATE',
        resourceType: 'staff',
        resourceId: 'prac-1',
      });
    });

    it('ST-007 una lista vacía es legal: quien está de baja larga no atiende en ninguna', async () => {
      await service.replaceSites('prac-1', [], REQUESTER);

      expect(writes()).toEqual([
        { method: 'replacePractitionerSites', args: ['prac-1', []] },
      ]);
    });

    it('ST-007 el profesional inexistente responde 404 antes de escribir', async () => {
      answers.findPractitioner = null;

      await expect(
        service.replaceSites('ghost', ['site-1'], REQUESTER),
      ).rejects.toBeInstanceOf(PractitionerNotFoundError);
      expect(writes()).toEqual([]);
    });
  });

  describe('especialidades que ejerce', () => {
    it('ST-008 rechaza la asignación sin ninguna principal', async () => {
      await expect(
        service.replaceSpecialties(
          'prac-1',
          [{ specialtyId: ACTIVE.id, isPrimary: false }],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(PrimarySpecialtyRequiredError);
      expect(writes()).toEqual([]);
    });

    it('ST-008 rechaza la asignación con dos principales', async () => {
      await expect(
        service.replaceSpecialties(
          'prac-1',
          [
            { specialtyId: 'spec-1', isPrimary: true },
            { specialtyId: 'spec-2', isPrimary: true },
          ],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(PrimarySpecialtyRequiredError);
    });

    it('ST-008 rechaza la asignación vacía: al menos una especialidad', async () => {
      await expect(
        service.replaceSpecialties('prac-1', [], REQUESTER),
      ).rejects.toBeInstanceOf(PrimarySpecialtyRequiredError);
    });

    it('ST-008/SP-004 rechaza una especialidad desactivada para una asignación NUEVA', async () => {
      answers.findSpecialtiesByIds = [INACTIVE];

      await expect(
        service.replaceSpecialties(
          'prac-1',
          [{ specialtyId: INACTIVE.id, isPrimary: true }],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(InactiveSpecialtyAssignmentError);
      expect(writes()).toEqual([]);
    });

    it('ST-008/SP-004 conserva intacta una desactivada que el profesional ya tenía', async () => {
      answers.findSpecialtiesByIds = [INACTIVE];
      answers.specialties = [
        {
          specialtyId: INACTIVE.id,
          code: 'dermatologia',
          name: 'Dermatología',
          active: false,
          isPrimary: true,
        },
      ];

      await service.replaceSpecialties(
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

    it('ST-008 una especialidad desconocida en la asignación responde 404', async () => {
      answers.findSpecialtiesByIds = [];

      await expect(
        service.replaceSpecialties(
          'prac-1',
          [{ specialtyId: 'ghost', isPrimary: true }],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(SpecialtyNotFoundError);
    });

    it('ST-008 el profesional inexistente responde 404 antes de listar', async () => {
      answers.findPractitioner = null;

      await expect(service.listSpecialties('ghost')).rejects.toBeInstanceOf(
        PractitionerNotFoundError,
      );
    });
  });

  describe('excepciones de duración', () => {
    it('ST-009 fija la excepción tras comprobar profesional y tipo', async () => {
      await service.setDurationException('prac-1', 'type-1', 45, REQUESTER);

      expect(writes()).toEqual([
        { method: 'upsertDurationException', args: ['prac-1', 'type-1', 45] },
      ]);
      expect(recorded[0]).toMatchObject({ resourceType: 'staff' });
    });

    it('ST-009 rechaza la excepción sobre un tipo de atención inexistente', async () => {
      answers.serviceTypeExists = false;

      await expect(
        service.setDurationException('prac-1', 'ghost', 45, REQUESTER),
      ).rejects.toBeInstanceOf(ServiceTypeNotFoundError);
      expect(writes()).toEqual([]);
    });

    it('ST-009 retirar una excepción que no existe no es un error ni deja bitácora', async () => {
      answers.deleteDurationException = false;

      await service.removeDurationException('prac-1', 'type-1', REQUESTER);

      expect(recorded).toEqual([]);
    });

    it('ST-009/SP-023 el listado resuelve excepción → base con la función compartida', async () => {
      answers.durations = [
        {
          serviceTypeId: 'type-1',
          serviceTypeName: 'Control',
          specialtyId: 'spec-1',
          specialtyName: 'Cardiología',
          baseMinutes: 20,
          exceptionMinutes: 45,
        },
        {
          serviceTypeId: 'type-2',
          serviceTypeName: 'Primera vez',
          specialtyId: 'spec-1',
          specialtyName: 'Cardiología',
          baseMinutes: 30,
          exceptionMinutes: null,
        },
      ];

      const rows = await service.listDurations('prac-1');

      expect(rows.map((row) => row.resolvedMinutes)).toEqual([45, 30]);
    });
  });
});
