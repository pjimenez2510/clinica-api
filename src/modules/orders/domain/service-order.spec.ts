import { describe, expect, it } from 'vitest';

import {
  admitsNewOrders,
  isCorrectable,
  supersedingStatus,
  isLineComplete,
  isPending,
  type DiagnosticReportStatus,
} from './service-order';
import type { AbnormalFlag } from './analyte';

/**
 * The order's pure policies: when exams may be ordered, what counts as
 * pending, which reports may be corrected, and when a line is complete. Pure
 * domain unit; cites ORD-005, ORD-008, ORD-039 and ORD-053.
 */

/** One stated value, as `supersedingStatus` compares it. */
interface Stated {
  analyteDisplay: string;
  valueNumeric: number | null;
  valueCode: string | null;
  valueText: string | null;
  unit: string | null;
  abnormalFlag: AbnormalFlag | null;
}

describe('las políticas de la orden', () => {
  it('ORD-005 admite pedir exámenes mientras la atención sigue viva', () => {
    // `ON_HOLD` la admite porque la atención está SUSPENDIDA, no terminada: el
    // paciente salió a la extracción, y rechazar aquí sería rechazar la orden
    // que causó la suspensión. `DISCHARGED` la admite porque el acto clínico
    // terminó y falta la caja: un examen pedido al salir es una consulta
    // normal, y la alternativa es abrir una segunda atención por una línea.
    expect(admitsNewOrders('OPEN')).toBe(true);
    expect(admitsNewOrders('ON_HOLD')).toBe(true);
    expect(admitsNewOrders('DISCHARGED')).toBe(true);
  });

  it('ORD-005 la rechaza en los tres estados terminales', () => {
    // Una orden colgada de una atención anulada es una orden que nadie va a
    // buscar, porque la atención de la que cuelga no está en ninguna pantalla.
    expect(admitsNewOrders('COMPLETED')).toBe(false);
    expect(admitsNewOrders('DISCONTINUED')).toBe(false);
    expect(admitsNewOrders('ENTERED_IN_ERROR')).toBe(false);
  });

  it('ORD-008 considera pendiente solo lo pedido y lo que está en curso', () => {
    expect(isPending('REQUESTED')).toBe(true);
    expect(isPending('IN_PROGRESS')).toBe(true);
    expect(isPending('COMPLETED')).toBe(false);
    expect(isPending('CANCELLED')).toBe(false);
  });

  it('ORD-053 ORD-119 se sustituye un informe definitivo, ya corregido o parcial; uno anulado no', () => {
    // Uno anulado ya no afirma nada. `CORRECTED` sí, porque una corrección
    // también puede estar mal; y un parcial se completa editándolo (ORD-119).
    expect(isCorrectable('FINAL')).toBe(true);
    expect(isCorrectable('CORRECTED')).toBe(true);
    expect(isCorrectable('PARTIAL')).toBe(true);
    expect(isCorrectable('CANCELLED')).toBe(false);
    // Lista explícita: un estado que se añadiera mañana no es editable por
    // omisión.
    expect(isCorrectable('ENTERED_IN_ERROR' as DiagnosticReportStatus)).toBe(false); // prettier-ignore
  });

  it('ORD-119 completar un parcial sin cambiar lo que ya decía no es una corrección; cambiar un valor, sí', () => {
    const kept = { analyteDisplay: 'Hemoglobina', valueNumeric: 13.4, valueCode: null, valueText: null, unit: 'g/dL', abnormalFlag: null }; // prettier-ignore
    const added = { analyteDisplay: 'Glucosa en ayunas', valueNumeric: 92, valueCode: null, valueText: null, unit: 'mg/dL', abnormalFlag: null }; // prettier-ignore
    const partial = { status: 'PARTIAL' as const, conclusion: null, results: [kept] }; // prettier-ignore

    // Completed: the status says what it now is.
    expect(supersedingStatus(partial, { conclusion: null, results: [kept, added] }, 'FINAL')).toBe('FINAL'); // prettier-ignore
    expect(supersedingStatus(partial, { conclusion: null, results: [kept] }, 'PARTIAL')).toBe('PARTIAL'); // prettier-ignore
    // A value that changes is never silent (ORD-050).
    expect(supersedingStatus(partial, { conclusion: null, results: [{ ...kept, valueNumeric: 9.1 }, added] }, 'FINAL')).toBe('CORRECTED'); // prettier-ignore
    // A definitive report superseded is always a correction.
    expect(supersedingStatus({ ...partial, status: 'FINAL' }, { conclusion: null, results: [kept] }, 'FINAL')).toBe('CORRECTED'); // prettier-ignore
    expect(supersedingStatus({ ...partial, status: 'CORRECTED' }, { conclusion: null, results: [kept] }, 'FINAL')).toBe('CORRECTED'); // prettier-ignore
  });

  it('ORD-119 lo que el parcial decía incluye la unidad, la marca de anormal y la conclusión: si cambia cualquiera, el completo es una corrección', () => {
    const kept: Stated = { analyteDisplay: 'Hemoglobina', valueNumeric: 13.4, valueCode: null, valueText: null, unit: 'g/dL', abnormalFlag: null }; // prettier-ignore
    const added: Stated = { analyteDisplay: 'Glucosa en ayunas', valueNumeric: 92, valueCode: null, valueText: null, unit: 'mg/dL', abnormalFlag: null }; // prettier-ignore
    const partial = { status: 'PARTIAL' as const, conclusion: 'Muestra lipémica', results: [kept] }; // prettier-ignore
    const completing = (changes: Partial<typeof kept>, conclusion: string | null = 'Muestra lipémica') => // prettier-ignore
      supersedingStatus(partial, { conclusion, results: [{ ...kept, ...changes }, added] }, 'FINAL'); // prettier-ignore

    expect(completing({ unit: 'g/L' })).toBe('CORRECTED');
    expect(completing({ abnormalFlag: 'LOW' })).toBe('CORRECTED');
    expect(completing({ valueText: 'hemolizada' })).toBe('CORRECTED');
    expect(completing({ valueCode: 'POS' })).toBe('CORRECTED');
    expect(completing({}, 'Sin observaciones')).toBe('CORRECTED');
    expect(completing({}, null)).toBe('CORRECTED');
    // Control positivo: nada de lo que decía cambia, y sólo se completa.
    expect(completing({})).toBe('FINAL');
    // Sin conclusión antes ni ahora: vacía y ausente son lo mismo.
    expect(supersedingStatus({ ...partial, conclusion: null }, { conclusion: '', results: [kept, added] }, 'FINAL')).toBe('FINAL'); // prettier-ignore
  });

  it('ORD-119 un informe que sigue incompleto se queda PARCIAL aunque cambie algo: CORREGIDO implica completo', () => {
    const kept = { analyteDisplay: 'Hemoglobina', valueNumeric: 13.4, valueCode: null, valueText: null, unit: 'g/dL', abnormalFlag: null }; // prettier-ignore
    const partial = { status: 'PARTIAL' as const, conclusion: null, results: [kept] }; // prettier-ignore

    expect(supersedingStatus(partial, { conclusion: null, results: [{ ...kept, valueNumeric: 9.1 }] }, 'PARTIAL')).toBe('PARTIAL'); // prettier-ignore
    expect(supersedingStatus(partial, { conclusion: 'Repetir', results: [kept] }, 'PARTIAL')).toBe('PARTIAL'); // prettier-ignore
    // Control positivo: el mismo cambio, ya completo, sí es una corrección.
    expect(supersedingStatus(partial, { conclusion: null, results: [{ ...kept, valueNumeric: 9.1 }] }, 'FINAL')).toBe('CORRECTED'); // prettier-ignore
  });

  it('ORD-039 cierra la línea cuando llegan todas las determinaciones no reflejas', () => {
    const promised = [
      { analyteDisplay: 'Hemoglobina', isReflex: false },
      { analyteDisplay: 'Hematocrito', isReflex: false },
      { analyteDisplay: 'Frotis', isReflex: true },
    ];

    // El reflejo no cuenta: sólo se produce cuando otro vuelve positivo, así
    // que contarlo dejaría toda biometría con diferencial reflejo pendiente
    // para siempre, y una cola permanentemente equivocada deja de leerse.
    expect(
      isLineComplete(promised, new Set(['Hemoglobina', 'Hematocrito'])),
    ).toBe(true);
    expect(isLineComplete(promised, new Set(['Hemoglobina']))).toBe(false);
  });

  it('ORD-039 nunca cierra la línea de un examen sin determinaciones declaradas', () => {
    // Un examen con la lista vacía es una fila de catálogo a medio construir.
    // Cerrar su línea la sacaría de la cola sin que nadie hubiera visto un
    // valor; dejarla visible es lo que tiene que hacer una fila a medias.
    expect(isLineComplete([], new Set(['lo que sea']))).toBe(false);
  });
});
