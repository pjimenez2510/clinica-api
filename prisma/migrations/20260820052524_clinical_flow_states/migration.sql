-- ═══════════════════════════════════════════════════════════════════════════
-- THE FLOW OF CARE: EXPLICIT STATE, AND THE TWO EXITS THAT WERE MISSING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Until now `encounter` had no status column: "open" meant `ended_at IS NULL`.
-- That works for two states and breaks at five, and five is what the flow
-- actually has — see `clinica-docs/FLUJO-DE-LA-ATENCION.md`.
--
-- Two axes, not one. This is the distinction HL7 FHIR R5 introduced by
-- splitting what R4 had merged, and it is the one the day board needs:
--
--   * `encounter.status`        — the ADMINISTRATIVE state of the ACT.
--   * `agenda_entry.subject_status` — WHERE THE PATIENT IS.
--
-- A patient can be `RECEIVING_CARE` while the encounter is `ON_HOLD` (they
-- went down for an X-ray). The doctor can be finished — `DISCHARGED` — while
-- the patient is still in the building, at the cashier. Collapsing the two
-- loses exactly the tram that this system was missing: the stretch between the
-- doctor signing and the patient walking out the door.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The state of the ACT
-- ───────────────────────────────────────────────────────────────────────────
CREATE TYPE "encounter_status" AS ENUM (
  -- Open and being worked on.
  'OPEN',
  -- Begun, temporarily suspended, EXPECTED BACK. The patient stepped out for
  -- a test and returns to the same encounter.
  'ON_HOLD',
  -- Begun and NOT able to be completed. Covers the doctor's side too — an
  -- emergency call, a power cut — which `ABANDONED` (the patient leaving) does
  -- not. Counting them the same erases an operational problem worth seeing.
  'DISCONTINUED',
  -- CLINICALLY complete and signed, administratively pending: charges,
  -- invoice, documents to hand over, next appointment. This is the state the
  -- old model had nowhere to put.
  'DISCHARGED',
  -- Everything done. The patient has left and the account is settled.
  'COMPLETED',
  -- Should never have existed. Deliberately distinct from a real closure.
  'ENTERED_IN_ERROR'
);

ALTER TABLE "encounter"
  ADD COLUMN "status" "encounter_status" NOT NULL DEFAULT 'OPEN';

-- Backfill from the implicit rule this column replaces.
UPDATE "encounter" SET "status" = 'COMPLETED' WHERE "ended_at" IS NOT NULL;

-- The two must agree, forever, in both directions. Without this the column
-- becomes a second source of truth that drifts from `ended_at`.
ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_status_matches_ended_at" CHECK (
    ("status" IN ('OPEN', 'ON_HOLD') AND "ended_at" IS NULL)
    OR
    ("status" IN ('DISCONTINUED', 'DISCHARGED', 'COMPLETED', 'ENTERED_IN_ERROR')
     AND "ended_at" IS NOT NULL)
  );

-- EN-009 requires a discharge condition to close. A closed encounter without
-- one is a clinical fact nobody stated, and it is precisely what an automatic
-- closure would have to invent — which is why D-A-010 rules automatic closure
-- out. DISCONTINUED and ENTERED_IN_ERROR are exempt: nothing clinical
-- concluded, so there is nothing to state.
ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_discharged_states_state_a_condition" CHECK (
    "status" NOT IN ('DISCHARGED', 'COMPLETED')
    OR "dischargeCondition" IS NOT NULL
  );

-- D-A-010: who closes is who opened. Stored rather than derived because the
-- substitution rule needs to record that the closer was NOT the author.
ALTER TABLE "encounter"
  ADD COLUMN "closed_by_id" UUID,
  ADD COLUMN "closed_at" TIMESTAMPTZ(6),
  -- Set when someone other than the opening practitioner closed it. The reason
  -- is required in that case: it is the whole point of allowing it.
  ADD COLUMN "closed_by_substitute_reason" VARCHAR(500);

ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_closed_by_fk"
    FOREIGN KEY ("closed_by_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT;

ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_substitute_closure_states_reason" CHECK (
    "closed_by_id" IS NULL
    OR "closed_by_id" = "practitioner_id"
    OR "closed_by_substitute_reason" IS NOT NULL
  );

-- The list of encounters still open from previous days, which D-A-010 puts in
-- place of an automatic closure. Partial so it stays small: the rows that
-- matter are the few that nobody closed.
CREATE INDEX "encounter_still_open_by_practitioner"
  ON "encounter" ("practitioner_id", "started_at")
  WHERE "status" IN ('OPEN', 'ON_HOLD');

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Where the PATIENT is
-- ───────────────────────────────────────────────────────────────────────────
--
-- Deliberately on `agenda_entry` and not on `encounter`: the patient is in the
-- waiting room BEFORE any encounter exists, and walk-ins get an agenda entry
-- too (channel WALK_IN, AG-029). Hanging it off the encounter would mean the
-- board could not show the person who just arrived.
CREATE TYPE "patient_subject_status" AS ENUM (
  'ARRIVED',
  'IN_PREPARATION',
  'READY',
  'RECEIVING_CARE',
  -- Left the building but IS expected back as part of this same visit.
  'ON_LEAVE',
  'DEPARTED'
);

