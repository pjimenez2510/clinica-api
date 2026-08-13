import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import {
  type ClinicalDate,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import type { BookedInterval } from '../domain/schedule-conflicts';
import type {
  ScheduleRuleRepository,
  ScheduleRuleView,
} from '../domain/schedule-rule.repository';
import {
  InvalidScheduleRuleError,
  PractitionerNotFoundError,
  PractitionerNotInSiteError,
  PractitionerNotSchedulableError,
  ScheduleRuleNotFoundError,
} from '../domain/staff.errors';

import { ScheduleRulesService } from './schedule-rules.service';
import { type Requester, StaffAuditTrail } from './staff-audit.trail';

/**
 * What the SERVICE owns of S2. The headline guarantee — ST-042, two rules in
 * force may not overlap — is NOT tested here and cannot be: it is an EXCLUDE
 * constraint, and a double proves nothing about it. It has its own concurrency
 * test in `test/integration/staff-http.spec.ts`, against a real PostgreSQL.
 */
const REQUESTER: Requester = { userId: 'user-1', ip: '10.0.0.1' };
const on = (value: string): ClinicalDate => parseClinicalDate(value);
const TODAY = on('2026-09-14');

const RULE: ScheduleRuleView = {
  id: 'rule-1',
  practitionerId: 'prac-1',
  siteId: 'site-1',
  weekday: 1,
  startTime: '08:00',
  endTime: '12:00',
  slotMinutes: 20,
  validFrom: on('2026-01-01'),
  validTo: null,
  active: true,
};

const DRAFT = {
  siteId: 'site-1',
  weekday: 1,
  startTime: '14:00',
  endTime: '18:00',
  slotMinutes: 20,
  validFrom: on('2026-01-01'),
  validTo: null,
};

interface Answers {
  findRule: ScheduleRuleView | null;
  update: ScheduleRuleView | null;
  worksAt: boolean;
  schedulable: boolean | null;
  rules: ScheduleRuleView[];
  booked: BookedInterval[];
}

interface Call {
  method: string;
  args: unknown[];
}

function makeDouble(answers: Answers): {
  repository: ScheduleRuleRepository;
  calls: Call[];
} {
  const calls: Call[] = [];
  const note = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };

  const repository: ScheduleRuleRepository = {
    listByPractitioner: (practitionerId, includeClosed) => {
      note('listByPractitioner', practitionerId, includeClosed);
      return Promise.resolve(answers.rules);
    },
    findRule: (id) => {
      note('findRule', id);
      return Promise.resolve(answers.findRule);
    },
    create: (rule) => {
      note('create', rule);
      return Promise.resolve({
        ...RULE,
        ...rule,
        id: 'rule-new',
        active: true,
      });
    },
    update: (id, patch) => {
      note('update', id, patch);
      return Promise.resolve(answers.update);
    },
    practitionerWorksAt: (practitionerId, siteId) => {
      note('practitionerWorksAt', practitionerId, siteId);
      return Promise.resolve(answers.worksAt);
    },
    isSchedulable: (practitionerId) => {
      note('isSchedulable', practitionerId);
      return Promise.resolve(answers.schedulable);
    },
    /**
     * FILTERS BY SITE, like the real query does. A double that ignored the
     * argument would let a `bookedFrom` asking about the wrong site pass —
     * which is exactly the defect these tests have to be able to see.
     */
    bookedFrom: (practitionerId, siteId, from) => {
      note('bookedFrom', practitionerId, siteId, from);
      return Promise.resolve(
        answers.booked.filter((entry) => entry.siteId === siteId),
      );
    },
  };

  return { repository, calls };
}

const WRITE_METHODS = ['create', 'update'];

