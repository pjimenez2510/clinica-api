import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  addDays,
  atWallClock,
  clinicalDateOf,
  WallClockTime,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';
import {
  IESS_NOT_APPLICABLE_NOTICE,
  longRestNotice,
  MATERNITY_CHAIN_NOTICE,
} from '../domain/certificate';
import {
  CertificateAlreadyRevokedError,
  CertificateEncounterNotFoundError,
} from '../domain/certificate.errors';
import type { Form117Source } from '../../../shared/domain/form-117/form-117';
import type {
  CertificatePlan,
  CertificateQuery,
  CertificateRepository,
  CertificateView,
  CertifierIdentity,
  EncounterCertificatesQuery,
  IssueSnapshot,
  RevocationPlan,
  RevocationSnapshot,
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
  contingencyType: null,
  maternity: null,
  backdatingReason: null,
  issuedByOtherReason: null,
  revokedAt: null,
  revokedById: null,
  revocationReason: null,
  ...overrides,
});

/** What storage answers for the form 117 of `view`. */
const aSource = (view: CertificateView): Form117Source => ({
  certificate: view,
  site: {
    name: 'Clínica Central',
    mspUnicode: '000123',
    city: 'Quito',
    address: null,
    phone: null,
  },
  patient: {
    familyName: 'Guamán',
    secondFamilyName: null,
    givenName: 'María',
    secondGivenName: null,
    sex: 'FEMALE',
    mrn: 'HC000042',
    employerName: 'Florícola del Valle',
    jobTitle: 'Supervisora de cultivo',
    residenceAddressLine: 'Calle Sucre 4-12',
    phone: '0991234567',
    identifiers: [],
  },
  encounter: {
    startedAt: NOW,
    endedAt: null,
    ageYears: 34,
    ageMonths: 0,
    ageDays: 0,
  },
  diagnoses: [],
  practitioner: {
    givenNames: 'Ana',
    familyNames: 'Villacís',
    cedula: null,
    primarySpecialty: null,
    hasSeal: false,
  },
});

/** What the issue reads inside its transaction, overridable. */
const aSnapshot = (overrides: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
  encounterStatus: 'OPEN',
  attendingPractitionerId: PRACTITIONER,
  diagnosisCodes: ['J02'],
  encounterStartedAt: NOW,
  cityOfIssue: 'Quito',
  patientRests: [],
  patientWork: {
    employerName: 'Florícola del Valle',
    jobTitle: 'Supervisora de cultivo',
    residenceAddressLine: 'Calle Sucre 4-12',
    phone: '0991234567',
  },
  ...overrides,
});

class FakeRepository implements CertificateRepository {
  certifier: CertifierIdentity | null = {
    practitionerId: PRACTITIONER,
    primarySpecialtyCode: null,
  };
  snapshot: IssueSnapshot = aSnapshot({
    encounterStatus: 'OPEN',
    diagnosisCodes: ['J02'],
  });
  encounterFound = true;
  stored: Form117Source | null = aSource(aView());
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
        contingencyType: plan.contingencyType,
        maternity: plan.maternity,
        backdatingReason: plan.backdatingReason,
        issuedByOtherReason: plan.issuedByOtherReason,
      }),
    );
  }

  listOfEncounter(): Promise<CertificateView[]> {
    return Promise.resolve([aView(), aView({ id: 'certificate-2' })]);
  }

  /** CER-040. Who issued the stored certificate, and where. */
  revocationSnapshot: RevocationSnapshot = { issuerUserId: USER, siteId: SITE };

  revoke(
    query: CertificateQuery,
    plan: RevocationPlan,
    authorise: (snapshot: RevocationSnapshot) => void,
  ): Promise<CertificateView> {
    authorise(this.revocationSnapshot);
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

  form117SourceOf(query: CertificateQuery): Promise<Form117Source | null> {
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
  contingencyType: null,
  maternityAdmissionOn: null,
  birthOn: null,
  maternityDischargeOn: null,
  backdatingReason: null,
  issuedByOtherReason: null,
  ...overrides,
});