ALTER TABLE "agenda_entry"
  ADD COLUMN "subject_status" "patient_subject_status",
  ADD COLUMN "subject_status_at" TIMESTAMPTZ(6);

-- A block is not a person. `kind` already guards this elsewhere and it guards
-- it here too.
ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_subject_status_needs_a_patient" CHECK (
    "subject_status" IS NULL OR "kind" <> 'BLOCK'
  );

ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_subject_status_carries_its_instant" CHECK (
    ("subject_status" IS NULL) = ("subject_status_at" IS NULL)
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. THE TWO EXITS THAT DID NOT EXIST, AND THE LIE THEY WERE CAUSING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LEFT_WITHOUT_BEING_SEEN: the patient came and left before being attended.
-- Until today the only options were to mark NO_SHOW — a lie, they did come,
-- and one that POISONS the no-show rate of AG-080 that AG-032 went to lengths
-- to keep honest with the WALK_IN channel — or to close an encounter that may
-- never have been opened.
--
-- ENTERED_IN_ERROR: voiding a real appointment and deleting one created by
-- mistake are not the same event, and counting them together corrupts the
-- cancellation metric.
ALTER TYPE "agenda_status" ADD VALUE IF NOT EXISTS 'LEFT_WITHOUT_BEING_SEEN';
ALTER TYPE "agenda_status" ADD VALUE IF NOT EXISTS 'ENTERED_IN_ERROR';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. THE ARTICLE 10 CALL, WHICH IS NOT TRIAGE AND IS NOT OPTIONAL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Ley de Derechos y Amparo del Paciente (Ley 77), art. 10: «El estado de
-- emergencia del paciente será calificado por el centro de salud AL MOMENTO DE
-- SU ARRIBO.» Art. 1 names «Clínicas» explicitly, so it reaches this
-- establishment. Art. 13 backs it with 12–18 months of prison, and 4–6 years
-- if a patient turned away dies.
--
-- This is NOT a severity scale and it does NOT reorder the queue. It is the
-- record that the call was made. Triage is a separate, optional capability
-- (D-A-001); this is neither optional nor conditional on it.
ALTER TABLE "agenda_entry"
  ADD COLUMN "emergency_flagged_at" TIMESTAMPTZ(6),
  ADD COLUMN "emergency_flagged_by_id" UUID,
  ADD COLUMN "emergency_note" VARCHAR(500);

ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_emergency_flag_fk"
    FOREIGN KEY ("emergency_flagged_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT;

ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_emergency_flag_names_who_and_when" CHECK (
    ("emergency_flagged_at" IS NULL) = ("emergency_flagged_by_id" IS NULL)
  );


-- Art. 9 forbids demanding any means of payment as a condition of being
-- received and stabilised. So coverage verification MUST be skippable, and the
-- skip has to leave a trace — otherwise the screen that blocks on payment is
-- illegal in the one case that matters most.
ALTER TABLE "agenda_entry"
  ADD COLUMN "coverage_check_skipped_reason" VARCHAR(500);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. THE CAPABILITIES THAT VARY BETWEEN INSTALLATIONS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The user's governing rule for this system: «este sistema no solo se usa en
-- una clínica, siempre se debe hacer flexible». What differs between clinics
-- is DATA. What the Ecuadorian norm fixes stays an enum.
ALTER TABLE "site_parameter"
  -- D-A-001. Triage OFF by default. No norm requires it of an outpatient
  -- establishment (A.M. 00030-2020 art. 27 lists no emergency service in the
  -- «centro de especialidades» portfolio), and no validated scale exists for
  -- scheduled outpatient care. Switched on, the scale is Manchester — the
  -- vocabulary the Ecuadorian typology itself uses (urgency C/D/E, emergency
  -- A/B/C) — never ESI, which defines itself as an emergency-department tool.
  ADD COLUMN "triage_enabled" BOOLEAN NOT NULL DEFAULT false,

  -- D-A-005. This clinic's doctors DO hold certificates, so it is ON by
  -- default. It is a parameter and not a constant because a clinic without
  -- them cannot be left unable to work: the private-pharmacy norm
  -- (ARCSA-DE-2022-012-AKRG, Disposición General Décima) accepts, for the
  -- electronic prescription, «la signatura realizada en el sistema informático
  -- mediante el registro con usuario y clave de acceso».
  ADD COLUMN "require_certified_signature" BOOLEAN NOT NULL DEFAULT true,

  -- D-A-011. Fifteen years from the last encounter (5 active + 10 passive).
  -- NOT setting a period is what breaches the LOPDP: art. 10.i obliges the
  -- controller to «establecer plazos para su supresión o revisión periódica»
  -- and art. 51 to declare them. Nothing is ever purged automatically; this
  -- drives the review, not a delete.
  ADD COLUMN "record_retention_years" SMALLINT NOT NULL DEFAULT 15,

  -- Late arrival is NOT a status: it is the difference between the appointment
  -- time and the check-in instant, both already stored. This is the policy
  -- threshold, and the clinic sets it.
  ADD COLUMN "late_arrival_grace_minutes" SMALLINT NOT NULL DEFAULT 15;

