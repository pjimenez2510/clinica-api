import { describe, expect, it } from 'vitest';

import { criticalWait, unmatchedWait } from './safety-deadline';

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
    expect(criticalWait(minutesBefore(61), NOW, null).waitingMinutes).toBe(61);
    // Un informe fechado un poco por delante del reloj no espera «-1».
    expect(criticalWait(minutesBefore(-2), NOW, null).waitingMinutes).toBe(0);
  });

  it('ORD-065 no inventa un plazo cuando la sede no lo ha fijado', () => {
    // `null` es «la clínica no ha fijado plazo», y no es ni «va bien» ni «va
    // tarde»: es el argumento de ORD-022 en la cola que más importa.
    const wait = criticalWait(minutesBefore(600), NOW, null);
    expect(wait.overdue).toBeNull();
    expect(wait.dueAt).toBeNull();
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
});
