import { Inject, Injectable } from '@nestjs/common';

import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import { authorizationFits } from '../domain/patient-authorization';
import {
  DataSubjectNotFoundError,
  PrivacyAuthorizationAlreadyGrantedError,
  PrivacyAuthorizationAlreadyRevokedError,
  PrivacyAuthorizationInvalidError,
  PrivacyAuthorizationNotFoundError,
} from '../domain/privacy.errors';
import {
  AUTHORIZATION_REPOSITORY,
  type AuthorizationRepository,
  type NewAuthorization,
  type PatientAuthorizationView,
  type Requester,
} from '../domain/privacy.repository';

/**
 * The optional authorizations (D8, D-221 §3): what a patient allows that is
 * not attending them — reminders and marketing by WhatsApp or email, photos,
 * research, sharing with third parties. Each one apart, revocable, with who
 * recorded it and when. None conditions registering, booking or attending.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(AUTHORIZATION_REPOSITORY)
    private readonly authorizations: AuthorizationRepository,
  ) {}

  /** PD-068 to PD-071, PD-074, PD-075. */
  async grant(
    authorization: NewAuthorization,
    requester: Requester,
    now: Date,
  ): Promise<PatientAuthorizationView> {
    await this.assertActiveChart(authorization.patientId);
    const contact = await this.authorizations.contactOf(
      authorization.patientId,
    );
    if (
      !authorizationFits(authorization.purpose, authorization.channel, contact)
    ) {
      throw new PrivacyAuthorizationInvalidError();
    }

    const result = await this.authorizations.grant(
      authorization,
      requester,
      now,
    );
    if (result.status === 'already-granted') {
      throw new PrivacyAuthorizationAlreadyGrantedError();
    }
    return result.authorization;
  }

  /** PD-069, PD-072, PD-074, PD-075. */
  async revoke(
    patientId: string,
    authorizationId: string,
    requester: Requester,
    now: Date,
  ): Promise<PatientAuthorizationView> {
    await this.assertActiveChart(patientId);
    const result = await this.authorizations.revoke(
      patientId,
      authorizationId,
      requester,
      now,
    );
    switch (result.status) {
      case 'missing':
        throw new PrivacyAuthorizationNotFoundError();
      case 'already-revoked':
        throw new PrivacyAuthorizationAlreadyRevokedError();
      case 'revoked':
        return result.authorization;
    }
  }

  /** PD-073, PD-075. */
  async authorizationsOf(
    patientId: string,
  ): Promise<PatientAuthorizationView[]> {
    const chart = await this.authorizations.chartOf(patientId);
    if (chart.status === 'missing') throw new DataSubjectNotFoundError();
    return this.authorizations.authorizationsOf(patientId);
  }

  private async assertActiveChart(patientId: string): Promise<void> {
    const chart = await this.authorizations.chartOf(patientId);
    if (chart.status === 'missing') throw new DataSubjectNotFoundError();
    if (chart.status === 'merged') {
      throw new PatientMergedError(chart.survivingMrn);
    }
  }
}
