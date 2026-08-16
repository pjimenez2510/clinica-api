import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import { Principal } from '../../../shared/authorisation/principal';
import { SiteScopeDeniedError } from '../../../shared/authorisation/site-scope';
import { DurationNotSlotMultipleError } from '../../../shared/domain/errors/slot-atom.errors';
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

/** ST-047. The clinic-wide grant: `siteId: null` is every site, present and future. */
const DIRECTOR = new Principal('user-1', [
  { roleCode: 'ADMIN', siteId: null, permissions: ['staff:manage'] },
]);
/** ST-047. `staff:manage`, granted for Norte and for nowhere else. */
const NORTE_ADMIN = new Principal('user-2', [
  { roleCode: 'ADMIN', siteId: 'site-norte', permissions: ['staff:manage'] },
]);

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
  /** D-021: what each site dices its day into. */
  siteSlotAtoms: number[];
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
    siteSlotAtoms: () => {
      note('siteSlotAtoms');
      return Promise.resolve(answers.siteSlotAtoms);
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
      siteSlotAtoms: [10],
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
      await service.replaceSites(
        'prac-1',
        ['site-1', 'site-2'],
        REQUESTER,
        DIRECTOR,
      );

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
      await service.replaceSites('prac-1', [], REQUESTER, DIRECTOR);

      expect(writes()).toEqual([
        { method: 'replacePractitionerSites', args: ['prac-1', []] },
      ]);
    });

    it('ST-007 el profesional inexistente responde 404 antes de escribir', async () => {
      answers.findPractitioner = null;

      await expect(
        service.replaceSites('ghost', ['site-1'], REQUESTER, DIRECTOR),
      ).rejects.toBeInstanceOf(PractitionerNotFoundError);
      expect(writes()).toEqual([]);
    });

    it('ST-047 rechaza sin escribir la sede que queda fuera del alcance de quien llama', async () => {
      answers.sites = [{ siteId: 'site-norte' } as PractitionerSiteView];

      await expect(
        service.replaceSites(
          'prac-1',
          ['site-norte', 'site-sur'],
          REQUESTER,
          NORTE_ADMIN,
        ),
      ).rejects.toBeInstanceOf(SiteScopeDeniedError);
      expect(writes()).toEqual([]);
    });

    it('ST-047 rechaza también QUITAR una sede fuera del alcance: el PUT reemplaza el conjunto', async () => {
      // El profesional atiende en las dos; enviar sólo Norte borraría la fila
      // de Sur, y desaparecería del listado de agendables de otra ciudad.
      answers.sites = [
        { siteId: 'site-norte' } as PractitionerSiteView,
        { siteId: 'site-sur' } as PractitionerSiteView,
      ];

      await expect(
        service.replaceSites('prac-1', ['site-norte'], REQUESTER, NORTE_ADMIN),
      ).rejects.toBeInstanceOf(SiteScopeDeniedError);
      expect(writes()).toEqual([]);
    });

    it('ST-047 dentro de su alcance escribe: la comprobación no es un muro', async () => {
      answers.sites = [{ siteId: 'site-norte' } as PractitionerSiteView];

      await service.replaceSites(
        'prac-1',
        ['site-norte'],
        REQUESTER,
        NORTE_ADMIN,
      );

      expect(writes()).toEqual([
        {
          method: 'replacePractitionerSites',
          args: ['prac-1', ['site-norte']],
        },
      ]);
    });
  });

  describe('especialidades que ejerce', () => {
    it('ST-008/SP-005 rechaza la asignación sin ninguna principal', async () => {
      await expect(
        service.replaceSpecialties(
          'prac-1',
          [{ specialtyId: ACTIVE.id, isPrimary: false }],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(PrimarySpecialtyRequiredError);
      expect(writes()).toEqual([]);
    });

    it('ST-008/SP-005 rechaza la asignación con dos principales', async () => {
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
    it('ST-009/SP-022 fija la excepción tras comprobar profesional y tipo', async () => {
      await service.setDurationException('prac-1', 'type-1', 40, REQUESTER);

      expect(writes()).toEqual([
        { method: 'upsertDurationException', args: ['prac-1', 'type-1', 40] },
      ]);
      expect(recorded[0]).toMatchObject({ resourceType: 'staff' });
    });

    /**
     * SP-022 desde D-021. La excepción es el peldaño que GANA (SP-023), así
     * que dejarla fuera haría cosmética la garantía: todos los tipos podrían
     * encajar en la rejilla y la sobreescritura de un solo médico dejaría sin
     * reservar todas sus citas.
     */
    it('SP-022 rechaza una excepción que no es múltiplo del turno, sin escribir', async () => {
      const rejection = await service
        .setDurationException('prac-1', 'type-1', 45, REQUESTER)
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(DurationNotSlotMultipleError);
      const failure = rejection as DurationNotSlotMultipleError;
      expect(failure.fieldErrors?.[0]?.field).toBe('durationMinutes');
      expect(failure.fieldErrors?.[0]?.message).toContain('10 minutos');
      expect(writes()).toEqual([]);
      expect(recorded).toEqual([]);
    });

    it('SP-022 exige el múltiplo de TODAS las sedes, no de las del profesional', async () => {
      // La excepción cuelga de un `service_type`, que no tiene sede, y a un
      // médico se le puede añadir otra sede mañana sin que nadie vuelva a
      // mirar sus excepciones.
      answers.siteSlotAtoms = [10, 15];

      await expect(
        service.setDurationException('prac-1', 'type-1', 20, REQUESTER),
      ).rejects.toBeInstanceOf(DurationNotSlotMultipleError);
      await expect(
        service.setDurationException('prac-1', 'type-1', 60, REQUESTER),
      ).resolves.toBeUndefined();
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
