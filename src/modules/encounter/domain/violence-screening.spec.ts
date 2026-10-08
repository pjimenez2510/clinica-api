import { describe, expect, it } from 'vitest';

import {
  admitsAfterDischarge,
  type ScreeningAnswer,
  type ScreeningRecord,
} from './violence-screening';

/**
 * EN-242 (D-188 §5). With the discharge given, only the notification of a
 * screening with signs is completed or corrected. The adapter asks this under
 * the attention's lock; `trg_violence_screening_guard` says the same to
 * whoever walks past it.
 */
const NOTIFICATION = {
  formSerial: '0012345',
  injury: 'DAMAGE',
  aggressorIdentified: 'YES',
  aggressorRelationship: 'RELATIVE',
} as const;

const recorded = (
  overrides: Partial<ScreeningRecord> = {},
): ScreeningRecord => ({
  result: 'SUSPECTED',
  types: ['PHYSICAL', 'SEXUAL'],
  actionTaken: 'Derivada a trabajo social',
  screeningTool: null,
  notification: null,
  screenedById: 'practitioner-1',
  // An instant derived from the clock, never written by hand.
  screenedAt: new Date(),
  notifiedById: null,
  notifiedAt: null,
  ...overrides,
});

const answerOf = (
  record: ScreeningRecord,
  overrides: Partial<ScreeningAnswer> = {},
): ScreeningAnswer => ({
  result: record.result,
  types: [...record.types],
  actionTaken: record.actionTaken,
  screeningTool: record.screeningTool,
  notification: NOTIFICATION,
  ...overrides,
});

describe('EN-242 lo que admite el tamizaje tras el alta', () => {
  it('EN-242 admite completar o corregir la notificación de un positivo, con los tipos en cualquier orden', () => {
    const current = recorded();
    expect(admitsAfterDischarge(current, answerOf(current))).toBe(true);
    expect(
      admitsAfterDischarge(
        current,
        answerOf(current, { types: ['SEXUAL', 'PHYSICAL'] }),
      ),
    ).toBe(true);
    const notified = recorded({ notification: NOTIFICATION });
    expect(
      admitsAfterDischarge(
        notified,
        answerOf(notified, {
          notification: { ...NOTIFICATION, formSerial: '0099999' },
        }),
      ),
    ).toBe(true);
  });

  it('EN-242 rechaza cambiar el resultado, los tipos, la acción o el instrumento, quitar la notificación, o notificar sin tamizaje con signos', () => {
    const current = recorded({ notification: NOTIFICATION });
    for (const change of [
      { result: 'CONFIRMED' },
      { types: ['PHYSICAL'] },
      { actionTaken: 'Otra' },
      { screeningTool: 'Otro instrumento' },
      { notification: null },
    ] as Partial<ScreeningAnswer>[]) {
      expect(admitsAfterDischarge(current, answerOf(current, change))).toBe(
        false,
      );
    }
    const negative = recorded({ result: 'NO_SIGNS', types: [], actionTaken: null }); // prettier-ignore
    expect(admitsAfterDischarge(negative, answerOf(negative))).toBe(false);
    expect(admitsAfterDischarge(null, answerOf(current))).toBe(false);
  });
});
