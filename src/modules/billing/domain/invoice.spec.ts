import { describe, expect, it } from 'vitest';

import { InvalidCedulaError } from '../../../shared/domain/value-objects/cedula.vo';
import { InvalidRucError } from '../../../shared/domain/value-objects/ruc.vo';
import {
  FinalConsumerNotConfirmedError,
  InvoiceReceiverIsPayerError,
  InvoiceReceiverRequiredError,
} from './billing.errors';
import {
  FINAL_CONSUMER_IDENTIFICATION,
  type ReceiverContext,
  nextSequential,
  proposeReceiver,
  resolveReceiver,
} from './invoice';

/**
 * Who an invoice is issued to — the proposed and the required receiver,
 * «Consumidor Final» only on purpose, never the payer by default — and the
 * nine-digit sequential of an emission point. Pure domain unit; cites BI-035,
 * BI-080, BI-081, BI-082, BI-085 and BI-087.
 */

const context = (
  overrides: Partial<ReceiverContext> = {},
): ReceiverContext => ({
  patientIdentificationType: '05',
  patientIdentification: '1710034065',
  patientName: 'Guamán Andrade, María José',
  thirdPartyPayerRuc: null,
  ...overrides,
});

const receiver = {
  identificationType: '05' as const,
  identification: '1710034065',
  name: 'Guamán Andrade, María José',
};

describe('BI-080, BI-082 quién recibe la factura', () => {
  it('BI-082 propone la identificación del paciente de la cuenta', () => {
    expect(proposeReceiver(context())).toEqual({
      identificationType: '05',
      identification: '1710034065',
      name: 'Guamán Andrade, María José',
    });
  });

  it('BI-082 no propone nada cuando el paciente no tiene identificación reconocible', () => {
    // A newborn's provisional number is not an identification the SRI knows.
    // Proposing it as a cedula would put a number on an invoice no tax
    // authority can match to a person.
    expect(
      proposeReceiver(
        context({ patientIdentificationType: null, patientIdentification: '999' }), // prettier-ignore
      ),
    ).toEqual({});
  });

  it('BI-080 exige tipo, número y nombre, y dice CUÁL falta', () => {
    for (const [field, request] of [
      ['receiver.identificationType', { identification: '1710034065', name: 'X' }], // prettier-ignore
      ['receiver.identification', { identificationType: '05' as const, name: 'X' }], // prettier-ignore
      ['receiver.name', { identificationType: '05' as const, identification: '1710034065' }], // prettier-ignore
    ] as const) {
      const thrown = (() => {
        try {
          resolveReceiver(request, context());
          return null;
        } catch (error) {
          return error;
        }
      })();

      expect(thrown).toBeInstanceOf(InvoiceReceiverRequiredError);
      expect((thrown as InvoiceReceiverRequiredError).fieldErrors?.[0]?.field).toBe(field); // prettier-ignore
    }
  });

  it('BI-080 devuelve el bloque del receptor cuando está completo', () => {
    expect(
      resolveReceiver({ ...receiver, email: ' maria@ejemplo.ec ' }, context()),
    ).toEqual({
      buyerIdentificationType: '05',
      buyerIdentification: '1710034065',
      buyerName: 'Guamán Andrade, María José',
      buyerEmail: 'maria@ejemplo.ec',
      isFinalConsumer: false,
    });
  });
});

describe('BI-159 el RUC y la cédula del receptor son los que el SRI acepta', () => {
  const thrownBy = (request: Parameters<typeof resolveReceiver>[0]) => {
    try {
      resolveReceiver(request, context());
      return null;
    } catch (error) {
      return error;
    }
  };

  it.each([
    ['sin establecimiento (000)', '1790012345000'],
    ['de una provincia que no existe', '2590000000001'],
    ['de persona natural con verificador equivocado', '1710034066001'],
    ['de doce dígitos', '179001234500'],
    ['de tercer dígito 7, que no es de nadie', '1770012345001'],
  ])('BI-159 rechaza un RUC %s sobre receiver.identification', (_, ruc) => {
    const thrown = thrownBy({ ...receiver, identificationType: '04', identification: ruc }); // prettier-ignore

    expect(thrown).toBeInstanceOf(InvalidRucError);
    expect((thrown as InvalidRucError).fieldErrors?.[0]).toMatchObject({
      field: 'receiver.identification',
      code: 'INVALID_RUC',
    });
  });

  it.each([
    ['con verificador equivocado', '1710034066'],
    ['de una provincia que no existe', '2510034065'],
    ['de nueve dígitos', '171003406'],
    ['de tercer dígito 6, que es de un RUC', '1760013210'],
  ])(
    'BI-159 rechaza una cédula %s sobre receiver.identification',
    (_, cedula) => {
      const thrown = thrownBy({ ...receiver, identification: cedula });

      expect(thrown).toBeInstanceOf(InvalidCedulaError);
      expect((thrown as InvalidCedulaError).fieldErrors?.[0]).toMatchObject({
        field: 'receiver.identification',
        code: 'INVALID_CEDULA',
      });
    },
  );

  it.each([
    ['sociedad privada con la numeración de 2021', '1793189906001'],
    ['sociedad de Guayas', '0993366721001'],
    ['persona natural', '1710034065001'],
    ['entidad del sector público', '1760013210001'],
    ['persona inscrita en el exterior (provincia 30)', '3001234560001'],
  ])('BI-159 admite el RUC de una %s', (_, ruc) => {
    expect(
      resolveReceiver({ ...receiver, identificationType: '04', identification: ` ${ruc} ` }, context()), // prettier-ignore
    ).toMatchObject({
      buyerIdentificationType: '04',
      buyerIdentification: ruc,
    });
  });

  it.each([
    ['de Pichincha', '1710034065'],
    [
      'de la provincia 30, la de quien se inscribió en el exterior',
      '3001234560',
    ],
  ])('BI-159 admite la cédula ecuatoriana válida %s', (_, cedula) => {
    expect(
      resolveReceiver({ ...receiver, identification: cedula }, context()),
    ).toMatchObject({ buyerIdentificationType: '05', buyerIdentification: cedula }); // prettier-ignore
  });

  it.each([
    ['06', 'AB123456'],
    ['08', '1234567890'],
  ] as const)(
    'BI-159 no impone forma al documento %s, que emite otro país',
    (type, identification) => {
      const resolved = resolveReceiver(
        { ...receiver, identificationType: type, identification },
        context(),
      );
      expect(resolved).toMatchObject({
        buyerIdentificationType: type,
        buyerIdentification: identification,
      });
    },
  );
});

