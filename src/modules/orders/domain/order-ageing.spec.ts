import { describe, expect, it } from 'vitest';

import { ageingOf } from './order-ageing';

/**
 * El envejecimiento de la cola, que es el número que una persona lee antes de
 * decidir si llama al laboratorio.
 */

/** 20:00 en Guayaquil (UTC-5) del martes 15 de septiembre de 2026. */
const TUESDAY_20H = new Date('2026-09-16T01:00:00Z');

describe('el envejecimiento de una orden pendiente', () => {
  it('ORD-021 cuenta los días en America/Guayaquil y no en el huso de la sesión', () => {
    // 20:00 del martes en Guayaquil ya es miércoles en UTC. Contado con el
    // huso de la sesión, esta orden aparentaría un día más de lo que tiene, y
    // una cola que exagera es una cola que se deja de creer.
    const wednesday9h = new Date('2026-09-16T14:00:00Z');
    expect(ageingOf(TUESDAY_20H, wednesday9h, null).waitingDays).toBe(1);
  });

  it('ORD-021 dice cero el mismo día, y no uno', () => {
    const twoHoursLater = new Date('2026-09-16T03:00:00Z');
    expect(ageingOf(TUESDAY_20H, twoHoursLater, null).waitingDays).toBe(0);
  });

  it('ORD-021 cuenta diez días para una orden de hace diez días', () => {
    const tenDaysLater = new Date('2026-09-25T13:00:00Z');
    expect(ageingOf(TUESDAY_20H, tenDaysLater, null).waitingDays).toBe(10);
  });

  it('ORD-022 marca vencida la línea que pasó el plazo comprometido', () => {
    // `EX-BH` promete cuatro horas en la siembra real.
    const fiveHoursLater = new Date('2026-09-16T06:00:00Z');
    const threeHoursLater = new Date('2026-09-16T04:00:00Z');

    expect(ageingOf(TUESDAY_20H, fiveHoursLater, 4).overdue).toBe(true);
    expect(ageingOf(TUESDAY_20H, threeHoursLater, 4).overdue).toBe(false);
  });

  it('ORD-022 publica el instante en que se prometió el resultado', () => {
    expect(ageingOf(TUESDAY_20H, TUESDAY_20H, 4).dueAt).toEqual(
      new Date('2026-09-16T05:00:00Z'),
    );
  });

  it('ORD-022 responde «no hay plazo» y no «va bien» cuando el examen no promete nada', () => {
    // Colapsar `null` en `false` diría «va bien» de un examen cuyo plazo nadie
    // escribió nunca; colapsarlo en `true` llenaría la lista de falsas alarmas.
    const ageing = ageingOf(
      TUESDAY_20H,
      new Date('2026-09-30T13:00:00Z'),
      null,
    );

    expect(ageing.overdue).toBeNull();
    expect(ageing.dueAt).toBeNull();
    expect(ageing.waitingDays).toBe(15);
  });

  it('ORD-021 nunca devuelve días negativos', () => {
    const before = new Date('2026-09-10T13:00:00Z');
    expect(ageingOf(TUESDAY_20H, before, null).waitingDays).toBe(0);
  });
});
