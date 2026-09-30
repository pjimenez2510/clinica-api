import { describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import {
  type AlreadyCharged,
  type ChargeMapping,
  consultationKeyOf,
  proposeCharges,
} from './charge-proposal';
import type { EncounterActs } from './clinical-acts.port';

/**
 * FROM THE CLINICAL ACT TO THE CHARGE, tested where it is decided.
 *
 * Everything asserted here is a decision — WHICH lines a visit suggests and
 * which acts produce none — and none of it needs a database, because the
 * derivation is pure. What DOES need PostgreSQL is the promise that pressing
 * twice cannot write twice, and that lives in
 * `test/integration/billing-checkout.spec.ts`: a double that returns what we
 * told it to would not prove a partial unique index exists.
 */

const VISIT_DATE = parseClinicalDate('2026-09-14');
const PROCEDURE_DATE = parseClinicalDate('2026-09-15');
const ORDER_DATE = parseClinicalDate('2026-09-14');

const DERMATOLOGY = 'specialty-dermatology';

const acts = (overrides: Partial<EncounterActs> = {}): EncounterActs => ({
  encounterId: 'encounter-1',
  siteId: 'site-1',
  patientId: 'patient-1',
  status: 'DISCHARGED',
  serviceDate: VISIT_DATE,
  visitSequence: 'FIRST_TIME',
  specialtyId: DERMATOLOGY,
  procedures: [],
  exams: [],
  ...overrides,
});

const mapping = (overrides: Partial<ChargeMapping> = {}): ChargeMapping => ({
  consultation: { billableServiceId: 'service-consultation', active: true },
  byProcedureConcept: new Map([
    ['concept-suture', { billableServiceId: 'service-suture', active: true }],
  ]),
  byExamCode: new Map([
    ['EX-BH', { billableServiceId: 'service-bh', active: true }],
  ]),
  ...overrides,
});

const nothingCharged = (
  overrides: Partial<AlreadyCharged> = {},
): AlreadyCharged => ({
  consultation: false,
  encounterProcedureIds: new Set<string>(),
  serviceOrderItemIds: new Set<string>(),
  ...overrides,
});

const aSuture = {
  encounterProcedureId: 'procedure-1',
  conceptId: 'concept-suture',
  serviceDate: PROCEDURE_DATE,
  quantity: 2,
};

const aBloodCount = {
  serviceOrderItemId: 'order-item-1',
  testCode: 'EX-BH',
  serviceDate: ORDER_DATE,
  cancelled: false,
};

describe('BI-151 el costo sale de lo que realmente se hizo', () => {
  it('BI-151 propone la consulta, los procedimientos y los exámenes de la atención', () => {
    // The three sources of the delivery, in one visit: the consultation
    // itself, one procedure recorded during it, one test ordered from it.
    const proposal = proposeCharges(
      acts({ procedures: [aSuture], exams: [aBloodCount] }),
      mapping(),
      nothingCharged(),
    );

    expect(proposal.proposed.map((line) => line.origin)).toEqual([
      'CONSULTATION',
      'PROCEDURE',
      'EXAM',
    ]);
    expect(proposal.skipped).toEqual([]);
  });

  it('BI-153 ata cada línea propuesta al acto clínico del que nació', () => {
    // «Qué se hizo» y «qué se cobra» son dos registros, y el segundo tiene que
    // poder señalar al primero — sin llave foránea, que retendría la fila
    // clínica, y sin adivinarlo por el nombre de la prestación.
    const proposal = proposeCharges(
      acts({ procedures: [aSuture], exams: [aBloodCount] }),
      mapping(),
      nothingCharged(),
    );

    expect(proposal.proposed).toEqual([
      expect.objectContaining({
        origin: 'CONSULTATION',
        encounterProcedureId: null,
        serviceOrderItemId: null,
      }),
      expect.objectContaining({
        origin: 'PROCEDURE',
        encounterProcedureId: 'procedure-1',
        serviceOrderItemId: null,
      }),
      expect.objectContaining({
        origin: 'EXAM',
        encounterProcedureId: null,
        serviceOrderItemId: 'order-item-1',
      }),
    ]);
  });

  it('BI-052 toma la fecha DEL ACTO y no la de la atención ni la de hoy', () => {
    // A procedure performed the day after the visit began — a visit that
    // crossed midnight — prices at ITS date. On almost every day the two
    // coincide, which is exactly why the difference has to be asserted.
    const proposal = proposeCharges(
      acts({ procedures: [aSuture] }),
      mapping(),
      nothingCharged(),
    );

    expect(proposal.proposed[0]?.serviceDate).toBe(VISIT_DATE);
    expect(proposal.proposed[1]?.serviceDate).toBe(PROCEDURE_DATE);
  });

  it('BI-057 propone la cantidad que dice el acto, no siempre una', () => {
    const proposal = proposeCharges(
      acts({ procedures: [{ ...aSuture, quantity: 3 }] }),
      mapping(),
      nothingCharged(),
    );

    expect(proposal.proposed[1]?.quantity.toString()).toBe('3.000');
  });
});

describe('BI-158 la consulta se resuelve por dato, nunca por el nombre', () => {
  it('BI-158 pide la consulta por especialidad y tipo de visita', () => {
    expect(consultationKeyOf(acts({ visitSequence: 'SUBSEQUENT' }))).toEqual({
      specialtyId: DERMATOLOGY,
      visitSequence: 'SUBSEQUENT',
    });
  });

  it('BI-158 no propone consulta cuando la atención no dice de qué especialidad es', () => {
    // A walk-in with no appointment has no service type to read the specialty
    // from. The answer is a proposal with one line missing — never a guess: a
    // wrong specialty is a wrong price on an invoice nobody can correct.
    const proposal = proposeCharges(
      acts({ specialtyId: null }),
      mapping(),
      nothingCharged(),
    );

    expect(consultationKeyOf(acts({ specialtyId: null }))).toBeNull();
    expect(proposal.proposed).toEqual([]);
    expect(proposal.skipped).toEqual([
      expect.objectContaining({
        origin: 'CONSULTATION',
        reason: 'NO_BILLABLE_SERVICE',
      }),
    ]);
  });

  it('BI-158 no propone consulta cuando nadie ha dicho cuál es la de esa especialidad', () => {
    const proposal = proposeCharges(
      acts(),
      mapping({ consultation: null }),
      nothingCharged(),
    );

    expect(proposal.proposed).toEqual([]);
  });
});

describe('BI-155 lo que no se puede derivar se dice, y no bloquea el resto', () => {
  it('BI-155 propone las demás líneas aunque un procedimiento no tenga prestación', () => {
    // One unmappable act must not cost the clinic the other lines of the
    // visit. It is reported with its identifier so somebody can act on it.
    const proposal = proposeCharges(
      acts({
        procedures: [
          aSuture,
          {
            encounterProcedureId: 'procedure-2',
            conceptId: 'concept-nobody-mapped',
            serviceDate: PROCEDURE_DATE,
            quantity: 1,
          },
        ],
      }),
      mapping(),
      nothingCharged(),
    );

    expect(proposal.proposed).toHaveLength(2);
    expect(proposal.skipped).toEqual([
      {
        origin: 'PROCEDURE',
        encounterProcedureId: 'procedure-2',
        serviceOrderItemId: null,
        reason: 'NO_BILLABLE_SERVICE',
      },
    ]);
  });

  it('BI-015, BI-155 no propone una prestación desactivada y dice por qué', () => {
    const proposal = proposeCharges(
      acts({ exams: [aBloodCount] }),
      mapping({
        byExamCode: new Map([
          ['EX-BH', { billableServiceId: 'service-bh', active: false }],
        ]),
      }),
      nothingCharged(),
    );

    expect(proposal.skipped).toEqual([
      expect.objectContaining({ origin: 'EXAM', reason: 'SERVICE_INACTIVE' }),
    ]);
  });

  it('BI-155 no propone un examen anulado en la orden: nadie lo hizo', () => {
    const proposal = proposeCharges(
      acts({ exams: [{ ...aBloodCount, cancelled: true }] }),
      mapping(),
      nothingCharged(),
    );

    expect(proposal.skipped).toEqual([
      expect.objectContaining({ origin: 'EXAM', reason: 'ACT_CANCELLED' }),
    ]);
  });

  it('BI-155 no nombra la prestación en lo que informa como omitido', () => {
    // BI-007: el nombre de un examen puede ser tan revelador como un
    // diagnóstico, y esta respuesta pasa por registros. Viajan el código y el
    // identificador; el nombre, nunca.
    const proposal = proposeCharges(
      acts({ exams: [{ ...aBloodCount, testCode: 'EX-VIH' }] }),
      mapping(),
      nothingCharged(),
    );

    expect(JSON.stringify(proposal.skipped)).not.toContain('EX-VIH');
  });
});

describe('BI-154, BI-157 pulsar dos veces no propone dos veces', () => {
  it('BI-154 no vuelve a proponer un acto que ya tiene cargo', () => {
    const proposal = proposeCharges(
      acts({ procedures: [aSuture], exams: [aBloodCount] }),
      mapping(),
      nothingCharged({
        consultation: true,
        encounterProcedureIds: new Set(['procedure-1']),
        serviceOrderItemIds: new Set(['order-item-1']),
      }),
    );

    expect(proposal.proposed).toEqual([]);
    expect(proposal.skipped.map((line) => line.reason)).toEqual([
      'ALREADY_CHARGED',
      'ALREADY_CHARGED',
      'ALREADY_CHARGED',
    ]);
  });

  it('BI-157 no resucita la línea que caja quitó, porque su cargo sigue existiendo', () => {
    // Voiding keeps the row (BI-055), so the act still counts as charged. A
    // system that offered it again on the next press would be charging what a
    // person deliberately decided not to charge.
    const proposal = proposeCharges(
      acts({ exams: [aBloodCount] }),
      mapping(),
      nothingCharged({ serviceOrderItemIds: new Set(['order-item-1']) }),
    );

    expect(proposal.proposed.map((line) => line.origin)).toEqual([
      'CONSULTATION',
    ]);
  });
});

describe('BI-156 lo económico no reescribe lo clínico', () => {
  it('BI-156 no propone nada sobre una atención marcada como error de registro', () => {
    // `ENTERED_IN_ERROR` exists precisely so a visit that should never have
    // been recorded does not count as one. Charging for it would be the system
    // asserting the opposite.
    const proposal = proposeCharges(
      acts({
        status: 'ENTERED_IN_ERROR',
        procedures: [aSuture],
        exams: [aBloodCount],
      }),
      mapping(),
      nothingCharged(),
    );

    expect(proposal).toEqual({ proposed: [], skipped: [] });
  });

  it('BI-156 propone igual sobre una atención todavía abierta', () => {
    // BI-073: the clinical closure and the trip to the cashier do not wait for
    // each other in either direction. Requiring the visit to be closed here
    // would be the system that keeps a doctor waiting for a cashier.
    const proposal = proposeCharges(
      acts({ status: 'OPEN', procedures: [aSuture] }),
      mapping(),
      nothingCharged(),
    );

    expect(proposal.proposed).toHaveLength(2);
  });
});