describe('BI-081 «Consumidor Final» es una excepción explícita', () => {
  it('BI-081 no lo toma nunca por defecto: sin `finalConsumer` exige el receptor', () => {
    expect(() => resolveReceiver({}, context())).toThrow(
      InvoiceReceiverRequiredError,
    );
  });

  it('BI-081 rechaza la confirmación ausente y el motivo ausente por separado', () => {
    expect(
      () =>
      resolveReceiver({ finalConsumer: { reason: 'El paciente no la quiere' } }, context()), // prettier-ignore
    ).toThrow(FinalConsumerNotConfirmedError);

    expect(() =>
      resolveReceiver({ finalConsumer: { confirmed: true } }, context()),
    ).toThrow(FinalConsumerNotConfirmedError);
  });

  it('BI-081 rechaza colar el tipo `07` por el camino ordinario', () => {
    // `07` IS «venta a consumidor final» in the SRI's own table. Letting it
    // through the ordinary branch would be the exact bypass the explicit
    // branch exists to close — and the database would take the row, since
    // `invoice_final_consumer_identification` only constrains the FLAG.
    expect(() =>
      resolveReceiver(
        { identificationType: '07', identification: FINAL_CONSUMER_IDENTIFICATION, name: 'CONSUMIDOR FINAL' }, // prettier-ignore
        context(),
      ),
    ).toThrow(FinalConsumerNotConfirmedError);
  });

  it('BI-081 emite con la identificación 9999999999999 cuando alguien lo elige a propósito', () => {
    expect(
      resolveReceiver(
        { finalConsumer: { confirmed: true, reason: 'El paciente se negó a dar sus datos' } }, // prettier-ignore
        context(),
      ),
    ).toEqual({
      buyerIdentificationType: '07',
      buyerIdentification: FINAL_CONSUMER_IDENTIFICATION,
      buyerName: 'CONSUMIDOR FINAL',
      buyerEmail: null,
      isFinalConsumer: true,
    });
  });
});

describe('BI-035, BI-087 el pagador no decide quién figura en la factura', () => {
  it('BI-087 rechaza emitir la factura a nombre de la aseguradora', () => {
    // A reimbursement invoice made out to the insurer is not the patient's
    // expense, and the insurer sends it back. The mistake takes exactly this
    // shape: somebody pastes the payer's RUC because it is the one on screen.
    expect(() =>
      resolveReceiver(
        { identificationType: '04', identification: '1790012344001', name: 'Aseguradora' }, // prettier-ignore
        context({ thirdPartyPayerRuc: '1790012344001' }),
      ),
    ).toThrow(InvoiceReceiverIsPayerError);
  });

  it('BI-087 admite al paciente aunque el pagador sea un tercero', () => {
    expect(
      resolveReceiver(
        receiver,
        context({ thirdPartyPayerRuc: '1790012344001' }),
      ),
    ).toMatchObject({ buyerIdentification: '1710034065' });
  });

  it('BI-035 no lee el pagador para PROPONER un receptor', () => {
    // The payer says which price list applies. It never says who appears on
    // the document, and the proposal does not read it at all.
    expect(
      proposeReceiver(context({ thirdPartyPayerRuc: '1790012344001' })),
    ).toEqual({
      identificationType: '05',
      identification: '1710034065',
      name: 'Guamán Andrade, María José',
    });
  });
});

describe('BI-085 el secuencial del punto de emisión', () => {
  it('BI-085 empieza en 000000001 y avanza de uno en uno', () => {
    expect(nextSequential(null)).toBe('000000001');
    expect(nextSequential('000000001')).toBe('000000002');
    expect(nextSequential('000000999')).toBe('000001000');
  });

  it('BI-085 conserva los nueve dígitos, porque el cero a la izquierda cuenta', () => {
    expect(nextSequential('000000009')).toHaveLength(9);
  });

  it('BI-085 se niega a seguir cuando el punto de emisión se agota', () => {
    // Truncating silently would collide with the number issued a billion
    // documents ago, and the SRI would receive two vouchers under one key.
    expect(() => nextSequential('999999999')).toThrow(RangeError);
  });
});
