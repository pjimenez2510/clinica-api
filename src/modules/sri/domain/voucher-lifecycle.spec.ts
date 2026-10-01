import { describe, expect, it } from 'vitest';

import {
  afterAuthorisation,
  afterReception,
  authorisationDocument,
  isRetriableByAPerson,
  needsAPerson,
  retryDelaySeconds,
  type SriMessage,
} from './voucher-lifecycle';

const message = (identifier: string, type = 'ERROR'): SriMessage => ({
  identifier,
  message: `mensaje ${identifier}`,
  additionalInformation: null,
  type,
});

describe('SRI-043 a SRI-046, SRI-050 lo que hace cada respuesta de recepción', () => {
  it('SRI-043 RECIBIDA pasa a RECEIVED y programa la consulta de autorización', () => {
    expect(
      afterReception('SIGNED', { kind: 'RECIBIDA', messages: [] }, 1),
    ).toEqual({
      status: 'RECEIVED',
      invoiceStatus: null,
      lastMessages: [],
      next: { step: 'AUTHORISE', delaySeconds: 3 },
    });
  });

  it('SRI-044 DEVUELTA con 43 es «ya lo tengo»: se consulta con la misma clave, sin rechazar la factura', () => {
    const transition = afterReception(
      'SIGNED',
      { kind: 'DEVUELTA', messages: [message('43')] },
      1,
    );
    expect(transition.status).toBe('RECEIVED');
    expect(transition.invoiceStatus).toBeNull();
    expect(transition.next?.step).toBe('AUTHORISE');
  });

  it('SRI-045 DEVUELTA con 70 consulta con espera creciente y nunca reenvía', () => {
    const transition = afterReception(
      'SIGNED',
      { kind: 'DEVUELTA', messages: [message('70')] },
      3,
    );
    expect(transition.status).toBe('RECEIVED');
    expect(transition.next).toEqual({ step: 'AUTHORISE', delaySeconds: 120 });
    expect(transition.next?.step).not.toBe('SEND');
  });

  it('SRI-046 DEVUELTA por otro motivo queda RETURNED, la factura REJECTED, y no se reintenta sola', () => {
    const messages = [message('35'), message('43')];
    expect(afterReception('SIGNED', { kind: 'DEVUELTA', messages }, 1)).toEqual(
      {
        status: 'RETURNED',
        invoiceStatus: 'REJECTED',
        lastMessages: messages,
        next: null,
      },
    );
  });

  it('SRI-046 una DEVUELTA sin mensajes tampoco es «ya enviado»', () => {
    expect(
      afterReception('SIGNED', { kind: 'DEVUELTA', messages: [] }, 1).status,
    ).toBe('RETURNED');
  });

  it('SRI-050 un fallo de transporte mantiene el estado y reenvía más tarde', () => {
    expect(
      afterReception(
        'SIGNED',
        { kind: 'TRANSPORT_FAILURE', error: 'timeout' },
        2,
      ),
    ).toEqual({
      status: 'SIGNED',
      invoiceStatus: null,
      lastMessages: null,
      next: { step: 'SEND', delaySeconds: 60 },
    });
  });
});

describe('SRI-047 a SRI-050 lo que hace cada respuesta de autorización', () => {
  it('SRI-047 AUTORIZADO autoriza el comprobante y la factura y programa la entrega', () => {
    const transition = afterAuthorisation(
      {
        kind: 'AUTORIZADO',
        authorisationNumber: '1'.repeat(49),
        authorisedAt: new Date(),
        authorisedAtText: '2026-09-30T10:00:00-05:00', // fecha-fija: texto que devuelve el SRI, no se compara con el reloj
        environmentLabel: 'PRUEBAS',
        voucherXml: '<factura/>',
        messages: [message('60', 'ADVERTENCIA')],
      },
      1,
    );
    expect(transition).toMatchObject({
      status: 'AUTHORISED',
      invoiceStatus: 'AUTHORISED',
      next: { step: 'DELIVER', delaySeconds: 0 },
    });
  });

  it('SRI-048 NO AUTORIZADO deja el comprobante NOT_AUTHORISED y la factura REJECTED', () => {
    expect(
      afterAuthorisation(
        { kind: 'NO AUTORIZADO', messages: [message('39')] },
        1,
      ),
    ).toMatchObject({
      status: 'NOT_AUTHORISED',
      invoiceStatus: 'REJECTED',
      next: null,
    });
  });

  it('SRI-049 SRI-050 sin respuesta todavía, o sin conexión, vuelve a consultar y nunca reenvía', () => {
    for (const answer of [
      { kind: 'PENDING' as const },
      { kind: 'TRANSPORT_FAILURE' as const, error: 'ECONNREFUSED' },
    ]) {
      const transition = afterAuthorisation(answer, 1);
      expect(transition.status).toBe('RECEIVED');
      expect(transition.next).toEqual({ step: 'AUTHORISE', delaySeconds: 30 });
    }
  });
});

describe('SRI-052 la espera crece con un tope', () => {
  it('SRI-052 30 s, 1 min, 2 min… y nunca más de una hora', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([30, 60, 120, 240]);
    expect(retryDelaySeconds(8)).toBe(3600);
    expect(retryDelaySeconds(500)).toBe(3600);
  });
});

describe('SRI-058, SRI-062 qué reintenta una persona y qué va primero en el monitor', () => {
  it('SRI-058 solo lo devuelto o no autorizado se reintenta a mano', () => {
    expect(isRetriableByAPerson('RETURNED')).toBe(true);
    expect(isRetriableByAPerson('NOT_AUTHORISED')).toBe(true);
    for (const status of [
      'PREPARED',
      'SIGNED',
      'RECEIVED',
      'AUTHORISED',
    ] as const) {
      expect(isRetriableByAPerson(status)).toBe(false);
    }
  });

  it('SRI-062 lo que necesita a una persona va antes que lo que la cola resolverá sola', () => {
    expect(needsAPerson('NO_VOUCHER')).toBe(true);
    expect(needsAPerson('PREPARED')).toBe(true);
    expect(needsAPerson('RETURNED')).toBe(true);
    expect(needsAPerson('SIGNED')).toBe(false);
    expect(needsAPerson('RECEIVED')).toBe(false);
  });
});

describe('SRI-073 el documento de autorización', () => {
  it('SRI-073 lleva estado, número, fecha, ambiente y el comprobante firmado en CDATA', () => {
    const document = authorisationDocument({
      authorisationNumber: '2'.repeat(49),
      authorisedAtText: '2026-09-30T10:00:00-05:00', // fecha-fija: texto que devuelve el SRI
      environmentLabel: 'PRUEBAS',
      voucherXml: '<factura id="comprobante"><a>x</a></factura>',
    });
    expect(document).toContain('<estado>AUTORIZADO</estado>');
    expect(document).toContain(
      `<numeroAutorizacion>${'2'.repeat(49)}</numeroAutorizacion>`,
    );
    expect(document).toContain('<ambiente>PRUEBAS</ambiente>');
    expect(document).toContain(
      '<comprobante><![CDATA[<factura id="comprobante"><a>x</a></factura>]]></comprobante>',
    );
  });
});
