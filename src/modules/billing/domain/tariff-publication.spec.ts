import { describe, expect, it } from 'vitest';

import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';
import { Money, Percentage } from './money';
import {
  type TariffCandidate,
  type TariffLine,
  tariffDifferences,
  tariffLinesOn,
} from './tariff-publication';

// The day derives from a clock, never written by hand.
const today = clinicalDateOf(new Date());
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);

const candidate = (overrides: Partial<TariffCandidate> = {}): TariffCandidate => ({
  billableServiceId: 'service-1',
  code: 'CON-01',
  name: 'Consulta de medicina general',
  categoryName: 'Consultas',
  active: true,
  taxPercentage: Percentage.ZERO,
  prices: [{ amount: Money.parse('30.00'), validFrom: yesterday, validTo: null }],
  ...overrides,
}); // prettier-ignore

const line = (overrides: Partial<TariffLine> = {}): TariffLine => ({
  billableServiceId: 'service-1',
  code: 'CON-01',
  name: 'Consulta de medicina general',
  categoryName: 'Consultas',
  amount: Money.parse('30.00'),
  taxPercentage: Percentage.ZERO,
  ...overrides,
});

describe('BI-111 lo que entra en el tarifario de la pared', () => {
  it('BI-111 entra la prestación activa con precio vigente ese día, con su IVA', () => {
    const [only] = tariffLinesOn([candidate()], today);
    expect(only?.amount.toString()).toBe('30.00');
    expect(only?.taxPercentage?.toString()).toBe('0.00');
  });

  it('BI-111 no entra la desactivada ni la que no tiene precio vigente ese día', () => {
    const lines = tariffLinesOn(
      [
        candidate({ billableServiceId: 'off', active: false }),
        candidate({
          billableServiceId: 'future',
          prices: [{ amount: Money.parse('9.00'), validFrom: tomorrow, validTo: null }],
        }), // prettier-ignore
        candidate({
          billableServiceId: 'ended',
          prices: [{ amount: Money.parse('9.00'), validFrom: yesterday, validTo: today }],
        }), // prettier-ignore
        candidate({ billableServiceId: 'unpriced', prices: [] }),
        candidate({ billableServiceId: 'kept' }),
      ],
      today,
    );
    expect(lines.map((l) => l.billableServiceId)).toEqual(['kept']);
  });

  it('BI-111 toma el precio que rige ese día cuando la prestación tiene varios', () => {
    const [only] = tariffLinesOn(
      [
        candidate({
          prices: [
            { amount: Money.parse('25.00'), validFrom: addDays(today, -30), validTo: today },
            { amount: Money.parse('30.00'), validFrom: today, validTo: tomorrow },
            { amount: Money.parse('35.00'), validFrom: tomorrow, validTo: null },
          ],
        }), // prettier-ignore
      ],
      today,
    );
    expect(only?.amount.toString()).toBe('30.00');
  });

  it('BI-114 ordena por categoría y luego por nombre, como se lee la hoja', () => {
    const lines = tariffLinesOn(
      [
        candidate({ billableServiceId: 'b', name: 'Hemograma', categoryName: 'Laboratorio' }), // prettier-ignore
        candidate({ billableServiceId: 'c', name: 'Ecografía', categoryName: 'Imagen' }), // prettier-ignore
        candidate({ billableServiceId: 'a', name: 'Glucosa', categoryName: 'Laboratorio' }), // prettier-ignore
      ],
      today,
    );
    expect(lines.map((l) => l.name)).toEqual(['Ecografía', 'Glucosa', 'Hemograma']); // prettier-ignore
  });
});

describe('BI-115 la publicación desactualizada', () => {
  it('BI-115 sin cambios no hay diferencias', () => {
    expect(tariffDifferences([line()], [line()])).toEqual([]);
  });

  it('BI-115 un precio cambiado se dice con lo publicado y lo vigente', () => {
    const [difference] = tariffDifferences(
      [line()],
      [line({ amount: Money.parse('35.00') })],
    );
    expect(difference?.kind).toBe('PRICE_CHANGED');
    if (difference?.kind !== 'PRICE_CHANGED') return;
    expect(difference.published.amount.toString()).toBe('30.00');
    expect(difference.current.amount.toString()).toBe('35.00');
  });

  it('BI-115 un IVA cambiado también desactualiza: la hoja lo exhibe junto al precio', () => {
    const differences = tariffDifferences(
      [line()],
      [line({ taxPercentage: Percentage.parse('15.00') })],
    );
    expect(differences.map((d) => d.kind)).toEqual(['PRICE_CHANGED']);
    expect(tariffDifferences([line({ taxPercentage: null })], [line()])).toHaveLength(1); // prettier-ignore
  });

  it('BI-115 la que salió de la lista y la que entró se dicen por separado', () => {
    const differences = tariffDifferences(
      [line({ billableServiceId: 'gone', name: 'Retirada' }), line()],
      [line(), line({ billableServiceId: 'new', name: 'Nueva' })],
    );
    expect(differences).toEqual([
      { kind: 'WITHDRAWN', billableServiceId: 'gone', name: 'Retirada' },
      { kind: 'ADDED', billableServiceId: 'new', name: 'Nueva' },
    ]);
  });
});
