import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  DuplicateIdentifierError,
  PatientNotFoundError,
} from '../domain/patient.errors';
import {
  type NewPatient,
  PATIENT_REPOSITORY,
  type PatientDetail,
  type PatientPage,
  type PatientRepository,
  type PatientSearchCriteria,
} from '../domain/patient.repository';

/** Who is asking, so the trail can say so. */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Reading and creating patient records.
 *
 * The authorisation decision is NOT here — the guard settled it before this
 * ran, from the route's `@RequirePermission`. What is here is everything that
 * must happen regardless of which endpoint asked: the access trail, the
 * duplicate check, and the fact that a merged record is not a missing one.
 */
@Injectable()
export class PatientsService {
  constructor(
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PatientsService.name);
  }

  /**
   * Searches the register.
   *
   * NOT AUDITED PER ROW, deliberately. A search is typed letter by letter and
   * auditing each keystroke would write thousands of rows a day and bury the
   * accesses that matter — which is the opposite of what the trail is for.
   * Opening a record is the accountable act, and that is audited below.
   */
  async search(criteria: PatientSearchCriteria): Promise<PatientPage> {
    return this.patients.search(criteria);
  }

  /**
   * Opens one record.
   *
   * THIS is the accountable act, and the audit entry is written whether or not
   * anything else succeeds afterwards. Recording after a successful render
   * would miss exactly the case worth investigating: somebody opening charts
   * and closing them again.
   *
   * A record that does not exist is NOT audited: there is no data subject to
   * account to, and writing a row per guessed identifier would let anybody
   * fill the trail with noise.
   */
  async getById(id: string, requester: Requester): Promise<PatientDetail> {
    const patient = await this.patients.findById(id);
    if (!patient) throw new PatientNotFoundError();

    await this.audit.record({
      userId: requester.userId,
      resourceType: 'patient',
      resourceId: patient.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return patient;
  }

  /**
   * Registers a new patient.
   *
   * The duplicate check is a COURTESY, not the guarantee. The database holds a
   * partial unique index over active identifiers, and that is what actually
   * prevents two charts for the same cedula under concurrency. Checking first
   * only buys a message that names the problem instead of a constraint
   * violation the receptionist cannot read.
   */
  async create(
    input: NewPatient,
    requester: Requester,
  ): Promise<PatientDetail> {
    if (input.identifier) {
      const existing = await this.patients.findByIdentifier(input.identifier);
      if (existing) throw new DuplicateIdentifierError();
    }

    const created = await this.patients.create(input);

    await this.audit.record({
      userId: requester.userId,
      resourceType: 'patient',
      resourceId: created.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // The MRN is safe to log: it is an internal number, not a national
    // identifier, and support needs it to trace a registration.
    this.logger.info(
      { patient_mrn: created.mrn, action: 'PATIENT_REGISTERED' },
      'patient registered',
    );

    return created;
  }
}