ALTER TABLE "site_parameter"
  ADD CONSTRAINT "site_parameter_retention_is_positive"
    CHECK ("record_retention_years" > 0),
  ADD CONSTRAINT "site_parameter_grace_is_not_negative"
    CHECK ("late_arrival_grace_minutes" >= 0);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. MONEY: FOUR PIECES PEOPLE COLLAPSE INTO ONE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The classic mistake is storing the price ON the service. It breaks the first
-- day an insurer pays differently, and it breaks again when prices rise and
-- every past invoice silently changes with them.
--
--   1. `billable_service` — what the clinic knows how to do. NO PRICE.
--   2. `price_list` + `price` — a price per service PER PAYER, with a validity
--      range that cannot overlap. Guaranteed by the database, not by code.
--   3. `charge_item` — «this patient, this encounter, this service», and it
--      FREEZES the price resolved by the DATE OF SERVICE. This is the piece
--      almost nobody builds and the one that prevents every later problem.
--   4. `invoice` — the tax document. IMMUTABLE.
--
-- Everything here is a ROW, never an enum: the user's rule is that this system
-- runs in more than one clinic and payers, services, prices and taxes differ
-- between them.

-- ───────────────────────────────────────────────────────────────────────────
-- 6.1 Who pays. A TABLE, on purpose.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "payer" (
  "id"   UUID NOT NULL DEFAULT uuidv7(),
  "code" VARCHAR(32)  NOT NULL,
  "name" VARCHAR(160) NOT NULL,

  -- Distinguishes «the patient pays» from a third party, because the two
  -- behave differently at the cashier and on the invoice. NOT a payer list:
  -- there can be many private insurers, all of them THIRD_PARTY.
  "kind" VARCHAR(24) NOT NULL,

  -- RUC of the third party, when there is one. The patient's own document
  -- lives on `patient`.
  "ruc"  VARCHAR(13),

  -- Whether reaching this payer requires an agreement on file. Informational,
  -- and it is what makes «convenio vencido» answerable.
  "agreement_reference" VARCHAR(120),
  "agreement_valid_to"  DATE,

  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "payer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payer_code_unique" UNIQUE ("code"),
  CONSTRAINT "payer_kind_is_known" CHECK ("kind" IN ('SELF_PAY', 'PUBLIC_NETWORK', 'PRIVATE_INSURANCE', 'COMPANY_AGREEMENT'))
);

-- ───────────────────────────────────────────────────────────────────────────
-- 6.2 Tax. The SRI's own codes, as data.
-- ───────────────────────────────────────────────────────────────────────────
--
-- D-A-006. Health services are 0% (LRTI art. 56.2) — BUT the 0% depends on the
-- PROVIDER, not the service: art. 191 of the regulation conditions it on an
-- authorised establishment and a professional with a registered third-level
-- degree. And it EXCLUDES cosmetic surgery and cosmetology treatments, which
-- go to the general rate.
--
-- So the system does NOT infer the rate. Every service carries its own,
-- editable, in plain sight, for someone with accounting judgement to review.
CREATE TABLE "tax_rate" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  -- The SRI's `codigoPorcentaje` from the electronic-voucher technical sheet.
  -- Table 17: 0 → 0%, 2 → 12%, 3 → 14%, 4 → 15%, 5 → 5%, 6 → no objeto,
  -- 7 → exento, 8 → diferenciado, 10 → 13%. Codes 6 and 7 are NOT synonyms of
  -- 0% and must never be used as a convenience.
  "sri_code" VARCHAR(4) NOT NULL,
  "name"     VARCHAR(80) NOT NULL,

  -- NULL for «no objeto» and «exento», where no percentage applies.
  "percentage" DECIMAL(5, 2),

  "valid_from" DATE NOT NULL,
  "valid_to"   DATE,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tax_rate_period_not_empty" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from"),
  CONSTRAINT "tax_rate_percentage_in_range" CHECK ("percentage" IS NULL OR ("percentage" >= 0 AND "percentage" <= 100))
);

ALTER TABLE "tax_rate"
  ADD COLUMN "valid_period" daterange
  GENERATED ALWAYS AS (daterange("valid_from", "valid_to", '[)')) STORED;

