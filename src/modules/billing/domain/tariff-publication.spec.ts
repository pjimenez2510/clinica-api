import { describe, expect, it } from 'vitest';

import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';
import { Money, Percentage } from './money';
import {
  type TariffCandidate,
  type TariffLine,
  tariffDifferences,
  tariffFinalAmount,
  tariffLinesOn,
  serviceKindGroup,
} from './tariff-publication';

// The day derives from a clock, never written by hand.
const today = clinicalDateOf(new Date());
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);

const candidate = (overrides: Partial<TariffCandidate> = {}): TariffCandidate => ({
  serviceId: 'service-1',
  code: 'CON-01',
  name: 'Consulta de medicina general',
  categoryName: 'Consultas',
  active: true,
  taxPercentage: Percentage.ZERO,
  prices: [{ amount: Money.parse('30.00'), validFrom: yesterday, validTo: null }],
  ...overrides,
}); // prettier-ignore

const line = (overrides: Partial<TariffLine> = {}): TariffLine => ({
  serviceId: 'service-1',
  code: 'CON-01',
  name: 'Consulta de medicina general',
  categoryName: 'Consultas',
  amount: Money.parse('30.00'),
  taxPercentage: Percentage.ZERO,
  finalAmount: Money.parse('30.00'),
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
        candidate({ serviceId: 'off', active: false }),
        candidate({
          serviceId: 'future',
          prices: [{ amount: Money.parse('9.00'), validFrom: tomorrow, validTo: null }],
        }), // prettier-ignore
        candidate({
          serviceId: 'ended',
          prices: [{ amount: Money.parse('9.00'), validFrom: yesterday, validTo: today }],
        }), // prettier-ignore
        candidate({ serviceId: 'unpriced', prices: [] }),
        candidate({ serviceId: 'kept' }),
      ],
      today,
    );
    expect(lines.map((l) => l.serviceId)).toEqual(['kept']);
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
        candidate({ serviceId: 'b', name: 'Hemograma', categoryName: 'Laboratorio' }), // prettier-ignore
        candidate({ serviceId: 'c', name: 'Ecografía', categoryName: 'Imagen' }), // prettier-ignore
        candidate({ serviceId: 'a', name: 'Glucosa', categoryName: 'Laboratorio' }), // prettier-ignore
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
      [line({ serviceId: 'gone', name: 'Retirada' }), line()],
      [line(), line({ serviceId: 'new', name: 'Nueva' })],
    );
    expect(differences).toEqual([
      { kind: 'WITHDRAWN', serviceId: 'gone', name: 'Retirada' },
      { kind: 'ADDED', serviceId: 'new', name: 'Nueva' },
    ]);
  });
});

describe('BI-110 BI-113 el precio final con IVA que se exhibe (LODC art. 9, D-192.1)', () => {
  it('BI-113 la línea al 15 % lleva su precio final, el de la factura', () => {
    const [only] = tariffLinesOn(
      [candidate({ taxPercentage: Percentage.parse('15.00') })],
      today,
    );
    expect(only?.amount.toString()).toBe('30.00');
    expect(only?.finalAmount.toString()).toBe('34.50');
  });

  it('BI-110 al 0 % y sin porcentaje (no objeto, exento) el final es el precio', () => {
    expect(tariffFinalAmount(Money.parse('30.00'), Percentage.ZERO).toString()).toBe('30.00'); // prettier-ignore
    expect(tariffFinalAmount(Money.parse('30.00'), null).toString()).toBe(
      '30.00',
    );
  });

  it('BI-110 redondea al centavo HALF UP, como lineTax de la factura', () => {
    // 0.10 × 15 % = 0.015 → 0.02; 0.70 × 15 % = 0.105 → 0.11.
    const fifteen = Percentage.parse('15.00');
    expect(tariffFinalAmount(Money.parse('0.10'), fifteen).toString()).toBe(
      '0.12',
    );
    expect(tariffFinalAmount(Money.parse('0.70'), fifteen).toString()).toBe(
      '0.81',
    );
    expect(tariffFinalAmount(Money.parse('0.03'), fifteen).toString()).toBe(
      '0.03',
    );
  });
});

describe('BI-289 cada línea de la pared se agrupa por el tipo del servicio', () => {
  it('BI-289 nombra el grupo con el tipo, como lo lee el público, para los seis tipos', () => {
    expect(serviceKindGroup('CONSULTATION')).toBe('Consultas');
    expect(serviceKindGroup('LAB_EXAM')).toBe('Exámenes de laboratorio');
    expect(serviceKindGroup('IMAGING')).toBe('Imagen');
    expect(serviceKindGroup('PROCEDURE')).toBe('Procedimientos');
    expect(serviceKindGroup('SUPPLY')).toBe('Insumos');
    expect(serviceKindGroup('OTHER')).toBe('Otros');
  });
});
