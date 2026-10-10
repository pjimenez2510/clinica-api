import { describe, expect, it } from 'vitest';

import {
  criticalNoticeTarget,
  criticalWait,
  noticeDueToRequester,
  unmatchedWait,
} from './safety-deadline';

/**
 * How long a value on a safety worklist has been waiting, and whether it is
 * late (ORD-046, ORD-065). Pure arithmetic over instants, so the clock is a
 * parameter and every instant here is derived from it.
 */
const NOW = new Date();
const minutesBefore = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

describe('el plazo de las colas de seguridad', () => {
  it('ORD-065 dice cuántos minutos lleva un crítico esperando aviso', () => {
    expect(criticalWait(minutesBefore(61), NOW, 60).waitingMinutes).toBe(61);
    // Un informe fechado un poco por delante del reloj no espera «-1».
    expect(criticalWait(minutesBefore(-2), NOW, 60).waitingMinutes).toBe(0);
  });

  it('ORD-065 marca vencido el crítico que pasó el plazo de la sede, y no el que aún está dentro', () => {
    const late = criticalWait(minutesBefore(61), NOW, 60);
    expect(late.overdue).toBe(true);
    expect(late.dueAt).toEqual(minutesBefore(1));

    const onTime = criticalWait(minutesBefore(60), NOW, 60);
    expect(onTime.overdue).toBe(false);
  });

  it('ORD-046 da al resultado sin orden su plazo en horas desde que llegó', () => {
    const fresh = unmatchedWait(minutesBefore(60), NOW, 24);
    expect(fresh.overdue).toBe(false);
    expect(fresh.dueAt).toEqual(new Date(minutesBefore(60).getTime() + 24 * 3_600_000)); // prettier-ignore

    const stale = unmatchedWait(minutesBefore(25 * 60), NOW, 24);
    expect(stale.overdue).toBe(true);
  });

  it('ORD-068 fuera de horario toca a la guardia, y sin guardia al paciente', () => {
    expect(criticalNoticeTarget({ overdue: false, afterHours: true, hasOnCallRole: true, orderingUnanswered: false })).toEqual({ target: 'ON_CALL_ROLE', escalationMissing: false }); // prettier-ignore
    expect(criticalNoticeTarget({ overdue: false, afterHours: true, hasOnCallRole: false, orderingUnanswered: false })).toEqual({ target: 'PATIENT', escalationMissing: true }); // prettier-ignore
  });

  it('ORD-065 en horario y vencido toca a la guardia; sin guardia lo dice y no escala sola', () => {
    expect(criticalNoticeTarget({ overdue: true, afterHours: false, hasOnCallRole: true, orderingUnanswered: false })).toEqual({ target: 'ON_CALL_ROLE', escalationMissing: false }); // prettier-ignore
    expect(criticalNoticeTarget({ overdue: true, afterHours: false, hasOnCallRole: false, orderingUnanswered: false })).toEqual({ target: 'ORDERING_PRACTITIONER', escalationMissing: true }); // prettier-ignore
  });

  it('ORD-065 en horario y dentro del plazo toca a quien pidió el examen', () => {
    expect(criticalNoticeTarget({ overdue: false, afterHours: false, hasOnCallRole: true, orderingUnanswered: false })).toEqual({ target: 'ORDERING_PRACTITIONER', escalationMissing: false }); // prettier-ignore
  });

  it('ORD-065 una llamada sin respuesta al médico que pidió escala a la guardia sin esperar a que venza', () => {
    expect(criticalNoticeTarget({ overdue: false, afterHours: false, hasOnCallRole: true, orderingUnanswered: true })).toEqual({ target: 'ON_CALL_ROLE', escalationMissing: false }); // prettier-ignore
    expect(criticalNoticeTarget({ overdue: false, afterHours: false, hasOnCallRole: false, orderingUnanswered: true })).toEqual({ target: 'ORDERING_PRACTITIONER', escalationMissing: true }); // prettier-ignore
  });

  it('ORD-146 tras un autoaviso el aviso toca al paciente, en horario, vencido o fuera de horario', () => {
    for (const afterHours of [false, true]) {
      for (const overdue of [false, true]) {
        expect(criticalNoticeTarget({ overdue, afterHours, hasOnCallRole: true, orderingUnanswered: false, dueToPatient: true })).toEqual({ target: 'PATIENT', escalationMissing: false }); // prettier-ignore
      }
    }
    // Control positivo: sin autoaviso, el mismo estado toca al médico que pidió.
    expect(criticalNoticeTarget({ overdue: false, afterHours: false, hasOnCallRole: true, orderingUnanswered: false, dueToPatient: false })).toEqual({ target: 'ORDERING_PRACTITIONER', escalationMissing: false }); // prettier-ignore
  });
});