ALTER TABLE "tax_rate"
  ADD CONSTRAINT "tax_rate_code_temporal_unique"
  UNIQUE ("sri_code", "valid_period" WITHOUT OVERLAPS);

-- ───────────────────────────────────────────────────────────────────────────
-- 6.3 What the clinic does. WITHOUT A PRICE.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "billable_service" (
  "id"   UUID NOT NULL DEFAULT uuidv7(),
  "code" VARCHAR(32)  NOT NULL,
  "name" VARCHAR(200) NOT NULL,

  -- Grouping for the screen and for reporting. A row elsewhere would be
  -- over-engineering; this is a label.
  "category" VARCHAR(60) NOT NULL,

  -- The MSP tariff code, when the service has one. NOMENCLATURE ONLY — the
  -- Tarifario does NOT set what a private patient is charged (its scope was
  -- narrowed by A.M. 0046-2017 to dealings within the public network). Kept
  -- because it is what makes billing TO the public network possible.
  "tariff_code" VARCHAR(16),

  -- D-A-006: the tax rate is a property OF THE SERVICE and it is editable.
  "tax_rate_id" UUID NOT NULL,

  -- Ties the service to what actually happened, so a charge can be raised from
  -- the encounter instead of typed at the cashier. All optional: a service may
  -- be none of these (a room fee, a supply).
  "procedure_concept_id" UUID,

  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "billable_service_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billable_service_code_unique" UNIQUE ("code"),
  CONSTRAINT "billable_service_tax_rate_fk"
    FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rate"("id") ON DELETE RESTRICT,
  CONSTRAINT "billable_service_procedure_fk"
    FOREIGN KEY ("procedure_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT
);

CREATE INDEX "billable_service_by_category" ON "billable_service" ("category", "name");

-- ───────────────────────────────────────────────────────────────────────────
-- 6.4 Price lists, and the guarantee that two prices never overlap
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "price_list" (
  "id"   UUID NOT NULL DEFAULT uuidv7(),
  "name" VARCHAR(120) NOT NULL,

  -- A list belongs to a payer. Self-pay is a payer like any other, which is
  -- what keeps «the normal price» from being a special case in the code.
  "payer_id" UUID NOT NULL,

  -- NULL means every site. A clinic with branches that charge differently sets
  -- it; one that does not, never sees the field.
  "site_id" UUID,

  -- LOS art. 184 obliges «exhibir en sitios visibles para el público las
  -- tarifas que se cobran». A list marked public is what that screen reads.
  "publicly_listed" BOOLEAN NOT NULL DEFAULT false,

  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "price_list_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "price_list_payer_fk"
    FOREIGN KEY ("payer_id") REFERENCES "payer"("id") ON DELETE RESTRICT,
  CONSTRAINT "price_list_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT
);

CREATE TABLE "price" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "price_list_id"       UUID NOT NULL,
  "billable_service_id" UUID NOT NULL,

  -- Decimal, never float. Money in binary floating point is a defect waiting
  -- for the invoice that is off by a cent.
  "amount" DECIMAL(12, 2) NOT NULL,

  "valid_from" DATE NOT NULL,
  "valid_to"   DATE,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "price_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "price_list_fk"
    FOREIGN KEY ("price_list_id") REFERENCES "price_list"("id") ON DELETE RESTRICT,
  CONSTRAINT "price_service_fk"
    FOREIGN KEY ("billable_service_id") REFERENCES "billable_service"("id") ON DELETE RESTRICT,
  CONSTRAINT "price_is_not_negative" CHECK ("amount" >= 0),
  CONSTRAINT "price_period_not_empty" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);

ALTER TABLE "price"
  ADD COLUMN "valid_period" daterange
  GENERATED ALWAYS AS (daterange("valid_from", "valid_to", '[)')) STORED;

-- THE guarantee of this table: one service cannot have two simultaneous prices
-- in the same list. Enforced by PostgreSQL, so no application path can produce
-- the ambiguity that would make «what did this cost that day» unanswerable.
ALTER TABLE "price"
  ADD CONSTRAINT "price_temporal_unique"
  UNIQUE ("price_list_id", "billable_service_id", "valid_period" WITHOUT OVERLAPS);

