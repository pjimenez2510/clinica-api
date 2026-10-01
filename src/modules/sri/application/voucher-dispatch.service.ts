import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  RIDE_ISSUER,
  type RideIssuer,
} from '../../../shared/documents/ride-issuer.port';
import { MAILER, type Mailer } from '../../../shared/mail/mail.port';
import {
  ELECTRONIC_VOUCHER_REPOSITORY,
  VOUCHER_QUEUE,
  type AttemptRecord,
  type ElectronicVoucherRepository,
  type VoucherQueue,
  type VoucherRecord,
} from '../domain/electronic-voucher.repository';
import {
  SRI_CLOCK,
  SRI_SETTINGS,
  SRI_WEB_SERVICE,
  type SriClock,
  type SriSettings,
  type SriWebService,
} from '../domain/sri-web-service';
import {
  afterAuthorisation,
  afterReception,
  authorisationDocument,
  deliveryRetrySeconds,
  type AuthorisationAnswer,
  type QueueStep,
  type ReceptionAnswer,
  type VoucherTransition,
} from '../domain/voucher-lifecycle';

import { VoucherPreparationService } from './voucher-preparation.service';

/**
 * SRI-040 to SRI-057, SRI-072 to SRI-076. What each job of the queue does.
 *
 * Every handler is IDEMPOTENT by status: a job that runs twice —pg-boss
 * retried it after a crash, the sweep queued it again— finds the voucher
 * already moved and does nothing. That, plus `recordAttempt` applying only
 * when the status is still the one read (SRI-057), is what makes «at least
 * once» delivery of jobs safe.
 */
@Injectable()
export class VoucherDispatchService {
  constructor(
    @Inject(ELECTRONIC_VOUCHER_REPOSITORY)
    private readonly vouchers: ElectronicVoucherRepository,
    @Inject(SRI_WEB_SERVICE) private readonly sri: SriWebService,
    @Inject(VOUCHER_QUEUE) private readonly queue: VoucherQueue,
    @Inject(RIDE_ISSUER) private readonly rides: RideIssuer,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(SRI_CLOCK) private readonly clock: SriClock,
    @Inject(SRI_SETTINGS) private readonly settings: SriSettings,
    private readonly preparation: VoucherPreparationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(VoucherDispatchService.name);
  }

  async run(step: QueueStep, voucherId: string): Promise<void> {
    switch (step) {
      case 'SEND':
        return this.send(voucherId);
      case 'AUTHORISE':
        return this.authorise(voucherId);
      case 'DELIVER':
        return this.deliver(voucherId);
    }
  }

  /** SRI-042 to SRI-046, SRI-050. `validarComprobante` with the stored bytes. */
  async send(voucherId: string): Promise<void> {
    const voucher = await this.vouchers.findById(voucherId);
    if (!voucher || voucher.status !== 'SIGNED' || !voucher.signedXml) return;
    if (!this.sri.isConfigured()) return;
    // SRI-055. A key of the testing environment sent to production (or the
    // reverse) is returned for ever, and the key cannot change. It waits,
    // logged, until a person decides what becomes of it (D-102).
    if (voucher.environment !== this.settings.environment) {
      this.logger.error(
        {
          voucher_id: voucher.id,
          error_code: 'SRI_ENVIRONMENT_MISMATCH',
        },
        'the voucher belongs to the other SRI environment; it is not sent',
      );
      return;
    }

    const startedAt = this.clock();
    const answer = await this.sri.receive(voucher.signedXml);
    const attemptNumber = voucher.attemptCount + 1;
    const transition = afterReception(voucher.status, answer, attemptNumber);

    await this.apply(
      voucher,
      receptionAttempt(answer, startedAt, this.clock()),
      transition,
      null,
    );
  }

  /** SRI-047 to SRI-050. `autorizacionComprobante` with the same key. */
  async authorise(voucherId: string): Promise<void> {
    const voucher = await this.vouchers.findById(voucherId);
    if (!voucher || voucher.status !== 'RECEIVED') return;
    if (!this.sri.isConfigured()) return;

    const startedAt = this.clock();
    const answer = await this.sri.authorise(voucher.accessKey);
    const transition = afterAuthorisation(
      answer,
      voucher.attemptCount + 1,
      voucher.signedAt,
    );

    await this.apply(
      voucher,
      authorisationAttempt(answer, startedAt, this.clock()),
      transition,
      answer.kind === 'AUTORIZADO'
        ? {
            number: answer.authorisationNumber,
            authorisedAt: answer.authorisedAt,
            authorisedXml: authorisationDocument(answer),
          }
        : null,
    );
  }

