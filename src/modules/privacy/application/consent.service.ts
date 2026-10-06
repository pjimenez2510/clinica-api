import { Inject, Injectable } from '@nestjs/common';

import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  ConsentAlreadyCorrectedError,
  ConsentNotFoundError,
  ConsentTextInvalidError,
  ConsentTextNotPublishedError,
  ConsentTextOutdatedError,
  DataSubjectNotFoundError,
} from '../domain/privacy.errors';
import {
  CONSENT_REPOSITORY,
  type ConsentCorrection,
  type ConsentRepository,
  type ConsentTextView,
  type NewConsent,
  type PatientConsentView,
  type Requester,
} from '../domain/privacy.repository';

/** PD-004. */
export const CONSENT_TEXT_MAX_LENGTH = 20_000;

/** A consent as a screen reads it: with whether its version is still current. */
export interface PatientConsentEntry extends PatientConsentView {
  isCurrentVersion: boolean;
}

/**
 * The consent text and the patients' consents (D1, D2).
 *
 * The consent is NOT part of registering a patient (D-083 §5, LOPDP art.
 * 31.1): it is recorded on its own, after the chart exists, so a failure here
 * leaves a chart «sin consentimiento», never half a chart.
 */
@Injectable()
export class ConsentService {
  constructor(
    @Inject(CONSENT_REPOSITORY)
    private readonly consents: ConsentRepository,
  ) {}

  /**
   * PD-001. `null` when nothing has been published yet — an answer, not an
   * error: the desk registers patients the same, and a 404 here would be
   * noise on every registration of a clinic that has not written its text.
   */
  currentText(): Promise<ConsentTextView | null> {
    return this.consents.currentText();
  }

  /** PD-001. Newest first. */
  texts(): Promise<ConsentTextView[]> {
    return this.consents.texts();
  }

  /**
   * PD-045. The consequence of publishing, said before it happens: how many
   * charts stand on the current version and would be left on an older one.
   */
  currentVersionConsents(): Promise<number> {
    return this.consents.currentVersionConsents();
  }

  /**
   * PD-044 (D-128.8). «Corregir»: a consent recorded with the wrong medium or
   * grantor is replaced, in one step and without a reason, by a new one that
   * names it. The original stays untouched (PD-014) and the one nobody
   * supersedes is the one that stands. The text is the original's —it is what
   * was consented— so a newer publication does not stop the correction.
   */
  async correct(
    correction: ConsentCorrection,
    requester: Requester,
  ): Promise<PatientConsentEntry> {
    await this.assertActiveChart(correction.patientId);

    const result = await this.consents.correct(correction, requester);
    switch (result.status) {
      case 'missing':
        throw new ConsentNotFoundError();
      case 'already-corrected':
        throw new ConsentAlreadyCorrectedError();
      case 'corrected': {
        const current = await this.consents.currentText();
        return {
          ...result.consent,
          isCurrentVersion: result.consent.textVersion.id === current?.id,
        };
      }
    }
  }

  /** PD-002, PD-004, PD-005, PD-006. */
  async publish(body: string, requester: Requester): Promise<ConsentTextView> {
    if (body.trim() === '' || body.length > CONSENT_TEXT_MAX_LENGTH) {
      throw new ConsentTextInvalidError();
    }
    return this.consents.publish(body, requester);
  }

  /** PD-010 to PD-015, PD-017. */
  async record(
    consent: NewConsent,
    requester: Requester,
  ): Promise<PatientConsentEntry> {
    await this.assertActiveChart(consent.patientId);

    const result = await this.consents.record(consent, requester);
    switch (result.status) {
      case 'unknown-version':
        throw new ConsentTextNotPublishedError();
      case 'outdated':
        throw new ConsentTextOutdatedError(result.currentVersion);
      case 'recorded':
        return { ...result.consent, isCurrentVersion: true };
    }
  }

  /** PD-016. */
  async consentsOf(patientId: string): Promise<PatientConsentEntry[]> {
    const chart = await this.consents.chartOf(patientId);
    if (chart.status === 'missing') throw new DataSubjectNotFoundError();

    const [rows, current] = await Promise.all([
      this.consents.consentsOf(patientId),
      this.consents.currentText(),
    ]);
    return rows.map((row) => ({
      ...row,
      isCurrentVersion: row.textVersion.id === current?.id,
    }));
  }

  private async assertActiveChart(patientId: string): Promise<void> {
    const chart = await this.consents.chartOf(patientId);
    if (chart.status === 'missing') throw new DataSubjectNotFoundError();
    if (chart.status === 'merged') {
      throw new PatientMergedError(chart.survivingMrn);
    }
  }
}
