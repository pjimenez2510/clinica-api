import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';
import { IESS_NOT_APPLICABLE_NOTICE } from '../domain/certificate';
import {
  CertificateAlreadyRevokedError,
  CertificateEncounterNotFoundError,
} from '../domain/certificate.errors';
import type {
  CertificatePlan,
  CertificateQuery,
  CertificateRepository,
  CertificateView,
  CertifierIdentity,
  EncounterCertificatesQuery,
  IssueSnapshot,
  RevocationPlan,
} from '../domain/certificate.repository';

import { CertificateService } from './certificate.service';
import type { IssueCertificateRequest, Requester } from './certificate.service';

/**
 * The certificate's use cases, against an in-memory port.
 *
 * WHAT A DOUBLE CAN PROVE HERE is what is NOT a database guarantee: the order
 * of the refusals, that the issuer is the session and never the request, which
 * acts leave a row in the access trail, and what the response of a rest
 * certificate carries. The number, the `CHECK`s and the scope are PostgreSQL's
 * and live in `test/integration/certificate-*.spec.ts`.
 */

const SITE = 'site-1';
const ENCOUNTER = 'encounter-1';
const PATIENT = 'patient-1';
const USER = 'user-1';
const PRACTITIONER = 'practitioner-1';

/** One instant for the whole file; every date is derived from it. */
const NOW = new Date();
const today: ClinicalDate = clinicalDateOf(NOW);