describe('a qué sesión toca el aviso de un crítico (ORD-167)', () => {
  const entry = {
    escalationMissing: false,
    siteId: 'site-a',
    orderedByUserId: 'doctor-a',
    escalationRoleId: 'on-call',
  };
  const doctorA = { userId: 'doctor-a', roles: [] };
  const doctorB = { userId: 'doctor-b', roles: [] };
  const onCallHere = { userId: 'nurse', roles: [{ roleId: 'on-call', siteId: 'site-a' }] }; // prettier-ignore
  const onCallEverywhere = { userId: 'director', roles: [{ roleId: 'on-call', siteId: null }] }; // prettier-ignore
  const onCallElsewhere = { userId: 'nurse-b', roles: [{ roleId: 'on-call', siteId: 'site-b' }] }; // prettier-ignore
  const otherRoleHere = { userId: 'nurse-c', roles: [{ roleId: 'nursing', siteId: 'site-a' }] }; // prettier-ignore

  it('ORD-167 al médico que pidió le toca él, y a otra cuenta no', () => {
    const due = { ...entry, target: 'ORDERING_PRACTITIONER' as const };
    expect(noticeDueToRequester(due, doctorA)).toBe(true);
    expect(noticeDueToRequester(due, doctorB)).toBe(false);
    // Tener el rol de guardia no basta mientras no toque a la guardia.
    expect(noticeDueToRequester(due, onCallHere)).toBe(false);
  });

  it('ORD-167 a la guardia le toca a quien tiene ese rol en la sede o en todas, no en otra ni con otro rol', () => {
    const due = { ...entry, target: 'ON_CALL_ROLE' as const };
    expect(noticeDueToRequester(due, onCallHere)).toBe(true);
    expect(noticeDueToRequester(due, onCallEverywhere)).toBe(true);
    expect(noticeDueToRequester(due, onCallElsewhere)).toBe(false);
    expect(noticeDueToRequester(due, otherRoleHere)).toBe(false);
    // Escalado, deja de tocar a quien pidió.
    expect(noticeDueToRequester(due, doctorA)).toBe(false);
    // Sin rol de guardia en la sede, no toca a nadie por el rol.
    expect(noticeDueToRequester({ ...due, escalationRoleId: null }, onCallHere)).toBe(false); // prettier-ignore
  });

  it('ORD-167 sin guardia que lo atienda (vencido o fuera de horario), toca a toda cuenta que lee la cola', () => {
    for (const target of ['ORDERING_PRACTITIONER', 'PATIENT'] as const) {
      const missing = { ...entry, target, escalationMissing: true };
      expect(noticeDueToRequester(missing, doctorB)).toBe(true);
      expect(noticeDueToRequester(missing, doctorA)).toBe(true);
      // Control positivo: con la escalada en regla, a otra cuenta no.
      expect(noticeDueToRequester({ ...missing, escalationMissing: false }, doctorB)).toBe(false); // prettier-ignore
    }
  });

  it('ORD-167 al paciente lo llama quien pidió la orden', () => {
    const due = { ...entry, target: 'PATIENT' as const };
    expect(noticeDueToRequester(due, doctorA)).toBe(true);
    expect(noticeDueToRequester(due, doctorB)).toBe(false);
    expect(noticeDueToRequester(due, onCallHere)).toBe(false);
  });
});