  /**
   * SRI-072 to SRI-076. The RIDE and the authorised XML to the buyer. Only the
   * delivery columns move: the authorisation is a fact an e-mail cannot undo.
   */
  async deliver(voucherId: string): Promise<void> {
    const voucher = await this.vouchers.findById(voucherId);
    if (!voucher || voucher.status !== 'AUTHORISED' || !voucher.authorisedXml) {
      return;
    }
    // SRI-075. Once it left, a retried job does not send it again.
    if (
      voucher.deliveryStatus === 'SENT' ||
      voucher.deliveryStatus === 'NO_EMAIL'
    ) {
      return;
    }

    const context = await this.vouchers.deliveryContext(voucher.id);
    if (!context) return;
    if (!context.buyerEmail) {
      await this.vouchers.recordDelivery(voucher.id, 'NO_EMAIL', this.clock());
      return;
    }

    try {
      const ride = await this.rides.issueRide(
        context.invoiceId,
        context.issuedById,
      );
      await this.mailer.send({
        to: context.buyerEmail,
        subject: `Factura electrónica ${context.documentNumber} — ${context.establishmentName}`,
        text:
          `Estimado(a) ${context.buyerName}:\n\n` +
          `Adjuntamos la factura electrónica ${context.documentNumber}, autorizada por el SRI, ` +
          `en PDF (RIDE) y en XML.\n\nClave de acceso: ${voucher.accessKey}\n\n` +
          `${context.establishmentName}`,
        attachments: [
          {
            fileName: ride.fileName,
            content: ride.content,
            contentType: 'application/pdf',
          },
          {
            fileName: `${voucher.accessKey}.xml`,
            content: Buffer.from(voucher.authorisedXml, 'utf8'),
            contentType: 'application/xml',
          },
        ],
      });
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          voucher_id: voucher.id,
          error_code: 'SRI_DELIVERY_FAILED',
        },
        'the authorised voucher could not be e-mailed; it will be retried',
      );
      const now = this.clock();
      await this.vouchers.recordDelivery(voucher.id, 'FAILED', now);
      await this.queue.schedule(
        'DELIVER',
        voucher,
        deliveryRetrySeconds(voucher.authorisedAt, now),
      );
      return;
    }
    // SRI-075. Outside the try: the e-mail LEFT. A failure to note it must
    // not be taken for a failed e-mail and send it again.
    await this.vouchers.recordDelivery(voucher.id, 'SENT', this.clock());
  }

  /**
   * SRI-056, SC-084. The safety net under «the notice swallows the error»:
   * prepares what was not prepared, signs what was waiting, and re-queues
   * what has no job. The queue's singleton key drops what is already queued.
   */
  async sweep(limit = 200): Promise<void> {
    const now = this.clock();
    const work = await this.vouchers.pendingWork(limit, now);
    for (const invoiceId of work.invoicesWithoutVoucher) {
      await this.preparation.prepare(invoiceId);
    }
    // SC-084. One voucher that throws —a figure that does not add up, an
    // opening that cannot be written— is logged and skipped: it must not
    // stop the sweep from reaching the rest, every minute, for ever.
    for (const voucher of work.unsigned) {
      await this.isolated(voucher, () => this.preparation.sign(voucher));
    }
    if (this.sri.isConfigured()) {
      for (const voucher of work.inFlight) {
        if (
          voucher.nextAttemptAt &&
          voucher.nextAttemptAt.getTime() > now.getTime()
        ) {
          continue;
        }
        await this.isolated(voucher, () =>
          this.queue.schedule(
            voucher.status === 'SIGNED' ? 'SEND' : 'AUTHORISE',
            voucher,
            0,
          ),
        );
      }
    }
    for (const voucher of work.undelivered) {
      await this.isolated(voucher, () =>
        this.queue.schedule('DELIVER', voucher, 0),
      );
    }
  }

  private async isolated(
    voucher: VoucherRecord,
    work: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error(
        { err: error, voucher_id: voucher.id, error_code: 'SRI_SWEEP_FAILED' },
        'the sweep could not handle a voucher; it carries on with the rest',
      );
    }
  }

  private async apply(
    voucher: VoucherRecord,
    attempt: AttemptRecord,
    transition: VoucherTransition,
    authorisation: Parameters<
      ElectronicVoucherRepository['recordAttempt']
    >[2]['authorisation'],
  ): Promise<void> {
    const nextAttemptAt = transition.next
      ? new Date(this.clock().getTime() + transition.next.delaySeconds * 1000)
      : null;

    const applied = await this.vouchers.recordAttempt(voucher.id, attempt, {
      expectedStatus: voucher.status,
      status: transition.status,
      invoiceStatus: transition.invoiceStatus,
      lastMessages: transition.lastMessages,
      nextAttemptAt: transition.next?.step === 'DELIVER' ? null : nextAttemptAt,
      authorisation,
    });

    // SRI-057. Somebody else moved it first: their job carries on, not ours.
    if (!applied || !transition.next) return;
    await this.queue.schedule(
      transition.next.step,
      voucher,
      transition.next.delaySeconds,
    );
  }
}

function receptionAttempt(
  answer: ReceptionAnswer,
  startedAt: Date,
  endedAt: Date,
): AttemptRecord {
  return {
    operation: 'RECEPTION',
    startedAt,
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    outcome: answer.kind,
    messages: answer.kind === 'TRANSPORT_FAILURE' ? [] : answer.messages,
    transportError: answer.kind === 'TRANSPORT_FAILURE' ? answer.error : null,
  };
}

function authorisationAttempt(
  answer: AuthorisationAnswer,
  startedAt: Date,
  endedAt: Date,
): AttemptRecord {
  return {
    operation: 'AUTHORISATION',
    startedAt,
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    outcome: answer.kind,
    messages:
      answer.kind === 'AUTORIZADO' || answer.kind === 'NO AUTORIZADO'
        ? answer.messages
        : [],
    transportError: answer.kind === 'TRANSPORT_FAILURE' ? answer.error : null,
  };
}