const requester: Requester = {
  userId: USER,
  sites: [SITE],
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const aView = (overrides: Partial<CertificateView> = {}): CertificateView => ({
  id: 'certificate-1',
  encounterId: ENCOUNTER,
  patientId: PATIENT,
  issuedById: PRACTITIONER,
  type: 'ATTENDANCE',
  number: 1,
  verificationCode: 'ABCDEF0123456789',
  issuedAt: NOW,
  restFrom: null,
  restTo: null,
  includeDiagnosis: false,
  revokedAt: null,
  revokedById: null,
  revocationReason: null,
  ...overrides,
});

class FakeRepository implements CertificateRepository {
  certifier: CertifierIdentity | null = { practitionerId: PRACTITIONER };
  snapshot: IssueSnapshot = { encounterStatus: 'OPEN', diagnosisCount: 1 };
  encounterFound = true;
  stored: CertificateView | null = aView();
  alreadyRevoked = false;
  issued: { query: EncounterCertificatesQuery; plan: CertificatePlan }[] = [];
  revoked: { query: CertificateQuery; plan: RevocationPlan }[] = [];
  asked: CertificateQuery[] = [];

  findCertifierByUser(): Promise<CertifierIdentity | null> {
    return Promise.resolve(this.certifier);
  }

  encounterExists(): Promise<boolean> {
    return Promise.resolve(this.encounterFound);
  }

  issue(
    query: EncounterCertificatesQuery,
    decide: (snapshot: IssueSnapshot) => CertificatePlan,
  ): Promise<CertificateView> {
    if (!this.encounterFound) throw new CertificateEncounterNotFoundError();
    const plan = decide(this.snapshot);
    this.issued.push({ query, plan });
    return Promise.resolve(
      aView({
        type: plan.type,
        issuedById: plan.issuedById,
        issuedAt: plan.issuedAt,
        verificationCode: plan.verificationCode,
        restFrom: plan.rest?.from ?? null,
        restTo: plan.rest?.to ?? null,
        includeDiagnosis: plan.includeDiagnosis,
      }),
    );
  }

  listOfEncounter(): Promise<CertificateView[]> {
    return Promise.resolve([aView(), aView({ id: 'certificate-2' })]);
  }

  revoke(
    query: CertificateQuery,
    plan: RevocationPlan,
  ): Promise<CertificateView> {
    if (this.alreadyRevoked) throw new CertificateAlreadyRevokedError();
    this.revoked.push({ query, plan });
    return Promise.resolve(
      aView({
        revokedAt: plan.revokedAt,
        revokedById: plan.revokedById,
        revocationReason: plan.reason,
      }),
    );
  }

  findById(query: CertificateQuery): Promise<CertificateView | null> {
    this.asked.push(query);
    return Promise.resolve(this.stored);
  }
}

const attendance = (
  overrides: Partial<IssueCertificateRequest> = {},
): IssueCertificateRequest => ({
  encounterId: ENCOUNTER,
  type: 'ATTENDANCE',
  restFrom: null,
  restTo: null,
  includeDiagnosis: false,
  ...overrides,
});

const rest = (days: number, overrides: Partial<IssueCertificateRequest> = {}) =>
  attendance({
    type: 'MEDICAL_REST',
    restFrom: today,
    restTo: addDays(today, days - 1),
    ...overrides,
  });

describe('el servicio de certificados', () => {
  let repository: FakeRepository;
  let entries: AccessAuditEntry[];
  let logged: unknown[][];
  let service: CertificateService;

  beforeEach(() => {
    repository = new FakeRepository();
    entries = [];
    logged = [];
    const audit: AccessAuditRecorder = {
      record: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    };
    const logger = {
      setContext: vi.fn(),
      info: (...args: unknown[]) => logged.push(args),
    } as unknown as PinoLogger;
    service = new CertificateService(repository, audit, logger);
  });

  it('CER-001 registra el certificado con la atencion, el profesional de la sesion, el tipo y el instante', async () => {
    const before = Date.now();
    const issued = await service.issue(attendance(), requester);

    expect(repository.issued).toHaveLength(1);
    const [{ query, plan }] = repository.issued as [
      (typeof repository.issued)[number],
    ];
    expect(query).toEqual({ encounterId: ENCOUNTER, sites: [SITE] });
    expect(plan.type).toBe('ATTENDANCE');
    expect(plan.issuedById).toBe(PRACTITIONER);
    expect(plan.issuedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(plan.verificationCode).toMatch(/^[0-9A-F]{16}$/);
    expect(issued.certificate.patientId).toBe(PATIENT);
  });

  it('CER-002 rechaza emitir sobre una atencion que no existe o es de otra sede', async () => {
    repository.encounterFound = false;

    await expect(service.issue(attendance(), requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_ENCOUNTER_NOT_FOUND',
    });
    expect(entries).toEqual([]);
  });

  it('CER-003 rechaza emitir sobre una atencion cerrada, y la dada de alta lo admite', async () => {
    repository.snapshot = { encounterStatus: 'COMPLETED', diagnosisCount: 1 };
    await expect(service.issue(attendance(), requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_ENCOUNTER_NOT_OPEN',
    });
    expect(repository.issued).toHaveLength(0);

    // Control positivo por el mismo camino.
    repository.snapshot = { encounterStatus: 'DISCHARGED', diagnosisCount: 1 };
    await expect(service.issue(attendance(), requester)).resolves.toBeDefined();
  });

  it('CER-004 rechaza a una cuenta sin ficha profesional activa antes de escribir nada', async () => {
    repository.certifier = null;

    await expect(service.issue(attendance(), requester)).rejects.toMatchObject({
      code: 'CERTIFIER_PROFILE_REQUIRED',
    });
    expect(repository.issued).toHaveLength(0);
  });

  it('CER-005 rechaza un certificado de aptitud o de discapacidad sin escribir nada', async () => {
    for (const type of ['FITNESS', 'DISABILITY_SUPPORT'] as const) {
      await expect(
        service.issue(attendance({ type }), requester),
      ).rejects.toMatchObject({ code: 'CERTIFICATE_TYPE_NOT_SUPPORTED' });
    }
    expect(repository.issued).toHaveLength(0);
  });

  it('CER-006 rechaza un reposo sin fin, nombrando el campo, sin escribir nada', async () => {
    await expect(
      service.issue(rest(3, { restTo: null }), requester),
    ).rejects.toMatchObject({
      code: 'CERTIFICATE_REST_PERIOD_INVALID',
      fieldErrors: [expect.objectContaining({ field: 'restTo' })],
    });
    expect(repository.issued).toHaveLength(0);
  });

  it('CER-007 guarda lo que el medico contesto sobre el diagnostico, sin suponer nada', async () => {
    await service.issue(attendance({ includeDiagnosis: true }), requester);
    await service.issue(attendance({ includeDiagnosis: false }), requester);

    expect(repository.issued.map(({ plan }) => plan.includeDiagnosis)).toEqual([
      true,
      false,
    ]);
  });

  it('CER-008 rechaza incluir el diagnostico cuando la atencion no tiene ninguno', async () => {
    repository.snapshot = { encounterStatus: 'OPEN', diagnosisCount: 0 };

    await expect(
      service.issue(attendance({ includeDiagnosis: true }), requester),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_DIAGNOSIS_REQUIRED' });

    // Control positivo: sin pedirlo, la misma atención sin diagnóstico admite
    // el certificado.
    await expect(
      service.issue(attendance({ includeDiagnosis: false }), requester),
    ).resolves.toBeDefined();
  });

  it('CER-010 lee un certificado dentro del alcance de quien pregunta', async () => {
    const found = await service.findOne('certificate-1', requester);

    expect(found.id).toBe('certificate-1');
    expect(repository.asked).toEqual([
      { certificateId: 'certificate-1', sites: [SITE] },
    ]);
  });

  it('CER-010 responde CERTIFICATE_NOT_FOUND si no existe o es de otra sede', async () => {
    repository.stored = null;

    await expect(
      service.findOne('certificate-1', requester),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_NOT_FOUND' });
    expect(entries).toEqual([]);
  });

  it('CER-010 rechaza listar los certificados de una atencion fuera del alcance', async () => {
    repository.encounterFound = false;

    await expect(
      service.listOfEncounter(ENCOUNTER, requester),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_ENCOUNTER_NOT_FOUND' });
  });

  it('CER-011 anula con el motivo, la cuenta de la sesion y el instante', async () => {
    const before = Date.now();
    const revoked = await service.revoke(
      'certificate-1',
      'Se emitió con el tipo equivocado',
      requester,
    );

    const [{ query, plan }] = repository.revoked as [
      (typeof repository.revoked)[number],
    ];
    expect(query).toEqual({ certificateId: 'certificate-1', sites: [SITE] });
    expect(plan.revokedById).toBe(USER);
    expect(plan.reason).toBe('Se emitió con el tipo equivocado');
    expect(plan.revokedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(revoked.revocationReason).toBe('Se emitió con el tipo equivocado');
  });

  it('CER-012 deja pasar la negativa de un certificado ya anulado sin auditar una anulacion que no ocurrio', async () => {
    repository.alreadyRevoked = true;

    await expect(
      service.revoke('certificate-1', 'Otra vez', requester),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_ALREADY_REVOKED' });
    expect(entries).toEqual([]);
  });

  it('CER-013 la respuesta de un reposo lleva el ultimo dia de validacion en el IESS y el aviso', async () => {
    const issued = await service.issue(rest(3), requester);

    expect(issued.iess).toEqual({
      lastValidationDay: addDays(addDays(today, 2), 8),
      notice: IESS_NOT_APPLICABLE_NOTICE,
    });
  });

  it('CER-013 un certificado de asistencia no lleva nada del IESS', async () => {
    const issued = await service.issue(attendance(), requester);
    expect(issued.iess).toBeNull();
  });

  it('CER-014 lo que se registra en el log es el acto, sin datos del paciente', async () => {
    await service.issue(rest(3, { includeDiagnosis: true }), requester);
    await service.revoke('certificate-1', 'Motivo con texto libre', requester);

    expect(logged.length).toBeGreaterThan(0);
    for (const [payload, message] of logged) {
      // Sólo claves de una lista blanca, y ningún texto interpolado.
      expect(Object.keys(payload as object).sort()).toEqual(['action']);
      expect(typeof message).toBe('string');
      expect(JSON.stringify([payload, message])).not.toMatch(
        /patient|Motivo|\d{4}-\d{2}-\d{2}/,
      );
    }
  });

  it('CER-016 deja una fila de bitacora al emitir, al leer, al listar y al anular', async () => {
    const issued = await service.issue(attendance(), requester);
    await service.findOne(issued.certificate.id, requester);
    await service.listOfEncounter(ENCOUNTER, requester);
    await service.revoke(issued.certificate.id, 'Motivo', requester);

    expect(
      entries.map(({ resourceType, resourceId, action, userId }) => ({
        resourceType,
        resourceId,
        action,
        userId,
      })),
    ).toEqual([
      { resourceType: 'certificate', resourceId: 'certificate-1', action: 'CREATE', userId: USER }, // prettier-ignore
      { resourceType: 'certificate', resourceId: 'certificate-1', action: 'READ', userId: USER }, // prettier-ignore
      { resourceType: 'certificate', resourceId: 'certificate-1', action: 'READ', userId: USER }, // prettier-ignore
      { resourceType: 'certificate', resourceId: 'certificate-2', action: 'READ', userId: USER }, // prettier-ignore
      { resourceType: 'certificate', resourceId: 'certificate-1', action: 'UPDATE', userId: USER }, // prettier-ignore
    ]);
    expect(entries.every((entry) => entry.ip === '10.0.0.9')).toBe(true);
  });

  it('CER-016 una emision rechazada no deja fila de bitacora', async () => {
    repository.snapshot = { encounterStatus: 'COMPLETED', diagnosisCount: 1 };
    await expect(service.issue(attendance(), requester)).rejects.toThrow();
    expect(entries).toEqual([]);
  });
});