describe('ScheduleRulesService', () => {
  let answers: Answers;
  let calls: Call[];
  let recorded: AccessAuditEntry[];
  let service: ScheduleRulesService;

  beforeEach(() => {
    answers = {
      findRule: RULE,
      update: RULE,
      worksAt: true,
      schedulable: true,
      rules: [RULE],
      booked: [],
    };
    const double = makeDouble(answers);
    calls = double.calls;
    recorded = [];
    service = new ScheduleRulesService(
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

  describe('crear y editar', () => {
    it('ST-040 crea la regla y la deja en la bitácora con autor e instante', async () => {
      const outcome = await service.create('prac-1', DRAFT, REQUESTER);

      expect(outcome.rule.id).toBe('rule-new');
      expect(recorded).toEqual([
        expect.objectContaining({
          userId: 'user-1',
          resourceType: 'staff',
          resourceId: 'rule-new',
          action: 'CREATE',
        }),
      ]);
    });

    it('ST-044 editar una regla deja constancia como UPDATE', async () => {
      await service.update('rule-1', { slotMinutes: 30 }, REQUESTER);

      expect(recorded[0]).toMatchObject({
        action: 'UPDATE',
        resourceId: RULE.id,
        resourceType: 'staff',
      });
    });

    it('ST-007 rechaza una regla en una sede donde el profesional no atiende', async () => {
      answers.worksAt = false;

      await expect(
        service.create('prac-1', DRAFT, REQUESTER),
      ).rejects.toBeInstanceOf(PractitionerNotInSiteError);
      expect(writes()).toEqual([]);
    });

    it('ST-046 mover una regla a otra sede vuelve a comprobar la asignación', async () => {
      answers.worksAt = false;

      await expect(
        service.update('rule-1', { siteId: 'site-2' }, REQUESTER),
      ).rejects.toBeInstanceOf(PractitionerNotInSiteError);
      expect(writes()).toEqual([]);
    });

    it('ST-046 editar sin tocar la sede no vuelve a comprobarla', async () => {
      await service.update('rule-1', { siteId: RULE.siteId }, REQUESTER);

      expect(calls.filter((call) => call.method === 'practitionerWorksAt')).toEqual([]); // prettier-ignore
    });

    it('ST-006 un profesional que no toma citas no admite reglas nuevas', async () => {
      answers.schedulable = false;

      await expect(
        service.create('prac-1', DRAFT, REQUESTER),
      ).rejects.toBeInstanceOf(PractitionerNotSchedulableError);
      expect(writes()).toEqual([]);
    });

    it('ST-006 pero sus reglas existentes se siguen pudiendo leer y cerrar', async () => {
      answers.schedulable = false;

      // Hiding them would make it impossible to see what needs closing.
      await expect(service.list('prac-1', true)).resolves.toEqual([RULE]);
    });

    it('ST-040 listar el horario de un profesional inexistente responde 404', async () => {
      answers.schedulable = null;

      await expect(service.list('ghost', false)).rejects.toBeInstanceOf(
        PractitionerNotFoundError,
      );
    });

    it('ST-045 rechaza por campo una franja donde el turno no cabe, sin escribir', async () => {
      const rejection = await service
        .create(
          'prac-1',
          { ...DRAFT, startTime: '14:00', endTime: '14:15', slotMinutes: 20 },
          REQUESTER,
        )
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(InvalidScheduleRuleError);
      expect(
        (rejection as InvalidScheduleRuleError).fieldErrors?.[0]?.field,
      ).toBe('slotMinutes');
      expect(writes()).toEqual([]);
    });

    it('ST-045 valida la regla RESULTANTE al editar, no solo lo que llegó', async () => {
      // The patch alone is harmless; merged with the stored row it produces a
      // rule that yields no slot. Validating the patch would let it through.
      await expect(
        service.update('rule-1', { endTime: '08:10' }, REQUESTER),
      ).rejects.toBeInstanceOf(InvalidScheduleRuleError);
      expect(writes()).toEqual([]);
    });

    it('ST-040 editar una regla inexistente responde 404', async () => {
      answers.findRule = null;

      await expect(
        service.update('ghost', { slotMinutes: 30 }, REQUESTER),
      ).rejects.toBeInstanceOf(ScheduleRuleNotFoundError);
    });
  });

  describe('cerrar', () => {
    it('ST-041 cerrar fija el fin de vigencia hacia adelante y no borra la fila', async () => {
      await service.close('rule-1', REQUESTER, TODAY);

      expect(writes()).toEqual([
        { method: 'update', args: ['rule-1', { validTo: '2026-09-14' }] },
      ]);
    });

    it('ST-041 cerrar una regla que aún no empieza la desactiva, tampoco la borra', async () => {
      answers.findRule = { ...RULE, validFrom: on('2026-12-01') };

      await service.close('rule-1', REQUESTER, TODAY);

      expect(writes()).toEqual([
        { method: 'update', args: ['rule-1', { active: false }] },
      ]);
    });

    it('ST-044 cerrar también queda en la bitácora', async () => {
      await service.close('rule-1', REQUESTER, TODAY);

      expect(recorded[0]).toMatchObject({ action: 'UPDATE', resourceType: 'staff' }); // prettier-ignore
    });
  });

  describe('conflictos del cambio (ST-043)', () => {
    it('ST-043 lista las citas que quedan fuera del nuevo horario', async () => {
      answers.booked = [
        {
          id: 'entry-1',
          siteId: 'site-1',
          startsAt: new Date('2026-09-14T13:00:00-05:00'),
          endsAt: new Date('2026-09-14T13:20:00-05:00'),
        },
      ];

      const outcome = await service.update(
        'rule-1',
        { endTime: '11:00' },
        REQUESTER,
      );

      expect(outcome.conflicts.map((conflict) => conflict.agendaEntryId)).toEqual(['entry-1']); // prettier-ignore
    });

    it('ST-043 NO anula ni mueve nada: el único write es la propia regla', async () => {
      answers.booked = [
        {
          id: 'entry-1',
          siteId: 'site-1',
          startsAt: new Date('2026-09-14T13:00:00-05:00'),
          endsAt: new Date('2026-09-14T13:20:00-05:00'),
        },
      ];

      await service.update('rule-1', { endTime: '11:00' }, REQUESTER);

      // The load-bearing assertion is the ABSENCE of any other write: the
      // conflicts are handed to a human, never resolved by the system.
      expect(writes()).toEqual([
        { method: 'update', args: ['rule-1', { endTime: '11:00' }] },
      ]);
    });

    it('ST-040 un PATCH parcial no borra los campos que no viajan', async () => {
      // `undefined` means «leave it as it is». A plain spread would erase the
      // stored `validFrom`, and the validation would then blow up on a date
      // that is not there — a 500 where a 200 belongs.
      await service.update('rule-1', { endTime: '11:00', validTo: undefined }, REQUESTER); // prettier-ignore

      expect(writes()).toEqual([
        { method: 'update', args: ['rule-1', { endTime: '11:00' }] },
      ]);
    });

    it('ST-043 sin citas fuera devuelve la lista vacía, no la omite', async () => {
      answers.booked = [
        {
          id: 'entry-1',
          siteId: 'site-1',
          startsAt: new Date('2026-09-14T09:00:00-05:00'),
          endsAt: new Date('2026-09-14T09:20:00-05:00'),
        },
      ];

      const outcome = await service.update(
        'rule-1',
        { slotMinutes: 30 },
        REQUESTER,
      );

      expect(outcome.conflicts).toEqual([]);
    });

    it('ST-043 mover la regla a otra sede LISTA las citas que quedan en la sede original', async () => {
      /**
       * El fallo que esta prueba fija: `conflictsAfter` preguntaba por las
       * citas de la sede que la regla tiene DESPUÉS del cambio, así que mover
       * una regla de Norte a Sur respondía `{conflicts: []}` mientras las citas
       * de Norte se quedaban sin ninguna regla que las cubriera. Nadie se
       * enteraba, y ST-043 es justamente para que alguien se entere.
       */
      const moved: ScheduleRuleView = { ...RULE, siteId: 'site-2' };
      answers.update = moved;
      // Como queda el horario del profesional tras el cambio: la regla ya
      // rige en site-2 y en site-1 no queda ninguna.
      answers.rules = [moved];
      answers.booked = [
        {
          id: 'entry-norte',
          siteId: 'site-1',
          startsAt: new Date('2026-09-14T09:00:00-05:00'),
          endsAt: new Date('2026-09-14T09:20:00-05:00'),
        },
      ];

      const outcome = await service.update(
        'rule-1',
        { siteId: 'site-2' },
        REQUESTER,
      );

      expect(outcome.conflicts.map((conflict) => conflict.agendaEntryId)).toEqual(['entry-norte']); // prettier-ignore
      // Y sigue sin anular ni mover nada: la lista es para un humano.
      expect(writes()).toEqual([
        { method: 'update', args: ['rule-1', { siteId: 'site-2' }] },
      ]);
    });

    it('ST-043 al mover la regla también mira la sede nueva, no solo la que deja', async () => {
      const moved: ScheduleRuleView = {
        ...RULE,
        siteId: 'site-2',
        endTime: '10:00',
      };
      answers.update = moved;
      answers.rules = [moved];
      answers.booked = [
        // Ya estaba agendada en la sede de destino, fuera de la franja.
        {
          id: 'entry-sur',
          siteId: 'site-2',
          startsAt: new Date('2026-09-14T11:00:00-05:00'),
          endsAt: new Date('2026-09-14T11:20:00-05:00'),
        },
        // Y esta, en la sede original, se queda sin regla.
        {
          id: 'entry-norte',
          siteId: 'site-1',
          startsAt: new Date('2026-09-14T09:00:00-05:00'),
          endsAt: new Date('2026-09-14T09:20:00-05:00'),
        },
      ];

      const outcome = await service.update(
        'rule-1',
        { siteId: 'site-2', endTime: '10:00' },
        REQUESTER,
      );

      // En orden cronológico y no por sede: quien llama tiene que telefonear a
      // los pacientes, no reconciliar dos listas.
      expect(outcome.conflicts.map((conflict) => conflict.agendaEntryId)).toEqual(['entry-norte', 'entry-sur']); // prettier-ignore
    });

    it('ST-043 sin cambio de sede sigue preguntando por una sola', async () => {
      // La consulta extra sólo aparece cuando la regla se mueve: cobrarla en
      // cada edición sería una consulta por petición que nunca devuelve nada.
      await service.update('rule-1', { slotMinutes: 30 }, REQUESTER);

      expect(
        calls
          .filter((call) => call.method === 'bookedFrom')
          .map((call) => call.args[1]),
      ).toEqual(['site-1']);
    });

    it('ST-043 mide los conflictos contra TODAS las reglas vigentes, no solo la tocada', async () => {
      const afternoon: ScheduleRuleView = {
        ...RULE,
        id: 'rule-2',
        startTime: '14:00',
        endTime: '18:00',
      };
      answers.rules = [RULE, afternoon];
      answers.booked = [
        {
          id: 'entry-1',
          siteId: 'site-1',
          startsAt: new Date('2026-09-14T15:00:00-05:00'),
          endsAt: new Date('2026-09-14T15:20:00-05:00'),
        },
      ];

      const outcome = await service.update(
        'rule-1',
        { endTime: '11:00' },
        REQUESTER,
      );

      // Covered by the afternoon rule the change never touched.
      expect(outcome.conflicts).toEqual([]);
    });
  });
});
