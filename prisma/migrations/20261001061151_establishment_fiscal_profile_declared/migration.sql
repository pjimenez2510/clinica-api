-- OR-031, SRI-008. When the administration last declared the establishment's
-- fiscal flags (obligado a llevar contabilidad, contribuyente especial,
-- agente de retención, RIMPE).
--
-- `keeps_accounting` is NOT NULL DEFAULT false and `rimpe_regime` defaults to
-- 'NONE': an establishment nobody reviewed would declare
-- `<obligadoContabilidad>NO</obligadoContabilidad>` and no RIMPE legend in
-- every voucher — a fiscal statement the code made by omission. A company is
-- always obliged to keep accounts. Review of 2026-10-01.
--
-- NULL means «never declared», and no voucher is prepared until it is set
-- (the monitor says so). What the values are is the clinic's RUC's, not the
-- system's: this column only records that a person stated them.

ALTER TABLE "establishment" ADD COLUMN "fiscal_profile_declared_at" TIMESTAMPTZ(6);
