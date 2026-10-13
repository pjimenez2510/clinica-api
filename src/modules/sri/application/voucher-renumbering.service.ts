import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ELECTRONIC_VOUCHER_REPOSITORY,
  type ElectronicVoucherRepository,
  type Renumbered,
} from '../domain/electronic-voucher.repository';
import {
  ElectronicVoucherNotFoundError,
  ElectronicVoucherNotRenumberableError,
} from '../domain/sri.errors';
import { SRI_CLOCK, type SriClock } from '../domain/sri-web-service';
import { isRenumberable } from '../domain/voucher-lifecycle';

import type { Requester } from './voucher-monitor.service';
import { VoucherPreparationService } from './voucher-preparation.service';

/**
 * SRI-108 to SRI-114 (D-262). «Renumerar con el siguiente libre»: the voucher
 * the SRI returned with the 45 —it already holds that number, from another
 * database or another system with the same RUC— gets the next number of its
 * point and a new key, and goes out again.
 *
 * A SERVICE OF ITS OWN and not a method of the monitor's: it changes the
 * document's number, which nothing else in this module does, and it is the
 * only use case that writes `voucher_renumbering`.
 */
@Injectable()
export class VoucherRenumberingService {
  constructor(
    @Inject(ELECTRONIC_VOUCHER_REPOSITORY)
    private readonly vouchers: ElectronicVoucherRepository,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    private readonly preparation: VoucherPreparationService,
    @Inject(SRI_CLOCK) private readonly clock: SriClock,
  ) {}

  /** SRI-109, SRI-110. */
  async renumber(voucherId: string, requester: Requester): Promise<Renumbered> {
    // Out of the requester's sites it does not exist; a voucher somebody
    // renumbered a moment ago does, and is answered as not renumberable.
    const siteId = await this.vouchers.siteOf(voucherId);
    if (
      siteId === null ||
      (requester.sites !== 'all' && !requester.sites.includes(siteId))
    ) {
      throw new ElectronicVoucherNotFoundError();
    }

    // The rule is decided under the row locks, on what is there NOW.
    const renumbered = await this.vouchers.renumber(
      voucherId,
      { userId: requester.userId, at: this.clock() },
      (candidate) =>
        candidate.documentStatus === 'REJECTED' && isRenumberable(candidate),
    );
    if (!renumbered) throw new ElectronicVoucherNotRenumberableError();

    await this.audit.record({
      userId: requester.userId,
      resourceType: 'electronic_voucher',
      resourceId: voucherId,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // After the commit, as when it was issued: the new voucher with its new
    // key, signed and queued. These never throw; the sweep retries a failure.
    if (renumbered.document.kind === 'INVOICE') {
      await this.preparation.prepare(renumbered.document.invoiceId);
    } else {
      await this.preparation.prepareCreditNote(
        renumbered.document.creditNoteId,
      );
    }
    return renumbered;
  }
}