-- ───────────────────────────────────────────────────────────────────────────
-- 6.5 The patient's account
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "patient_account" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "patient_id" UUID NOT NULL,
  "site_id"    UUID NOT NULL,

  -- The encounter this account settles. NULL for an account opened outside a
  -- clinical act (a walk-in lab test bought at the counter).
  "encounter_id" UUID,

  -- WHO PAYS, decided at arrival and not at the cashier. Asking at the end is
  -- asking too late: it is what decides the price of everything before it.
  "payer_id"      UUID NOT NULL,
  "price_list_id" UUID NOT NULL,

  "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',

  "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMPTZ(6),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "patient_account_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "patient_account_patient_fk"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT,
  CONSTRAINT "patient_account_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT,
  CONSTRAINT "patient_account_encounter_fk"
    FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT,
  CONSTRAINT "patient_account_payer_fk"
    FOREIGN KEY ("payer_id") REFERENCES "payer"("id") ON DELETE RESTRICT,
  CONSTRAINT "patient_account_price_list_fk"
    FOREIGN KEY ("price_list_id") REFERENCES "price_list"("id") ON DELETE RESTRICT,
  CONSTRAINT "patient_account_status_is_known"
    CHECK ("status" IN ('OPEN', 'SETTLED', 'CANCELLED')),
  CONSTRAINT "patient_account_closed_states_its_instant"
    CHECK (("status" = 'OPEN') = ("closed_at" IS NULL))
);

-- One open account per encounter. Two would make «what does this visit owe»
-- ambiguous.
CREATE UNIQUE INDEX "patient_account_one_open_per_encounter"
  ON "patient_account" ("encounter_id")
  WHERE "status" = 'OPEN' AND "encounter_id" IS NOT NULL;

