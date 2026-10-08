import { describe, expect, it } from 'vitest';

import { Principal } from '../authorisation/principal';

import {
  LIVE_EVENT_PERMISSION,
  LIVE_STREAM_PERMISSIONS,
  type LiveEvent,
  type LiveEventKind,
  mayReceive,
  parseLiveEvent,
} from './live-event';
import { InProcessLiveEventBus } from './live-event-bus';

const SITE_A = '01990000-0000-7000-8000-00000000000a';
const SITE_B = '01990000-0000-7000-8000-00000000000b';

function readerAt(siteId: string | null): Principal {
  return new Principal('01990000-0000-7000-8000-000000000001', [
    { roleCode: 'MEDICO', siteId, permissions: ['record:read'] },
  ]);
}

describe('el aviso en vivo', () => {
  it('AU-055: sólo admite su tipo y su sede; un campo de más se rechaza', () => {
    expect(
      parseLiveEvent(
        JSON.stringify({ kind: 'critical-results', siteId: SITE_A }),
      ),
    ).toEqual({ kind: 'critical-results', siteId: SITE_A });

    for (const extra of [
      { patientId: SITE_B },
      { value: 6.9 },
      { analyte: 'Potasio' },
    ]) {
      expect(
        parseLiveEvent(
          JSON.stringify({
            kind: 'critical-results',
            siteId: SITE_A,
            ...extra,
          }),
        ),
      ).toBeNull();
    }
  });

  it('AU-056: un tipo sin permiso declarado, o un cuerpo que no es un aviso, no pasa', () => {
    expect(
      parseLiveEvent(JSON.stringify({ kind: 'screening', siteId: SITE_A })),
    ).toBeNull();
    expect(parseLiveEvent('no es json')).toBeNull();
    expect(
      parseLiveEvent(JSON.stringify({ kind: 'critical-results' })),
    ).toBeNull();
    // Every kind there is declares the permission that receives it.
    for (const permission of Object.values(LIVE_EVENT_PERMISSION)) {
      expect(permission).toMatch(/^[a-z-]+:[a-z-:]+$/);
    }
  });

  it('AU-056: llega a quien lee esa sede, y no a quien lee sólo otra', () => {
    const event = { kind: 'critical-results', siteId: SITE_A } as const;

    expect(mayReceive(readerAt(SITE_A), event)).toBe(true);
    expect(mayReceive(readerAt(null), event)).toBe(true);
    expect(mayReceive(readerAt(SITE_B), event)).toBe(false);
    expect(
      mayReceive(
        new Principal('u', [
          { roleCode: 'CAJA', siteId: SITE_A, permissions: ['billing:read'] },
        ]),
        event,
      ),
    ).toBe(false);
  });

  it('AU-058: sin Redis, el bus de la instancia entrega a todos y un oyente que falla no se lo quita a los demás', () => {
    const bus = new InProcessLiveEventBus();
    const heard: string[] = [];
    bus.subscribe(() => {
      throw new Error('stream closed');
    });
    const stop = bus.subscribe((event) => heard.push(event.siteId));

    bus.publish({ kind: 'critical-results', siteId: SITE_A });
    stop();
    bus.publish({ kind: 'critical-results', siteId: SITE_B });

    expect(heard).toEqual([SITE_A]);
  });

  it('AG-180: la pantalla de sala sólo oye `waiting-room` de su sede; recepción, `agenda` y no `billing`', () => {
    const room = new Principal('sala', [
      { roleCode: 'PANTALLA_SALA', siteId: SITE_A, permissions: ['agenda:board:public'] }, // prettier-ignore
    ]);
    const reception = new Principal('recepcion', [
      { roleCode: 'RECEPCION', siteId: SITE_A, permissions: ['agenda:read', 'agenda:write'] }, // prettier-ignore
    ]);
    const heardBy = (principal: Principal, siteId: string) =>
      (Object.keys(LIVE_EVENT_PERMISSION) as LiveEventKind[]).filter((kind) =>
        mayReceive(principal, { kind, siteId }),
      );

    expect(heardBy(room, SITE_A)).toEqual(['waiting-room']);
    expect(heardBy(room, SITE_B)).toEqual([]);
    expect(heardBy(reception, SITE_A)).toEqual(['agenda']);
    expect(heardBy(reception, SITE_B)).toEqual([]);
  });

  it('BI-238, SRI-092: caja oye `billing` y `sri` de su sede y nada clínico', () => {
    const cashier = new Principal('caja', [
      { roleCode: 'CAJA', siteId: SITE_A, permissions: ['billing:read', 'billing:write'] }, // prettier-ignore
    ]);
    const kinds = (
      Object.keys(LIVE_EVENT_PERMISSION) as LiveEventKind[]
    ).filter((kind) => mayReceive(cashier, { kind, siteId: SITE_A }));
    expect(kinds).toEqual(['billing', 'sri']);
  });

  it('AU-054: el canal pide el permiso de algún tipo, cada uno una vez', () => {
    expect([...LIVE_STREAM_PERMISSIONS].sort()).toEqual([
      'agenda:board:public',
      'agenda:read',
      'billing:read',
      'record:read',
    ]);
  });

  it('AG-182: el aviso de emergencia llega sólo a sus destinatarios, y sin ellos a nadie', () => {
    const doctor = new Principal('01990000-0000-7000-8000-0000000000d1', [
      { roleCode: 'MEDICO', siteId: SITE_A, permissions: ['agenda:read', 'record:read'] }, // prettier-ignore
    ]);
    const colleague = new Principal('01990000-0000-7000-8000-0000000000d2', [
      { roleCode: 'MEDICO', siteId: SITE_A, permissions: ['agenda:read', 'record:read'] }, // prettier-ignore
    ]);
    const addressed: LiveEvent = {
      kind: 'emergency-alerts',
      siteId: SITE_A,
      userIds: [doctor.userId],
    };

    expect(mayReceive(doctor, addressed)).toBe(true);
    expect(mayReceive(colleague, addressed)).toBe(false);
    expect(
      mayReceive(doctor, { kind: 'emergency-alerts', siteId: SITE_A }),
    ).toBe(false);
    // The addressees survive the trip through Redis, and only as uuids.
    expect(parseLiveEvent(JSON.stringify(addressed))).toEqual(addressed);
    expect(
      parseLiveEvent(JSON.stringify({ ...addressed, userIds: ['ana'] })),
    ).toBeNull();
  });
});
