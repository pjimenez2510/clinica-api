import { Inject, Injectable } from '@nestjs/common';

import { PrivacyNoticeInvalidError } from '../domain/privacy.errors';
import {
  PRIVACY_NOTICE_REPOSITORY,
  type PrivacyNoticeRepository,
  type PrivacyNoticeView,
  type Requester,
} from '../domain/privacy.repository';

/** PD-004. */
export const PRIVACY_NOTICE_MAX_LENGTH = 20_000;

/**
 * The privacy notice (D1, D-221 §2): one versioned text the clinic publishes
 * and prints. No step of the patient demands it.
 */
@Injectable()
export class PrivacyNoticeService {
  constructor(
    @Inject(PRIVACY_NOTICE_REPOSITORY)
    private readonly notices: PrivacyNoticeRepository,
  ) {}

  /** PD-001. Newest first: the current one leads. Empty is an answer. */
  versions(): Promise<PrivacyNoticeView[]> {
    return this.notices.versions();
  }

  /** PD-002, PD-004, PD-005, PD-006. */
  async publish(
    body: string,
    requester: Requester,
  ): Promise<PrivacyNoticeView> {
    if (body.trim() === '' || body.length > PRIVACY_NOTICE_MAX_LENGTH) {
      throw new PrivacyNoticeInvalidError();
    }
    return this.notices.publish(body, requester);
  }
}
