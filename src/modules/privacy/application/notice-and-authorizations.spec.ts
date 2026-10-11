import { describe, expect, it, vi } from 'vitest';

import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  DataSubjectNotFoundError,
  PrivacyAuthorizationAlreadyGrantedError,
  PrivacyAuthorizationAlreadyRevokedError,
  PrivacyAuthorizationInvalidError,
  PrivacyAuthorizationNotFoundError,
  PrivacyNoticeInvalidError,
} from '../domain/privacy.errors';
import type {
  AuthorizationRepository,
  PatientAuthorizationView,
  PrivacyNoticeRepository,
  Requester,
} from '../domain/privacy.repository';

import { AuthorizationService } from './authorization.service';
import { PrivacyNoticeService } from './privacy-notice.service';

const WHO: Requester = { userId: 'u-1' };
const NOW = new Date();

function noticeRepository(
  overrides: Partial<PrivacyNoticeRepository> = {},
): PrivacyNoticeRepository {
  return {
    versions: vi.fn().mockResolvedValue([]),
    publish: vi.fn(),
    ...overrides,
  };
}

function authorizationRepository(
  overrides: Partial<AuthorizationRepository> = {},
): AuthorizationRepository {
  return {
    chartOf: vi.fn().mockResolvedValue({ status: 'active', deceased: false }),
    contactOf: vi.fn().mockResolvedValue({ hasPhone: true, hasEmail: true }),
    grant: vi.fn(),
    revoke: vi.fn(),
    authorizationsOf: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const VIEW: PatientAuthorizationView = {
  id: 'a-1',
  patientId: 'p-1',
  purpose: 'REMINDERS',
  channel: 'WHATSAPP',
  recordedAt: NOW,
  recordedBy: { id: 'u-1', fullName: 'Gabriela Mera' },
  revokedAt: null,
  revokedBy: null,
};

describe('PrivacyNoticeService', () => {
  it('PD-004 rechaza un aviso en blanco o de más de 20 000 caracteres sin llegar al repositorio', async () => {
    const publish = vi.fn();
    const service = new PrivacyNoticeService(noticeRepository({ publish }));

    for (const body of [' \n ', 'x'.repeat(20_001)]) {
      await expect(service.publish(body, WHO)).rejects.toBeInstanceOf(
        PrivacyNoticeInvalidError,
      );
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('PD-001 sin aviso publicado la lista viene vacía, sin error', async () => {
    const service = new PrivacyNoticeService(noticeRepository());
    await expect(service.versions()).resolves.toEqual([]);
  });
});

describe('AuthorizationService', () => {
  it('PD-068 PD-069 registra con el reloj del servidor y quien pregunta', async () => {
    const grant = vi
      .fn()
      .mockResolvedValue({ status: 'granted', authorization: VIEW });
    const service = new AuthorizationService(
      authorizationRepository({ grant }),
    );
    const created = await service.grant(
      { patientId: 'p-1', purpose: 'REMINDERS', channel: 'WHATSAPP' },
      WHO,
      NOW,
    );
    expect(created).toBe(VIEW);
    expect(grant).toHaveBeenCalledWith(
      { patientId: 'p-1', purpose: 'REMINDERS', channel: 'WHATSAPP' },
      WHO,
      NOW,
    );
  });

  it('PD-070 rechaza el canal que no casa o sin el teléfono, sin escribir', async () => {
    const grant = vi.fn();
    const service = new AuthorizationService(
      authorizationRepository({
        grant,
        contactOf: vi
          .fn()
          .mockResolvedValue({ hasPhone: false, hasEmail: true }),
      }),
    );
    for (const attempt of [
      { purpose: 'REMINDERS', channel: 'WHATSAPP' },
      { purpose: 'REMINDERS', channel: null },
      { purpose: 'PHOTOS', channel: 'EMAIL' },
    ] as const) {
      await expect(
        service.grant({ patientId: 'p-1', ...attempt }, WHO, NOW),
      ).rejects.toBeInstanceOf(PrivacyAuthorizationInvalidError);
    }
    expect(grant).not.toHaveBeenCalled();
  });

  it('PD-071 la segunda vigente es PRIVACY_AUTHORIZATION_ALREADY_GRANTED', async () => {
    const service = new AuthorizationService(
      authorizationRepository({
        grant: vi.fn().mockResolvedValue({ status: 'already-granted' }),
      }),
    );
    await expect(
      service.grant(
        { patientId: 'p-1', purpose: 'PHOTOS', channel: null },
        WHO,
        NOW,
      ),
    ).rejects.toBeInstanceOf(PrivacyAuthorizationAlreadyGrantedError);
  });

  it('PD-072 traduce «no existe» y «ya revocada» a sus códigos', async () => {
    for (const [status, error] of [
      ['missing', PrivacyAuthorizationNotFoundError],
      ['already-revoked', PrivacyAuthorizationAlreadyRevokedError],
    ] as const) {
      const service = new AuthorizationService(
        authorizationRepository({
          revoke: vi.fn().mockResolvedValue({ status }),
        }),
      );
      await expect(
        service.revoke('p-1', 'a-1', WHO, NOW),
      ).rejects.toBeInstanceOf(error);
    }
  });

  it('PD-075 no escribe sobre una ficha inexistente ni sobre una absorbida', async () => {
    const grant = vi.fn();
    const revoke = vi.fn();
    const missing = new AuthorizationService(
      authorizationRepository({
        chartOf: vi.fn().mockResolvedValue({ status: 'missing' }),
        grant,
        revoke,
      }),
    );
    await expect(
      missing.grant(
        { patientId: 'p-1', purpose: 'PHOTOS', channel: null },
        WHO,
        NOW,
      ),
    ).rejects.toBeInstanceOf(DataSubjectNotFoundError);
    await expect(missing.authorizationsOf('p-1')).rejects.toBeInstanceOf(
      DataSubjectNotFoundError,
    );

    const merged = new AuthorizationService(
      authorizationRepository({
        chartOf: vi.fn().mockResolvedValue({
          status: 'merged',
          survivingMrn: 'HC0000000002',
        }),
        grant,
        revoke,
      }),
    );
    await expect(merged.revoke('p-1', 'a-1', WHO, NOW)).rejects.toBeInstanceOf(
      PatientMergedError,
    );
    expect(grant).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('PD-073 lista las de la ficha y sus absorbidas tal como las da el repositorio', async () => {
    const authorizationsOf = vi.fn().mockResolvedValue([VIEW]);
    const service = new AuthorizationService(
      authorizationRepository({ authorizationsOf }),
    );
    await expect(service.authorizationsOf('p-1')).resolves.toEqual([VIEW]);
    expect(authorizationsOf).toHaveBeenCalledWith('p-1');
  });
});