CREATE INDEX "patient_account_by_patient" ON "patient_account" ("patient_id", "opened_at" DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 6.6 THE CHARGE. The piece that prevents every later problem.
-- ───────────────────────────────────────────────────────────────────────────
--
-- «What was done» and «what is charged» are two records and must never be the
-- same one. The clinical fact does not change because the patient did not pay;
-- deleting a charge cannot delete the act.
--
-- And the price is FROZEN HERE, resolved by the date of service. Without that,
-- raising a tariff tomorrow rewrites every past invoice, and a visit from
-- three months ago billed today is charged at today's rate.
CREATE TABLE "charge_item" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "account_id"          UUID NOT NULL,
  "billable_service_id" UUID NOT NULL,

  -- Where it came from clinically. Both optional: not every charge is a
  -- procedure, and not every procedure is charged.
  "encounter_id"           UUID,
  "encounter_procedure_id" UUID,
  "service_order_item_id"  UUID,

  -- THE DATE THAT RESOLVES THE PRICE. Clinical, in America/Guayaquil — not the
  -- instant the cashier typed it.
  "service_date" DATE NOT NULL,

  "quantity" DECIMAL(10, 3) NOT NULL DEFAULT 1,

  -- FROZEN. The unit price resolved from the price list on `service_date`, and
  -- the price row it came from, so the resolution is auditable years later.
  "unit_amount"      DECIMAL(12, 2) NOT NULL,
  "resolved_price_id" UUID,

  -- Frozen too, and for the same reason as `procedure_display` elsewhere in
  -- this schema: if the catalogue is lost, the invoice still says what was
  -- sold.
  "service_display" VARCHAR(200) NOT NULL,

  -- The tax rate AS IT APPLIED THAT DAY. Not a lookup at print time: rates
  -- change, and a 2024 invoice must keep saying 12%.
  "tax_sri_code"   VARCHAR(4) NOT NULL,
  "tax_percentage" DECIMAL(5, 2),

  -- Discounts. `discount_amount` is the money taken off, never a percentage:
  -- a percentage re-derived at print time drifts by rounding.
  "discount_amount"         DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "discount_reason"         VARCHAR(300),
  -- Who authorised a discount above the role's ceiling. NULL when it was
  -- within it. This is the second pair of eyes.
  "discount_authorised_by_id" UUID,

  "status" VARCHAR(16) NOT NULL DEFAULT 'BILLABLE',

  "created_by_id" UUID NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "charge_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "charge_item_account_fk"
    FOREIGN KEY ("account_id") REFERENCES "patient_account"("id") ON DELETE RESTRICT,
  CONSTRAINT "charge_item_service_fk"
    FOREIGN KEY ("billable_service_id") REFERENCES "billable_service"("id") ON DELETE RESTRICT,
  CONSTRAINT "charge_item_encounter_fk"
    FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT,
  CONSTRAINT "charge_item_price_fk"
    FOREIGN KEY ("resolved_price_id") REFERENCES "price"("id") ON DELETE RESTRICT,
  CONSTRAINT "charge_item_created_by_fk"
    FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "charge_item_discount_authorised_by_fk"
    FOREIGN KEY ("discount_authorised_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,

  CONSTRAINT "charge_item_status_is_known"
    CHECK ("status" IN ('PLANNED', 'BILLABLE', 'NOT_BILLABLE', 'BILLED', 'CANCELLED')),
  CONSTRAINT "charge_item_quantity_is_positive" CHECK ("quantity" > 0),
  CONSTRAINT "charge_item_amount_is_not_negative" CHECK ("unit_amount" >= 0),
  CONSTRAINT "charge_item_discount_is_not_negative" CHECK ("discount_amount" >= 0),
  -- A discount cannot exceed what is being charged.
  CONSTRAINT "charge_item_discount_within_line"
    CHECK ("discount_amount" <= "unit_amount" * "quantity"),
  -- A discount with no stated reason is a discount nobody can explain.
  CONSTRAINT "charge_item_discount_states_a_reason"
    CHECK ("discount_amount" = 0 OR "discount_reason" IS NOT NULL)
);

CREATE INDEX "charge_item_by_account" ON "charge_item" ("account_id");
CREATE INDEX "charge_item_by_encounter" ON "charge_item" ("encounter_id") WHERE "encounter_id" IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 6.7 THE INVOICE, WHICH CANNOT BE EDITED
-- ───────────────────────────────────────────────────────────────────────────
--
-- D-A-007. The SRI does not allow modifying or deleting an authorised invoice.
-- Online voiding runs until the 10th of the following month; after that only a
-- credit note, for twelve months. And from 2026 invoices issued to «Consumidor
-- Final» CANNOT BE VOIDED AT ALL.
--
-- Therefore: this system has no «edit invoice» screen. It has «issue a credit
-- note», which is a different screen with a different permission and a
-- mandatory reason. The immutability below is what makes that true in the
-- database rather than in a convention.
CREATE TABLE "invoice" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "account_id" UUID NOT NULL,
  "site_id"    UUID NOT NULL,

  -- SRI sequence: establishment-emission point-sequential.
  "emission_point_id" UUID NOT NULL,
  "sequential"        VARCHAR(9) NOT NULL,
  -- The 49-digit access key, once the SRI authorises it.
  "access_key"        VARCHAR(49),

  -- WHO THE INVOICE IS MADE OUT TO. Deliberately NOT nullable-by-default:
  -- issuing to «consumidor final» destroys the patient's personal-expense
  -- rebate and, since 2026, cannot even be voided. It has to be a choice
  -- someone makes.
  "buyer_identification_type" VARCHAR(2)  NOT NULL,
  "buyer_identification"      VARCHAR(20) NOT NULL,
  "buyer_name"                VARCHAR(300) NOT NULL,
  "buyer_email"               VARCHAR(320),
  -- TRUE only when someone deliberately chose it, and it is surfaced as an
  -- exception in the UI rather than being the comfortable default.
  "is_final_consumer"         BOOLEAN NOT NULL DEFAULT false,

  "subtotal_taxed"   DECIMAL(12, 2) NOT NULL,
  "subtotal_untaxed" DECIMAL(12, 2) NOT NULL,
  "discount_total"   DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "tax_total"        DECIMAL(12, 2) NOT NULL,
  "total"            DECIMAL(12, 2) NOT NULL,

  "status" VARCHAR(24) NOT NULL DEFAULT 'DRAFT',

  "issued_at"     TIMESTAMPTZ(6),
  "authorised_at" TIMESTAMPTZ(6),

  "issued_by_id" UUID NOT NULL,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "invoice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_account_fk"
    FOREIGN KEY ("account_id") REFERENCES "patient_account"("id") ON DELETE RESTRICT,
  CONSTRAINT "invoice_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT,
  CONSTRAINT "invoice_emission_point_fk"
    FOREIGN KEY ("emission_point_id") REFERENCES "emission_point"("id") ON DELETE RESTRICT,
  CONSTRAINT "invoice_issued_by_fk"
    FOREIGN KEY ("issued_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,

  CONSTRAINT "invoice_status_is_known"
    CHECK ("status" IN ('DRAFT', 'ISSUED', 'AUTHORISED', 'REJECTED', 'VOIDED')),
  CONSTRAINT "invoice_access_key_length"
    CHECK ("access_key" IS NULL OR length("access_key") = 49),
  CONSTRAINT "invoice_authorised_carries_its_key"
    CHECK ("status" <> 'AUTHORISED' OR ("access_key" IS NOT NULL AND "authorised_at" IS NOT NULL)),
  CONSTRAINT "invoice_total_is_consistent"
    CHECK ("total" = "subtotal_taxed" + "subtotal_untaxed" + "tax_total" - "discount_total"),
  -- A final-consumer invoice states the SRI's own placeholder identification.
  CONSTRAINT "invoice_final_consumer_identification"
    CHECK (NOT "is_final_consumer" OR "buyer_identification" = '9999999999999')
);

CREATE UNIQUE INDEX "invoice_sequential_unique"
  ON "invoice" ("emission_point_id", "sequential");
CREATE INDEX "invoice_by_account" ON "invoice" ("account_id");

-- The immutability that makes «there is no edit-invoice button» true in the
-- database, not merely in the UI. Once the SRI has authorised it, only the
-- lifecycle columns may move, and only towards VOIDED.
CREATE OR REPLACE FUNCTION trg_invoice_is_immutable_once_authorised()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" IN ('AUTHORISED', 'VOIDED') THEN
    IF NEW."account_id"                IS DISTINCT FROM OLD."account_id"
    OR NEW."emission_point_id"          IS DISTINCT FROM OLD."emission_point_id"
    OR NEW."sequential"                 IS DISTINCT FROM OLD."sequential"
    OR NEW."access_key"                 IS DISTINCT FROM OLD."access_key"
    OR NEW."buyer_identification"       IS DISTINCT FROM OLD."buyer_identification"
    OR NEW."buyer_identification_type"  IS DISTINCT FROM OLD."buyer_identification_type"
    OR NEW."buyer_name"                 IS DISTINCT FROM OLD."buyer_name"
    OR NEW."is_final_consumer"          IS DISTINCT FROM OLD."is_final_consumer"
    OR NEW."subtotal_taxed"             IS DISTINCT FROM OLD."subtotal_taxed"
    OR NEW."subtotal_untaxed"           IS DISTINCT FROM OLD."subtotal_untaxed"
    OR NEW."discount_total"             IS DISTINCT FROM OLD."discount_total"
    OR NEW."tax_total"                  IS DISTINCT FROM OLD."tax_total"
    OR NEW."total"                      IS DISTINCT FROM OLD."total"
    OR NEW."issued_at"                  IS DISTINCT FROM OLD."issued_at"
    OR NEW."authorised_at"              IS DISTINCT FROM OLD."authorised_at"
    THEN
      RAISE EXCEPTION 'invoice_authorised_is_immutable'
        USING HINT = 'Una factura autorizada por el SRI no se modifica: se corrige con nota de credito.';
    END IF;

    IF OLD."status" = 'VOIDED' AND NEW."status" <> 'VOIDED' THEN
      RAISE EXCEPTION 'invoice_voided_is_final'
        USING HINT = 'Una factura anulada no vuelve atras.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_immutable
  BEFORE UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION trg_invoice_is_immutable_once_authorised();

-- Deleting one is never right either.
CREATE OR REPLACE FUNCTION trg_invoice_is_never_deleted()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'invoice_is_never_deleted'
    USING HINT = 'Una factura no se elimina. Se anula, o se corrige con nota de credito.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_no_delete
  BEFORE DELETE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION trg_invoice_is_never_deleted();

-- The one legal way to correct an authorised invoice.
CREATE TABLE "credit_note" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "invoice_id" UUID NOT NULL,

  "emission_point_id" UUID NOT NULL,
  "sequential"        VARCHAR(9) NOT NULL,
  "access_key"        VARCHAR(49),

  -- Never optional. A correction with no stated motive is indistinguishable
  -- from an error being buried.
  "reason" VARCHAR(500) NOT NULL,

  "amount" DECIMAL(12, 2) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'DRAFT',

  "issued_by_id" UUID NOT NULL,
  "issued_at"    TIMESTAMPTZ(6),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "credit_note_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_note_invoice_fk"
    FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_note_emission_point_fk"
    FOREIGN KEY ("emission_point_id") REFERENCES "emission_point"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_note_issued_by_fk"
    FOREIGN KEY ("issued_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_note_status_is_known"
    CHECK ("status" IN ('DRAFT', 'ISSUED', 'AUTHORISED', 'REJECTED')),
  CONSTRAINT "credit_note_amount_is_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "credit_note_sequential_unique"
  ON "credit_note" ("emission_point_id", "sequential");

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. WHAT CAN BE ORDERED, AND WHAT COMES BACK
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The distinction that decides the whole design: what is ORDERED and what is
-- RESULTED are different things with 1:N cardinality. «Biometría hemática» is
-- one line on the order and one line on the invoice; it returns twenty
-- analytes, each with its own unit, reference range and abnormal flag.
--
-- Every standard separates them — HL7 v2 puts them in different segments,
-- LOINC has a field that classifies them, and the MSP already did it too: form
-- 010A is a closed list of «determinaciones» ticked with an X, and form 010B
-- reports DETERMINACIÓN · RESULTADO · UNIDAD DE MEDIDA · VALOR DE REFERENCIA.
--
-- The system already prevents ordering by free text (`service_order_item`
-- points at a catalogue concept). What did NOT exist is the DEFINITION: which
-- analytes an order yields, what specimen it needs, what ranges apply.

-- 7.1 The analyte: what returns a value.
CREATE TABLE "analyte_definition" (
  "id"   UUID NOT NULL DEFAULT uuidv7(),
  "code" VARCHAR(32)  NOT NULL,
  "name" VARCHAR(160) NOT NULL,

  -- Optional and nullable ON PURPOSE. No Ecuadorian norm requires LOINC — form
  -- 010 has no code column, and the only official mention is in the telehealth
  -- norm, binding only on those who provide telehealth. Mapping is expert
  -- human work: automated mapping scored 0.59 precision. So: a secondary code
  -- for 20–60 high-value analytes, never the primary key.
  "loinc_code" VARCHAR(16),

  -- UCUM, so 'mg/dL' means one thing.
  "unit" VARCHAR(32),

  "value_type" VARCHAR(16) NOT NULL,
  "decimals"   SMALLINT,

  -- Allowed answers when the type is coded (positive/negative, S/I/R).
  "allowed_values" JSONB,

  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "analyte_definition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "analyte_definition_code_unique" UNIQUE ("code"),
  CONSTRAINT "analyte_definition_value_type_is_known"
    CHECK ("value_type" IN ('NUMERIC', 'CODED', 'TEXT', 'ORDINAL')),
  CONSTRAINT "analyte_definition_numeric_carries_a_unit"
    CHECK ("value_type" <> 'NUMERIC' OR "unit" IS NOT NULL)
);

-- 7.2 Reference ranges, qualified by sex and age. The reason `abnormal_flag`
-- can be computed at all.
CREATE TABLE "analyte_reference_range" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "analyte_definition_id" UUID NOT NULL,

  -- NULL means it applies to everyone.
  "sex"           VARCHAR(16),
  "age_min_days"  INTEGER,
  "age_max_days"  INTEGER,

  "range_kind" VARCHAR(16) NOT NULL DEFAULT 'REFERENCE',

  "low"  DECIMAL(14, 4),
  "high" DECIMAL(14, 4),
  "text" VARCHAR(200),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "analyte_reference_range_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "analyte_reference_range_analyte_fk"
    FOREIGN KEY ("analyte_definition_id") REFERENCES "analyte_definition"("id") ON DELETE RESTRICT,
  CONSTRAINT "analyte_reference_range_kind_is_known"
    CHECK ("range_kind" IN ('REFERENCE', 'CRITICAL', 'ABSOLUTE')),
  CONSTRAINT "analyte_reference_range_says_something"
    CHECK ("low" IS NOT NULL OR "high" IS NOT NULL OR "text" IS NOT NULL),
  CONSTRAINT "analyte_reference_range_bounds_are_ordered"
    CHECK ("low" IS NULL OR "high" IS NULL OR "high" >= "low"),
  CONSTRAINT "analyte_reference_range_ages_are_ordered"
    CHECK ("age_min_days" IS NULL OR "age_max_days" IS NULL OR "age_max_days" >= "age_min_days")
);

CREATE INDEX "analyte_reference_range_by_analyte"
  ON "analyte_reference_range" ("analyte_definition_id");

-- 7.3 The orderable: what the doctor asks for and what the invoice charges.
CREATE TABLE "exam_definition" (
  "id"   UUID NOT NULL DEFAULT uuidv7(),
  "code" VARCHAR(32)  NOT NULL,
  "name" VARCHAR(200) NOT NULL,

  -- The section of MSP form 010A this belongs to, so a compliant order can be
  -- printed. That form is a legal requirement in the private sector too:
  -- A.M. 00002393 art. 42.
  "form_010_section" VARCHAR(60),

  -- What the patient must do beforehand, printed on the order.
  "specimen_type"       VARCHAR(80),
  "patient_preparation" VARCHAR(500),
  "turnaround_hours"    SMALLINT,

  -- Which lab performs it. External is the realistic case (D-A-012).
  "performed_externally" BOOLEAN NOT NULL DEFAULT true,
  "external_lab_name"    VARCHAR(160),
  "external_lab_code"    VARCHAR(64),

  -- What it costs. The same four-piece model as everything else: the price
  -- lives in a price list, not here.
  "billable_service_id" UUID,

  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "exam_definition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "exam_definition_code_unique" UNIQUE ("code"),
  CONSTRAINT "exam_definition_service_fk"
    FOREIGN KEY ("billable_service_id") REFERENCES "billable_service"("id") ON DELETE RESTRICT
);

-- 7.4 Which analytes an exam yields. The relation that did not exist, and
-- without which a result has nothing to be validated against.
CREATE TABLE "exam_definition_analyte" (
  "exam_definition_id"    UUID NOT NULL,
  "analyte_definition_id" UUID NOT NULL,

  -- The order they are printed and displayed in.
  "position" SMALLINT NOT NULL,

  -- A reflex analyte is only produced when another comes back positive.
  "is_reflex" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "exam_definition_analyte_pkey"
    PRIMARY KEY ("exam_definition_id", "analyte_definition_id"),
  CONSTRAINT "exam_definition_analyte_exam_fk"
    FOREIGN KEY ("exam_definition_id") REFERENCES "exam_definition"("id") ON DELETE RESTRICT,
  CONSTRAINT "exam_definition_analyte_analyte_fk"
    FOREIGN KEY ("analyte_definition_id") REFERENCES "analyte_definition"("id") ON DELETE RESTRICT
);
