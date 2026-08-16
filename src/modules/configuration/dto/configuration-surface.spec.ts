import { describe, expect, it } from 'vitest';

import {
  createHolidaySchema,
  updateSiteParametersSchema,
} from './configuration.dto';

/**
 * CF-063 — the NEGATIVE requirement, proved on the only door parameters enter
 * through.
 *
 * A requirement that says «no debe existir» cannot be verified by testing what
 * exists: it needs a test that fails the day somebody adds the thing. That is
 * this file. The equivalent proof one layer down — that the `site_parameter`
 * table has no such column, and that no route accepts one — is in
 * `test/integration/configuration-http.spec.ts`, because a column is a fact
 * about the database and not about a schema.
 *
 * WHAT IS FORBIDDEN AND WHY, once, so the next person does not have to
 * reconstruct it:
 *
 *   - Non-overlap (REQ-140) is an `EXCLUDE USING gist`. A parameter turning it
 *     off means two patients in the same chair. The documented way to break it
 *     deliberately already exists and is recorded per appointment: the
 *     overbooking (REQ-143), whose CAP is a parameter — the cap is safe
 *     because no guarantee depends on its value.
 *   - Immutability of the status history (REQ-142) is an append-only trigger.
 *     Configuring it away removes, retroactively, the answer to «¿por qué
 *     salió anulada?».
 *   - Closed-by-default authorisation (REQ-118) is what turns a forgotten
 *     annotation into a refusal instead of an open door.
 */
describe('la superficie de configuración', () => {
  /**
   * Names an actual switch would plausibly be given. Not exhaustive and it
   * does not need to be: the exact-keys assertion below is what closes the
   * door, and this list is what makes the failure message say WHY.
   */
  const FORBIDDEN = [
    'allowOverlap',
    'allowOverlapping',
    'overlapAllowed',
    'skipOverlapCheck',
    'historyImmutable',
    'allowHistoryEdit',
    'mutableHistory',
    'closedByDefault',
    'openByDefault',
    'requirePermission',
    'blocksCalendar',
  ];

  it('CF-063 no expone como parámetro el no-solapamiento, la inmutabilidad del historial ni el cierre por defecto', () => {
    const declared = Object.keys(updateSiteParametersSchema.shape);

    for (const forbidden of FORBIDDEN) {
      expect(
        declared,
        `«${forbidden}» convertiría una garantía del sistema en un ajuste. CF-063 y REQ-146 lo prohíben`,
      ).not.toContain(forbidden);
    }
  });

  it('CF-063 admite exactamente los parámetros declarados y ninguno más', () => {
    /**
     * The closed list is the requirement. A new key here is a decision
     * somebody has to defend in a diff, which is the whole point.
     *
     * `allowPastBooking` (AG-031, AG-094) is the fifth and it belongs: CF-063
     * forbids exposing what would STOP BEING A GUARANTEE once configurable,
     * and admitting a start earlier than now touches none of the three it
     * names. The `EXCLUDE USING gist` still refuses an overlap in that past
     * hour, `agenda_status_history` is still written by the same append-only
     * trigger, and booking still demands `agenda:write` and scope over the
     * site. What changes is WHICH HOUR is accepted, which is precisely the
     * class of decision REQ-145 wants in configuration instead of burnt into
     * the code.
     */
    expect(Object.keys(updateSiteParametersSchema.shape).sort()).toEqual([
      'allowPastBooking',
      'cancelledRetention',
      'maxLeadDays',
      'minLeadMinutes',
      'overbookingCap',
      /**
       * E4, D-005: el interruptor del sobrecupo (AG-039) y el permiso que lo
       * autoriza (AG-101). Pasan la misma prueba que los anteriores, y el
       * segundo merece decirse porque parece que no: elegir QUÉ PERMISO
       * autoriza una excepción no es configurar la excepción. El `EXCLUDE`
       * sigue en pie, la constancia del sobrecupo es un CHECK de la base, y la
       * separación entre quien reserva y quien autoriza (AG-103) no es
       * parámetro ni va a serlo. Lo que la clínica elige es QUIÉN lleva la
       * decisión, que es exactamente lo que D-002 dice que es política suya.
       */
      'overbookingEnabled',
      'overbookingPermission',
      // D-021: el turno de la agenda. Pertenece a la lista por lo mismo que
      // `allowPastBooking` — configurarlo no deja de garantizar nada. Al
      // revés: es lo que hace que AG-012 y AG-104 no puedan fallar por
      // configuración, porque toda duración se guarda como múltiplo suyo.
      'slotAtomMinutes',
    ]);
  });

  it('CF-063 descarta un interruptor de garantía enviado en el cuerpo en lugar de guardarlo', () => {
    // Zod strips what it does not declare, so the value never reaches the
    // service, never reaches the row, and never becomes a `true` somebody
    // later reads and honours. Asserting it explicitly is what stops a future
    // `.passthrough()` from turning the strip into a store.
    const parsed = updateSiteParametersSchema.parse({
      overbookingCap: 4,
      allowPastBooking: true,
      allowOverlap: true,
      historyImmutable: false,
    });

    // The declared parameters survive — including the one whose name looks
    // like a switch and is not one — and the guarantees do not.
    expect(parsed).toEqual({ overbookingCap: 4, allowPastBooking: true });
  });

  it('CF-060 exige fecha y nombre en un feriado, y deja el alcance opcional', () => {
    const parsed = createHolidaySchema.parse({
      date: '2026-01-01',
      name: 'Año Nuevo',
    });

    // Absent scope is «todas las sedes» and is not the same as a site chosen
    // at random; the service turns `undefined` into `null` explicitly.
    expect(parsed).toEqual({ date: '2026-01-01', name: 'Año Nuevo' });
  });

  it('CF-060 rechaza una fecha con hora: un feriado es un día del calendario', () => {
    // Accepting an instant would force a timezone decision, and a `::date` on
    // it at 21:00 falls on the next day in `America/Guayaquil`.
    expect(() =>
      createHolidaySchema.parse({
        date: '2026-01-01T00:00:00Z',
        name: 'Año Nuevo',
      }),
    ).toThrow();
  });
});
