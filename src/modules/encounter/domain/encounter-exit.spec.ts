import { describe, expect, it } from 'vitest';

import {
  EncounterCloserNotAuthorError,
  InvalidEncounterTransitionError,
} from './encounter.errors';
import {
  assertAnnullable,
  hasWrittenContent,
  planExitActor,
} from './encounter-exit';

describe('quién saca una atención por una puerta que no es el alta (D-085)', () => {
  it('EN-166 EN-167 el profesional de la atención no da motivo de sustitución', () => {
    expect(
      planExitActor('p-1', { practitionerId: 'p-1', canSignRecords: false }),
    ).toBeNull();
  });

  it('EN-166 EN-167 otro profesional sin `record:sign` no puede', () => {
    expect(() =>
      planExitActor('p-1', { practitionerId: 'p-2', canSignRecords: false }),
    ).toThrow(EncounterCloserNotAuthorError);
  });

  it('EN-166 EN-167 EN-218 otro con `record:sign` puede sin motivo, y si lo da queda recortado', () => {
    // AT-23: una confirmación en la pantalla, no un motivo; quién lo hizo ya
    // se guarda en la propia fila.
    expect(
      planExitActor('p-1', { practitionerId: 'p-2', canSignRecords: true }),
    ).toBeNull();
    expect(
      planExitActor('p-1', { practitionerId: 'p-2', canSignRecords: true, substituteReason: '  ' }), // prettier-ignore
    ).toBeNull();
    expect(
      planExitActor('p-1', { practitionerId: 'p-2', canSignRecords: true, substituteReason: ' Guardia ' }), // prettier-ignore
    ).toBe('Guardia');
  });

  it('EN-166 solo se anula una atención en curso: firmada, se retracta nota a nota', () => {
    expect(() => assertAnnullable('OPEN')).not.toThrow();
    expect(() => assertAnnullable('ON_HOLD')).not.toThrow();
    for (const from of [
      'DISCHARGED',
      'DISCONTINUED',
      'COMPLETED',
      'ENTERED_IN_ERROR',
    ] as const) {
      expect(() => assertAnnullable(from), from).toThrow(
        InvalidEncounterTransitionError,
      );
    }
  });

  it('EN-167 un borrador sin nada escrito no se firma', () => {
    expect(hasWrittenContent({ motivoConsulta: '  ', plan: '' })).toBe(false);
    expect(hasWrittenContent({})).toBe(false);
    expect(hasWrittenContent({ motivoConsulta: 'Cefalea' })).toBe(true);
  });
});
