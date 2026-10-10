import { describe, expect, it } from 'vitest';

import { holdsRecordKey, withinRecordScope } from './clinical-record-key';

describe('D-203 §1 la llave de la historia para la copia', () => {
  it('DOC-118 PD-057 sin record:read en ninguna sede no hay llave, aunque el paciente no tenga atenciones', () => {
    expect(holdsRecordKey([], [])).toBe(false);
    expect(holdsRecordKey([], ['norte'])).toBe(false);
  });

  it('DOC-118 con record:read en una sede donde se atendió la persona, sí; en otra sede, no', () => {
    expect(holdsRecordKey(['norte'], ['norte', 'sur'])).toBe(true);
    expect(holdsRecordKey(['centro'], ['norte', 'sur'])).toBe(false);
  });

  it('DOC-118 en todas las sedes, siempre; sin atenciones firmadas, basta con tenerlo en alguna', () => {
    expect(holdsRecordKey('all', ['sur'])).toBe(true);
    expect(holdsRecordKey(['centro'], [])).toBe(true);
  });

  it('DOC-118 la copia alcanza sólo las sedes de su record:read', () => {
    expect(withinRecordScope(['norte'], 'norte')).toBe(true);
    expect(withinRecordScope(['norte'], 'sur')).toBe(false);
    expect(withinRecordScope('all', 'sur')).toBe(true);
  });
});
