import { describe, expect, it } from 'vitest';

import {
  admitsNewOrders,
  isCorrectable,
  isLineComplete,
  isPending,
} from './service-order';

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

  it('ORD-053 sólo corrige un informe definitivo o ya corregido', () => {
    // Un parcial no se corrige, se completa; uno anulado ya no afirma nada. Y
    // `CORRECTED` sí, porque una corrección también puede estar mal.
    expect(isCorrectable('FINAL')).toBe(true);
    expect(isCorrectable('CORRECTED')).toBe(true);
    expect(isCorrectable('PARTIAL')).toBe(false);
    expect(isCorrectable('CANCELLED')).toBe(false);
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
