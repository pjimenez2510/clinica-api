import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import {
  type ClinicalDate,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import {
  AcessExpiredError,
  AcessMissingError,
  PractitionerInUseError,
  PractitionerNotFoundError,
} from '../domain/staff.errors';
import type {
  AcessExpiryRow,
  PractitionerView,
  StaffRepository,
} from '../domain/staff.repository';

import { PractitionerService } from './practitioner.service';
import { type Requester, StaffAuditTrail } from './staff-audit.trail';

/**
 * The rules that are the SERVICE's to enforce, against a double of its port:
 * the refusal to sign with an expired habilitación (ST-004), the warning
 * window (ST-005), and an audit entry on every mutation (ST-010). What the
 * database guarantees — the RESTRICT that produces `PRACTITIONER_IN_USE`, the
 * unique cedula — is exercised in `test/integration/staff-http.spec.ts`
 * against a real PostgreSQL, because a double that returns what we programmed
 * cannot prove a constraint exists.
 */
const REQUESTER: Requester = { userId: 'user-1', ip: '10.0.0.1' };
const on = (value: string): ClinicalDate => parseClinicalDate(value);

const PRACTITIONER: PractitionerView = {
  id: 'prac-1',
  userId: 'user-9',
  firstName: 'Ana',
  lastName: 'Villacís',
  email: 'ana@clinica.ec',
  cedula: '1710034065',
  acessRegistration: 'ACESS-1001',
  acessExpiresOn: on('2027-01-01'),
  mspCode: 'MSP-42',
  schedulable: true,
  active: true,
  primarySpecialty: null,
  siteIds: [],
};

interface Answers {
  findPractitioner: PractitionerView | null;
  updatePractitioner: PractitionerView | null;
  deletePractitioner: boolean | 'in-use';
  acessExpiring: AcessExpiryRow[];
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
  const unused = () => Promise.reject(new Error('not used by these tests'));

  const repository = {
    listPractitioners: (includeInactive: boolean) => {
      note('listPractitioners', includeInactive);
      return Promise.resolve([PRACTITIONER]);
    },
    findPractitioner: (id: string) => {
      note('findPractitioner', id);
      return Promise.resolve(answers.findPractitioner);
    },
    createPractitioner: (input: unknown) => {
      note('createPractitioner', input);
      return Promise.resolve(PRACTITIONER);
    },
    updatePractitioner: (id: string, patch: unknown) => {
      note('updatePractitioner', id, patch);
      return Promise.resolve(answers.updatePractitioner);
    },
    deletePractitioner: (id: string) => {
      note('deletePractitioner', id);
      if (answers.deletePractitioner === 'in-use') {
        return Promise.reject(new PractitionerInUseError());
      }
      return Promise.resolve(answers.deletePractitioner);
    },
    listAcessExpiringThrough: (through: ClinicalDate) => {
      note('listAcessExpiringThrough', through);
      return Promise.resolve(answers.acessExpiring);
    },
    listPractitionerSpecialties: unused,
    findSpecialtiesByIds: unused,
    replacePractitionerSpecialties: unused,
    listPractitionerDurations: unused,
    serviceTypeExists: unused,
    upsertDurationException: unused,
    deleteDurationException: unused,
    listPractitionerSites: unused,
    replacePractitionerSites: unused,
  } as unknown as StaffRepository;

  return { repository, calls };
}

const WRITE_METHODS = [
  'createPractitioner',
  'updatePractitioner',
  'deletePractitioner',
];

describe('PractitionerService', () => {
  let answers: Answers;
  let calls: Call[];
  let recorded: AccessAuditEntry[];
  let service: PractitionerService;

  beforeEach(() => {
    answers = {
      findPractitioner: PRACTITIONER,
      updatePractitioner: PRACTITIONER,
      deletePractitioner: true,
      acessExpiring: [],
    };
    const double = makeDouble(answers);
    calls = double.calls;
    recorded = [];
    service = new PractitionerService(
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

  describe('la ficha', () => {
    it('ST-001 crear una ficha deja bitácora con autor, instante y recurso staff', async () => {
      await service.create({ userId: 'user-9', mspCode: 'MSP-42' }, REQUESTER);

      expect(recorded).toEqual([
        expect.objectContaining({
          userId: 'user-1',
          resourceType: 'staff',
          resourceId: PRACTITIONER.id,
          action: 'CREATE',
          ip: '10.0.0.1',
        }),
      ]);
    });

    it('ST-003 el código MSP viaja tal cual hasta el puerto, sin inventar valor', async () => {
      // REQ-021 puts this code on every attention: a service that defaulted it
      // to something plausible would falsify a report to the Ministry.
      await service.create({ userId: 'user-9' }, REQUESTER);

      expect(writes()).toEqual([
        {
          method: 'createPractitioner',
          args: [{ userId: 'user-9', mspCode: null, schedulable: true }],
        },
      ]);
    });

    it('ST-010 desactivar es una edición y queda en la bitácora como UPDATE', async () => {
      await service.update(PRACTITIONER.id, { active: false }, REQUESTER);

      expect(recorded[0]).toMatchObject({
        action: 'UPDATE',
        resourceId: PRACTITIONER.id,
        resourceType: 'staff',
      });
    });

    it('ST-010 el listado pasa el interruptor tal cual: por defecto solo activos', async () => {
      await service.list(false);
      await service.list(true);

      expect(
        calls
          .filter((call) => call.method === 'listPractitioners')
          .map((call) => call.args[0]),
      ).toEqual([false, true]);
    });

    it('ST-010 editar un profesional inexistente responde 404 y no deja bitácora', async () => {
      answers.updatePractitioner = null;

      await expect(
        service.update('ghost', { active: false }, REQUESTER),
      ).rejects.toBeInstanceOf(PractitionerNotFoundError);
      expect(recorded).toEqual([]);
    });

    it('ST-010 borrar uno con historial se rechaza y no deja bitácora de borrado', async () => {
      answers.deletePractitioner = 'in-use';

      await expect(
        service.delete(PRACTITIONER.id, REQUESTER),
      ).rejects.toBeInstanceOf(PractitionerInUseError);
      expect(recorded).toEqual([]);
    });

    it('ST-010 borrar uno inexistente responde 404, no 204', async () => {
      answers.deletePractitioner = false;

      await expect(service.delete('ghost', REQUESTER)).rejects.toBeInstanceOf(
        PractitionerNotFoundError,
      );
    });
  });

  describe('la habilitación', () => {
    it('ST-004 firmar con el ACESS caducado se rechaza nombrando la fecha', async () => {
      answers.findPractitioner = {
        ...PRACTITIONER,
        acessExpiresOn: on('2026-08-12'),
      };

      const rejection = await service
        .assertMaySign(PRACTITIONER.id, on('2026-08-13'))
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(AcessExpiredError);
      expect((rejection as AcessExpiredError).userTitle).toContain('2026-08-12'); // prettier-ignore
    });

    it('ST-004 el mismo profesional con el ACESS vigente sí puede firmar', async () => {
      const status = await service.assertMaySign(
        PRACTITIONER.id,
        on('2026-08-13'),
      );

      expect(status.eligible).toBe(true);
    });

    it('ST-002 sin registro ACESS se rechaza con ACESS_MISSING, no con caducado', async () => {
      answers.findPractitioner = {
        ...PRACTITIONER,
        acessRegistration: null,
      };

      await expect(
        service.assertMaySign(PRACTITIONER.id, on('2026-08-13')),
      ).rejects.toBeInstanceOf(AcessMissingError);
    });

    it('ST-004 comprobar la firma de un profesional inexistente responde 404', async () => {
      answers.findPractitioner = null;

      await expect(
        service.assertMaySign('ghost', on('2026-08-13')),
      ).rejects.toBeInstanceOf(PractitionerNotFoundError);
    });

    it('ST-004 comprobar la firma NO escribe nada: es una consulta', async () => {
      await service.assertMaySign(PRACTITIONER.id, on('2026-08-13'));

      // D-009: an expired ACESS blocks the signature and moves nothing. The
      // load-bearing assertion is the absence of any write.
      expect(writes()).toEqual([]);
      expect(recorded).toEqual([]);
    });

    it('ST-005 pide al puerto la ventana de 30 días contada desde la fecha clínica', async () => {
      await service.listAcessExpiring(30, on('2026-08-13'));

      expect(
        calls.find((call) => call.method === 'listAcessExpiringThrough')?.args,
      ).toEqual(['2026-09-12']);
    });

    it('ST-005 devuelve los días restantes, negativos para el que ya caducó', async () => {
      answers.acessExpiring = [
        {
          practitionerId: 'prac-1',
          firstName: 'Ana',
          lastName: 'Villacís',
          acessRegistration: 'ACESS-1001',
          acessExpiresOn: on('2026-08-20'),
        },
        {
          practitionerId: 'prac-2',
          firstName: 'Luis',
          lastName: 'Paredes',
          acessRegistration: 'ACESS-1002',
          acessExpiresOn: on('2026-08-01'),
        },
      ];

      const rows = await service.listAcessExpiring(30, on('2026-08-13'));

      expect(rows.map((row) => row.daysToExpiry)).toEqual([7, -12]);
    });

    it('ST-005 avisar no bloquea: la lista no escribe ni deja bitácora', async () => {
      await service.listAcessExpiring(30, on('2026-08-13'));

      expect(writes()).toEqual([]);
      expect(recorded).toEqual([]);
    });
  });
});
