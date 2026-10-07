-- SRI-091 (D-158.3). The e-mail that still fails seventy-two hours after the
-- authorisation is given up: `UNDELIVERABLE`, never retried by the queue or
-- by the sweep (which only picks NULL, PENDING and FAILED).
--
-- Only the list of known values grows; no row changes. A voucher already
-- FAILED for more than three days becomes UNDELIVERABLE on its next attempt,
-- by the application, so this migration needs no backfill.
ALTER TABLE "electronic_voucher"
  DROP CONSTRAINT "electronic_voucher_delivery_status_is_known",
  ADD CONSTRAINT "electronic_voucher_delivery_status_is_known"
    CHECK ("delivery_status" IS NULL
        OR "delivery_status" IN ('PENDING', 'SENT', 'NO_EMAIL', 'FAILED', 'UNDELIVERABLE'));