const rest = (days: number, overrides: Partial<IssueCertificateRequest> = {}) =>
  attendance({
    type: 'MEDICAL_REST',
    restFrom: today,
    restTo: addDays(today, days - 1),
    includeDiagnosis: true,
    contingencyType: 'GENERAL_ILLNESS',
    ...overrides,
  });

describe('el servicio de certificados', () => {
  let repository: FakeRepository;
  let entries: AccessAuditEntry[];
  let logged: unknown[][];
  let service: CertificateService;
  /** What the injected clock answers; `NOW` unless a test moves it. */
  let clockReads: Date;

  beforeEach(() => {
    clockReads = NOW;
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
    service = new CertificateService(repository, audit, logger, () => clockReads); // prettier-ignore
  });

  it('CER-001 registra el certificado con la atencion, el profesional de la sesion, el tipo y el instante', async () => {
    const issued = await service.issue(attendance(), requester);

    expect(repository.issued).toHaveLength(1);
    const [{ query, plan }] = repository.issued as [
      (typeof repository.issued)[number],
    ];
    expect(query).toEqual({ encounterId: ENCOUNTER, sites: [SITE] });
    expect(plan.type).toBe('ATTENDANCE');
    expect(plan.issuedById).toBe(PRACTITIONER);
    // CER-030, CER-041. The instant is the clock's, never read in the service.
    expect(plan.issuedAt).toBe(NOW);
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
    repository.snapshot = aSnapshot({
      encounterStatus: 'COMPLETED',
      diagnosisCodes: ['J02'],
    });
    await expect(service.issue(attendance(), requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_ENCOUNTER_NOT_OPEN',
    });
    expect(repository.issued).toHaveLength(0);

    // Control positivo por el mismo camino.
    repository.snapshot = aSnapshot({
      encounterStatus: 'DISCHARGED',
      diagnosisCodes: ['J02'],
    });
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
    repository.snapshot = aSnapshot({
      encounterStatus: 'OPEN',
      diagnosisCodes: [],
    });

    await expect(
      service.issue(attendance({ includeDiagnosis: true }), requester),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_DIAGNOSIS_REQUIRED' });

    // Control positivo: sin pedirlo, la misma atención sin diagnóstico admite
    // el certificado.
    await expect(
      service.issue(attendance({ includeDiagnosis: false }), requester),
    ).resolves.toBeDefined();
  });

  it('CER-010 y CER-020 lee el formulario 117 de un certificado dentro del alcance de quien pregunta', async () => {
    const found = await service.form117('certificate-1', requester);

    expect(found.id).toBe('certificate-1');
    expect(found.establishment.mspUnicode).toBe('000123');
    expect(repository.asked).toEqual([
      { certificateId: 'certificate-1', sites: [SITE] },
    ]);
  });

  it('CER-010 responde CERTIFICATE_NOT_FOUND si no existe o es de otra sede', async () => {
    repository.stored = null;

    await expect(
      service.form117('certificate-1', requester),
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
    const revoked = await service.revoke(
      'certificate-1',
      'Se emitió con el tipo equivocado',
      requester,
      [],
    );

    const [{ query, plan }] = repository.revoked as [
      (typeof repository.revoked)[number],
    ];
    expect(query).toEqual({ certificateId: 'certificate-1', sites: [SITE] });
    expect(plan.revokedById).toBe(USER);
    expect(plan.reason).toBe('Se emitió con el tipo equivocado');
    expect(plan.revokedAt).toBe(NOW);
    expect(revoked.revocationReason).toBe('Se emitió con el tipo equivocado');
  });

  it('CER-012 deja pasar la negativa de un certificado ya anulado sin auditar una anulacion que no ocurrio', async () => {
    repository.alreadyRevoked = true;

    await expect(
      service.revoke('certificate-1', 'Otra vez', requester, []),
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

  it('CER-007 un reposo que dice no llevar diagnostico se rechaza en ese campo; lleva siempre el diagnostico', async () => {
    await expect(
      service.issue(rest(3, { includeDiagnosis: false }), requester),
    ).rejects.toMatchObject({
      code: 'CERTIFICATE_REST_PERIOD_INVALID',
      fieldErrors: [expect.objectContaining({ field: 'includeDiagnosis' })],
    });
    expect(repository.issued).toHaveLength(0);

    await service.issue(rest(3), requester);
    expect(repository.issued[0]?.plan.includeDiagnosis).toBe(true);
  });

  it('CER-008 un reposo exige un diagnostico registrado en la atencion', async () => {
    repository.snapshot = aSnapshot({ diagnosisCodes: [] });
    await expect(service.issue(rest(3), requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_DIAGNOSIS_REQUIRED',
    });
  });

  it('CER-030 un reposo que empieza antes del dia clinico de la atencion exige motivo, y lo guarda', async () => {
    const backdated = rest(3, {
      restFrom: addDays(today, -2),
      restTo: today,
    });
    await expect(service.issue(backdated, requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_BACKDATING_REASON_REQUIRED',
    });
    expect(repository.issued).toHaveLength(0);

    await service.issue(
      { ...backdated, backdatingReason: 'Acudió dos días tarde por la fiebre' },
      requester,
    );
    expect(repository.issued[0]?.plan.backdatingReason).toBe(
      'Acudió dos días tarde por la fiebre',
    );
  });

  it('CER-030 el dia clinico es el de Guayaquil: una atencion a las 21:00 no adelanta el dia', async () => {
    // 21:00 en Guayaquil del día anterior a «today» es 02:00 UTC de «today».
    repository.snapshot = aSnapshot({
      encounterStartedAt: atWallClock(
        addDays(today, -1),
        WallClockTime.of(21, 0),
      ),
    });
    // Y se emite a las 23:00 de ese mismo día en Ecuador, 04:00 UTC del
    // siguiente: ni retroactivo ni tardío (D-105 §3).
    clockReads = atWallClock(addDays(today, -1), WallClockTime.of(23, 0));
    // El reposo empieza el día de la atención en Ecuador: no es retroactivo.
    await expect(
      service.issue(
        rest(1, { restFrom: addDays(today, -1), restTo: addDays(today, -1) }),
        requester,
      ),
    ).resolves.toBeDefined();
  });

  it('CER-031 rechaza un reposo de 31 dias sin escribir nada', async () => {
    await expect(service.issue(rest(31), requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_REST_TOO_LONG',
    });
    expect(repository.issued).toHaveLength(0);
  });

  it('CER-032 la respuesta lleva un solo aviso cuando el reposo supera el umbral de la especialidad del emisor', async () => {
    // Sin especialidad: umbral de 3 días.
    expect((await service.issue(rest(3), requester)).restNotices).toEqual([]);
    expect((await service.issue(rest(4), requester)).restNotices).toEqual([
      longRestNotice(4),
    ]);
    // Especialista: umbral de 7 días.
    repository.certifier = {
      practitionerId: PRACTITIONER,
      primarySpecialtyCode: 'pediatria',
    };
    expect((await service.issue(rest(7), requester)).restNotices).toEqual([]);
    expect((await service.issue(rest(8), requester)).restNotices).toEqual([
      longRestNotice(8),
    ]);
    expect((await service.issue(attendance(), requester)).restNotices).toEqual(
      [],
    );
  });

  it('CER-034 y CER-035 guarda la contingencia y las fechas de la maternidad', async () => {
    // CER-049: la maternidad lleva un diagnóstico obstétrico.
    repository.snapshot = aSnapshot({ diagnosisCodes: ['O80'] });
    await service.issue(
      rest(30, {
        contingencyType: 'MATERNITY',
        maternityAdmissionOn: addDays(today, -1),
        birthOn: today,
        maternityDischargeOn: addDays(today, 2),
      }),
      requester,
    );
    expect(repository.issued[0]?.plan).toMatchObject({
      contingencyType: 'MATERNITY',
      maternity: {
        admissionOn: addDays(today, -1),
        birthOn: today,
        dischargeOn: addDays(today, 2),
      },
    });
  });

  it('CER-036 rechaza emitir si la sede no tiene parroquia, y no escribe nada', async () => {
    repository.snapshot = aSnapshot({ cityOfIssue: null });
    await expect(service.issue(attendance(), requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_ESTABLISHMENT_INCOMPLETE',
    });
    expect(repository.issued).toHaveLength(0);
  });

  it('CER-038 un reposo sin empresa, puesto o telefono en la ficha se emite, con el aviso que nombra lo que falta', async () => {
    repository.snapshot = aSnapshot({
      patientWork: {
        employerName: null,
        jobTitle: '  ',
        residenceAddressLine: 'Calle Sucre 4-12',
        phone: null,
      },
    });

    const issued = await service.issue(rest(3), requester);

    expect(repository.issued).toHaveLength(1);
    expect(issued.restNotices).toEqual([
      'Falta en la ficha la empresa, el puesto de trabajo y el teléfono del paciente. El IESS puede devolver el reposo sin estos datos; complételos en la ficha.',
    ]);
  });

  it('CER-038 control: con la ficha completa no hay aviso, y la asistencia nunca lo lleva', async () => {
    expect((await service.issue(rest(3), requester)).restNotices).toEqual([]);

    repository.snapshot = aSnapshot({
      patientWork: {
        employerName: null,
        jobTitle: null,
        residenceAddressLine: null,
        phone: null,
      },
    });
    expect((await service.issue(attendance(), requester)).restNotices).toEqual(
      [],
    );
  });

  it('CER-014 lo que se registra en el log es el acto, sin datos del paciente', async () => {
    await service.issue(rest(3, { includeDiagnosis: true }), requester);
    await service.revoke(
      'certificate-1',
      'Motivo con texto libre',
      requester,
      [],
    );

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
    await service.form117(issued.certificate.id, requester);
    await service.listOfEncounter(ENCOUNTER, requester);
    await service.revoke(issued.certificate.id, 'Motivo', requester, []);

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
    repository.snapshot = aSnapshot({
      encounterStatus: 'COMPLETED',
      diagnosisCodes: ['J02'],
    });
    await expect(service.issue(attendance(), requester)).rejects.toThrow();
    expect(entries).toEqual([]);
  });
  it('CER-039 sobre la atención de otro profesional exige motivo y lo guarda; quien atendió no guarda ninguno', async () => {
    repository.snapshot = aSnapshot({ attendingPractitionerId: 'practitioner-who-attended' }); // prettier-ignore

    await expect(service.issue(attendance(), requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_ISSUER_REASON_REQUIRED',
    });
    expect(repository.issued).toHaveLength(0);
    expect(entries).toEqual([]);

    const issued = await service.issue(
      attendance({ issuedByOtherReason: 'Cubre el turno de la doctora que atendió' }), // prettier-ignore
      requester,
    );
    expect(issued.certificate.issuedByOtherReason).toBe(
      'Cubre el turno de la doctora que atendió',
    );

    // Control positivo: quien atendió no deja motivo aunque lo mande.
    repository.snapshot = aSnapshot();
    const own = await service.issue(
      attendance({ issuedByOtherReason: 'Un motivo que sobra' }),
      requester,
    );
    expect(own.certificate.issuedByOtherReason).toBeNull();
  });

  it('CER-041 un reposo que empieza en 90 días se rechaza antes de tocar la base, nombrando restFrom', async () => {
    await expect(
      service.issue(
        rest(3, { restFrom: addDays(today, 90), restTo: addDays(today, 92) }),
        requester,
      ),
    ).rejects.toMatchObject({
      code: 'CERTIFICATE_REST_START_TOO_LATE',
      fieldErrors: [expect.objectContaining({ field: 'restFrom' })],
    });
    expect(repository.issued).toHaveLength(0);

    // Control positivo: desde mañana.
    await expect(
      service.issue(
        rest(1, { restFrom: addDays(today, 1), restTo: addDays(today, 1) }),
        requester,
      ),
    ).resolves.toBeDefined();
  });

  it('CER-030 emitido dos días después de la atención pide motivo aunque el reposo empiece ese día', async () => {
    const attentionDay = addDays(today, -2);
    repository.snapshot = aSnapshot({
      encounterStartedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
    });
    const late = rest(3, { restFrom: attentionDay, restTo: today });

    await expect(service.issue(late, requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_BACKDATING_REASON_REQUIRED',
    });

    const issued = await service.issue(
      {
        ...late,
        backdatingReason: 'Volvió por el certificado dos días después',
      },
      requester,
    );
    expect(issued.certificate.backdatingReason).toBe(
      'Volvió por el certificado dos días después',
    );
  });

  it('CER-043 un reposo de maternidad avisa de confirmar con el IESS, sin impedir la emisión', async () => {
    // CER-049: la maternidad lleva un diagnóstico obstétrico.
    repository.snapshot = aSnapshot({ diagnosisCodes: ['O80'] });
    const issued = await service.issue(
      rest(28, {
        contingencyType: 'MATERNITY',
        maternityAdmissionOn: today,
        birthOn: today,
        maternityDischargeOn: today,
      }),
      requester,
    );

    expect(issued.restNotices).toContain(MATERNITY_CHAIN_NOTICE);
  });
  it('CER-040 anula quien lo emitió; otro médico sin el permiso de dirección médica recibe 403 y nada se escribe', async () => {
    // Control positivo: la cuenta que lo emitió.
    await expect(
      service.revoke('certificate-1', 'Tipo equivocado', requester, []),
    ).resolves.toBeDefined();

    repository.revocationSnapshot = { issuerUserId: 'user-who-issued', siteId: SITE }; // prettier-ignore
    repository.revoked = [];
    entries.length = 0;
    await expect(
      service.revoke('certificate-1', 'Tipo equivocado', requester, []),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_REVOKE_FORBIDDEN' });
    expect(repository.revoked).toEqual([]);
    expect(entries).toEqual([]);
  });

  it('CER-040 la dirección médica anula el de otro en su sede, y no en otra', async () => {
    repository.revocationSnapshot = { issuerUserId: 'user-who-issued', siteId: SITE }; // prettier-ignore

    await expect(
      service.revoke('certificate-1', 'Emitido a la persona equivocada', requester, ['another-site']), // prettier-ignore
    ).rejects.toMatchObject({ code: 'CERTIFICATE_REVOKE_FORBIDDEN' });
    await expect(
      service.revoke('certificate-1', 'Emitido a la persona equivocada', requester, [SITE]), // prettier-ignore
    ).resolves.toBeDefined();
    await expect(
      service.revoke('certificate-1', 'Emitido a la persona equivocada', requester, 'all'), // prettier-ignore
    ).resolves.toBeDefined();
  });
  it('CER-044 CER-045 el reposo empieza como mucho 3 días antes y se emite hasta el octavo día de la atención (D-106)', async () => {
    await expect(
      service.issue(
        rest(5, { restFrom: addDays(today, -4), restTo: today, backdatingReason: 'Fiebre desde hace cuatro días' }), // prettier-ignore
        requester,
      ),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_REST_START_TOO_EARLY' });

    // Mediodía en Ecuador: la madrugada (D-106 §5) no corre ningún día.
    clockReads = atWallClock(today, WallClockTime.of(12, 0));
    repository.snapshot = aSnapshot({
      encounterStartedAt: atWallClock(
        addDays(today, -9),
        WallClockTime.of(12, 0),
      ),
    });
    await expect(
      service.issue(rest(1, { backdatingReason: 'Volvió nueve días después' }), requester), // prettier-ignore
    ).rejects.toMatchObject({ code: 'CERTIFICATE_REST_ISSUED_TOO_LATE' });
    expect(repository.issued).toHaveLength(0);

    // Control positivo: el octavo día, con su motivo.
    repository.snapshot = aSnapshot({
      encounterStartedAt: atWallClock(
        addDays(today, -8),
        WallClockTime.of(12, 0),
      ),
    });
    await expect(
      service.issue(rest(1, { backdatingReason: 'Volvió ocho días después' }), requester), // prettier-ignore
    ).resolves.toBeDefined();
  });

  it('CER-044 CER-045 el reposo de maternidad empieza desde el parto y se emite pasados 8 días; la enfermedad general igual se rechaza (D-108)', async () => {
    repository.snapshot = aSnapshot({ diagnosisCodes: ['O80'] });
    const birth = addDays(today, -5);
    const maternity = {
      contingencyType: 'MATERNITY' as const,
      maternityAdmissionOn: addDays(birth, -1),
      birthOn: birth,
      maternityDischargeOn: addDays(birth, 2),
    };
    const fromBirth = { restFrom: birth, restTo: today, backdatingReason: 'Dio a luz en el hospital hace cinco días' }; // prettier-ignore
    await expect(
      service.issue(rest(1, fromBirth), requester),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_REST_START_TOO_EARLY' });
    await expect(
      service.issue(rest(1, { ...fromBirth, ...maternity }), requester),
    ).resolves.toBeDefined();

    // Nueve días después de la atención, a mediodía en Ecuador.
    clockReads = atWallClock(today, WallClockTime.of(12, 0));
    repository.snapshot = aSnapshot({
      diagnosisCodes: ['O80'],
      encounterStartedAt: atWallClock(addDays(today, -9), WallClockTime.of(12, 0)), // prettier-ignore
    });
    const later = { restFrom: today, restTo: addDays(today, 29), backdatingReason: 'Segundo certificado de la licencia' }; // prettier-ignore
    await expect(
      service.issue(rest(1, later), requester),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_REST_ISSUED_TOO_LATE' });
    await expect(
      service.issue(rest(1, { ...later, ...maternity, maternityAdmissionOn: addDays(today, -15), birthOn: addDays(today, -14), maternityDischargeOn: addDays(today, -12) }), requester), // prettier-ignore
    ).resolves.toBeDefined();
  });

  it('CER-048 CER-049 la maternidad pide un diagnostico obstetrico y no se solapa con otro reposo vigente de la paciente (D-109)', async () => {
    const birth = addDays(today, -5);
    const request = rest(1, {
      restFrom: birth,
      restTo: addDays(today, 10),
      backdatingReason: 'Dio a luz en el hospital hace cinco días',
      contingencyType: 'MATERNITY',
      maternityAdmissionOn: addDays(birth, -1),
      birthOn: birth,
      maternityDischargeOn: addDays(birth, 2),
    });

    repository.snapshot = aSnapshot({ diagnosisCodes: ['J02'] });
    await expect(service.issue(request, requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_MATERNITY_DIAGNOSIS_REQUIRED',
    });
    repository.snapshot = aSnapshot({
      diagnosisCodes: ['J02', 'O80'],
      patientRests: [{ from: addDays(today, 10), to: addDays(today, 12) }],
    });
    await expect(service.issue(request, requester)).rejects.toMatchObject({
      code: 'CERTIFICATE_REST_OVERLAPS',
    });
    expect(repository.issued).toHaveLength(0);

    // Control positivo: el otro reposo empieza el día siguiente.
    repository.snapshot = aSnapshot({
      diagnosisCodes: ['J02', 'O80'],
      patientRests: [{ from: addDays(today, 11), to: addDays(today, 12) }],
    });
    await expect(service.issue(request, requester)).resolves.toBeDefined();
  });

  it('CER-046 CER-047 la maternidad con un parto de hace mas de 84 dias, o mas alla de la licencia, se rechaza (D-109)', async () => {
    repository.snapshot = aSnapshot({ diagnosisCodes: ['O80'] });
    const maternityOf = (birth: ClinicalDate, to: ClinicalDate) =>
      rest(1, {
        restFrom: today,
        restTo: to,
        contingencyType: 'MATERNITY',
        maternityAdmissionOn: birth,
        birthOn: birth,
        maternityDischargeOn: birth,
      });
    await expect(
      service.issue(maternityOf(addDays(today, -85), today), requester),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_MATERNITY_DATES_TOO_OLD' });
    await expect(
      service.issue(maternityOf(addDays(today, -70), addDays(today, 15)), requester), // prettier-ignore
    ).rejects.toMatchObject({ code: 'CERTIFICATE_MATERNITY_LEAVE_EXCEEDED' });
    await expect(
      service.issue(maternityOf(addDays(today, -70), addDays(today, 14)), requester), // prettier-ignore
    ).resolves.toBeDefined();
  });
});
