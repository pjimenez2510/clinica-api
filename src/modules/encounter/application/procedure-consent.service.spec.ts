import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import type {
  EncounterRepository,
  EncounterView,
} from '../domain/encounter.repository';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import type {
  ProcedureConsentView,
  RefusalInput,
  RefusalView,
} from '../domain/procedure-consent';
import type { ProcedureConsentRepository } from '../domain/procedure-consent.repository';

import { ProcedureConsentService } from './procedure-consent.service';

const SITE = 'site-1';
const ENCOUNTER = 'encounter-1';
const requester = { userId: 'user-1', sites: [SITE] };
const now = new Date();

function anEncounter(status: EncounterView['status'] = 'OPEN'): EncounterView {
  return { id: ENCOUNTER, siteId: SITE, status } as EncounterView;
}

const refusal: RefusalInput = {
  conceptId: 'concept-1',
  signer: 'NONE',
  representative: null,
  witness: { name: 'Luis Andrade', document: '1710034065' },
};

const recordedRefusal: RefusalView = {
  id: 'refusal-1',
  conceptId: 'concept-1',
  procedureCode: '10120',
  procedureDisplay: 'Biopsia de piel',
  signer: 'NONE',
  representative: null,
  witness: { name: 'Luis Andrade', document: '1710034065' },
  informedBy: { id: 'user-1', name: 'Ana Villacís' },
  refusedAt: now,
  recordedBy: { id: 'user-1', name: 'Ana Villacís' },
};

const revoked: ProcedureConsentView = {
  id: 'consent-1',
  kind: 'SIGNED',
  signer: 'PATIENT',
  representative: null,
  exceptionKind: null,
  exceptionReason: null,
  informedBy: { id: 'user-1', name: 'Ana Villacís' },
  signedAt: now,
  recordedAt: now,
  recordedBy: { id: 'user-1', name: 'Ana Villacís' },
  revocation: {
    signer: 'PATIENT',
    representative: null,
    revokedAt: now,
    revokedBy: { id: 'user-1', name: 'Ana Villacís' },
  },
};

describe('ProcedureConsentService (EN-152 a EN-154)', () => {
  let stored: EncounterView | null;
  let consents: {
    requiresWrittenConsent: ReturnType<typeof vi.fn>;
    addRefusal: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };
  let audit: AccessAuditEntry[];
  let service: ProcedureConsentService;

  beforeEach(() => {
    stored = anEncounter();
    consents = {
      requiresWrittenConsent: vi.fn().mockResolvedValue(true),
      addRefusal: vi.fn().mockResolvedValue(recordedRefusal),
      revoke: vi.fn().mockResolvedValue(revoked),
    };
    audit = [];
    const encounters = {
      findById: ({
        encounterId,
        sites,
      }: {
        encounterId: string;
        sites: string[] | 'all';
      }) =>
        // prettier-ignore
        Promise.resolve(
          stored !== null &&
            encounterId === stored.id &&
            (sites === 'all' || sites.includes(stored.siteId))
            ? stored
            : null,
        ),
    };
    const logger = {
      setContext: vi.fn(),
      info: vi.fn(),
    } as unknown as PinoLogger;
    service = new ProcedureConsentService(
      consents as unknown as ProcedureConsentRepository,
      encounters as unknown as EncounterRepository,
      {
        record: (entry: AccessAuditEntry) => {
          audit.push(entry);
          return Promise.resolve();
        },
      },
      logger,
    );
  });

  it('EN-152 contesta si el concepto exige el 024, dentro del alcance de quien pregunta', async () => {
    await expect(service.requirement(ENCOUNTER, 'concept-1', requester)).resolves.toEqual({ required: true }); // prettier-ignore
    expect(consents.requiresWrittenConsent).toHaveBeenCalledWith('concept-1');

    await expect(
      service.requirement(ENCOUNTER, 'concept-1', { userId: 'user-1', sites: ['site-otra'] }), // prettier-ignore
    ).rejects.toBeInstanceOf(EncounterNotFoundError);
  });

  it('EN-153 registra la negativa con quien la registra y deja su fila en la bitácora; la atención no cambia', async () => {
    await expect(service.recordRefusal(ENCOUNTER, refusal, requester)).resolves.toBe(recordedRefusal); // prettier-ignore

    expect(consents.addRefusal).toHaveBeenCalledWith({
      encounterId: ENCOUNTER,
      refusal,
      recordedById: 'user-1',
      sites: [SITE],
    });
    expect(audit).toEqual([
      expect.objectContaining({ resourceType: 'procedure_consent', resourceId: 'refusal-1', action: 'CREATE' }), // prettier-ignore
    ]);
    expect(stored?.status).toBe('OPEN');
  });

  it('EN-153 EN-154 la negativa y la revocación sólo en una atención viva', async () => {
    stored = anEncounter('DISCHARGED');
    await expect(service.recordRefusal(ENCOUNTER, refusal, requester)).rejects.toBeInstanceOf(EncounterAlreadyClosedError); // prettier-ignore
    await expect(
      service.revoke(ENCOUNTER, 'consent-1', { signer: 'PATIENT', representative: null }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(EncounterAlreadyClosedError);
    expect(consents.addRefusal).not.toHaveBeenCalled();
    expect(consents.revoke).not.toHaveBeenCalled();

    // Control positivo: suspendida, sí.
    stored = anEncounter('ON_HOLD');
    await expect(service.recordRefusal(ENCOUNTER, refusal, requester)).resolves.toBe(recordedRefusal); // prettier-ignore
  });

  it('EN-154 revoca con quien la recibe y la deja en la bitácora como cambio, no como borrado', async () => {
    await expect(
      service.revoke(ENCOUNTER, 'consent-1', { signer: 'PATIENT', representative: null }, requester), // prettier-ignore
    ).resolves.toBe(revoked);
    expect(consents.revoke).toHaveBeenCalledWith({
      encounterId: ENCOUNTER,
      consentId: 'consent-1',
      revocation: { signer: 'PATIENT', representative: null },
      revokedById: 'user-1',
      sites: [SITE],
    });
    expect(audit[0]).toMatchObject({
      resourceId: 'consent-1',
      action: 'UPDATE',
    });
  });
});
