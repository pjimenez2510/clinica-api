-- ═══════════════════════════════════════════════════════════════════════════
-- THREE GAPS THE BILLING BUILD RAN INTO, AND WHY EACH ONE MATTERS
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Voiding a charge, with the reason actually kept
-- ───────────────────────────────────────────────────────────────────────────
--
-- `charge_item` could reach status CANCELLED but had nowhere to say WHO
-- cancelled it, WHEN, or WHY. The requirement asks for a mandatory reason —
-- and demanding a reason the system then throws away is worse than not asking,
-- because it looks like an audit trail and is not one.
--
-- Note what this is NOT: it is not an invoice being edited. A charge is voided
-- BEFORE it reaches an invoice; once billed, the only correction is a credit
-- note. The CHECK below makes that structural rather than hoped for.
ALTER TABLE "charge_item"
  ADD COLUMN "voided_at"    TIMESTAMPTZ(6),
  ADD COLUMN "voided_by_id" UUID,
  ADD COLUMN "void_reason"  VARCHAR(500);

ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_voided_by_fk"
    FOREIGN KEY ("voided_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT;

-- The three travel together or not at all: a void with no author is not a
-- void, it is a disappearance.
ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_void_states_who_when_and_why" CHECK (
    ("voided_at" IS NULL AND "voided_by_id" IS NULL AND "void_reason" IS NULL)
    OR
    ("voided_at" IS NOT NULL AND "voided_by_id" IS NOT NULL AND "void_reason" IS NOT NULL)
  );

-- Voided and CANCELLED are the same fact seen from two columns; letting them
-- disagree makes «is this charge alive» a question with two answers.
ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_void_matches_status" CHECK (
    ("voided_at" IS NULL) = ("status" <> 'CANCELLED')
  );

-- A charge already on an invoice is not voided — it is credit-noted.
ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_billed_is_not_voided" CHECK (
    "status" <> 'BILLED' OR "voided_at" IS NULL
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 2. WHO CHECKED THE TAX RATE, which is the whole point of D-A-006
-- ───────────────────────────────────────────────────────────────────────────
--
-- The seed ships a DEFAULT rate: 0% for health services (LRTI art. 56.2), the
-- general rate for supplies and for cosmetic work (art. 191 of the
-- regulation). A default is not a fiscal classification, and the system
-- deliberately does NOT infer one — the 0% depends on the PROVIDER holding a
-- current operating permit and a registered third-level degree, which no
-- column can know.
--
-- So the decision has to be made by a person with accounting judgement, and
-- until these two columns existed there was no way to tell a rate someone
-- checked from a rate nobody has looked at since it was seeded. That
-- difference is what an inspection asks about.
ALTER TABLE "billable_service"
  ADD COLUMN "tax_reviewed_at"    TIMESTAMPTZ(6),
  ADD COLUMN "tax_reviewed_by_id" UUID;

ALTER TABLE "billable_service"
  ADD CONSTRAINT "billable_service_tax_reviewer_fk"
    FOREIGN KEY ("tax_reviewed_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT;

ALTER TABLE "billable_service"
  ADD CONSTRAINT "billable_service_tax_review_names_who_and_when" CHECK (
    ("tax_reviewed_at" IS NULL) = ("tax_reviewed_by_id" IS NULL)
  );

-- The screen that says «these rates are nobody's decision yet» reads this.
CREATE INDEX "billable_service_tax_pending_review"
  ON "billable_service" ("category", "name")
  WHERE "tax_reviewed_at" IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. How much each role may discount — the clinic's policy, as data
-- ───────────────────────────────────────────────────────────────────────────
--
-- The user's answer on discounts was «flexible, el admin asigna». That makes
-- the ceiling a ROW, not a constant: roles themselves are already data in this
-- system (a clinic invents an insurance liaison and it should not need a
-- deploy), so a limit keyed to a hardcoded role list would be the one piece
-- that still did.
--
-- Above the ceiling the answer is not «no» — it is «ask someone else», which
-- is what `billing:discount-override` exists for.
CREATE TABLE "role_discount_limit" (
  "role_id" UUID NOT NULL,

  -- The ceiling as a percentage of the line. A percentage and not an amount
  -- because a fixed sum means something different on a $25 consultation than
  -- on a $600 procedure, and the clinic thinks in percentages.
  "max_discount_percentage" DECIMAL(5, 2) NOT NULL,

  -- Below this, no second signature is asked for at all. Lets a clinic waive
  -- rounding without turning every cent into a two-person ceremony.
  "auto_approve_below_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "role_discount_limit_pkey" PRIMARY KEY ("role_id"),
  CONSTRAINT "role_discount_limit_role_fk"
    FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE,
  CONSTRAINT "role_discount_limit_percentage_in_range"
    CHECK ("max_discount_percentage" >= 0 AND "max_discount_percentage" <= 100),
  CONSTRAINT "role_discount_limit_auto_approve_is_not_negative"
    CHECK ("auto_approve_below_amount" >= 0)
);

COMMENT ON TABLE "role_discount_limit" IS
  'Cuanto puede descontar cada rol sin pedir autorizacion a otra persona. '
  'CASCADE al borrar el rol: el limite no significa nada sin el.';
