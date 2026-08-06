-- CreateEnum
CREATE TYPE "patient_sex" AS ENUM ('MALE', 'FEMALE', 'INTERSEX', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "identifier_type" AS ENUM ('CEDULA', 'PASSPORT', 'REFUGEE_CARD', 'FOREIGN_ID', 'PROVISIONAL');

-- CreateEnum
CREATE TYPE "identifier_use" AS ENUM ('OFFICIAL', 'OLD', 'TEMP');

-- CreateEnum
CREATE TYPE "agenda_entry_kind" AS ENUM ('APPOINTMENT', 'BLOCK');

-- CreateEnum
CREATE TYPE "agenda_status" AS ENUM ('BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'FULFILLED', 'CANCELLED', 'NO_SHOW', 'BLOCKED');

-- CreateEnum
CREATE TYPE "care_modality" AS ENUM ('MORBIDITY', 'PREVENTION');

-- CreateEnum
CREATE TYPE "care_setting" AS ENUM ('INTRAMURAL', 'EXTRAMURAL');

-- CreateEnum
CREATE TYPE "visit_sequence" AS ENUM ('FIRST_TIME', 'SUBSEQUENT');

-- CreateEnum
CREATE TYPE "discharge_condition" AS ENUM ('ALIVE', 'REFERRED', 'DECEASED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "diagnosis_certainty" AS ENUM ('PRESUMPTIVE', 'DEFINITIVE');

-- CreateEnum
CREATE TYPE "diagnosis_occurrence" AS ENUM ('FIRST_TIME', 'SUBSEQUENT');

-- CreateEnum
CREATE TYPE "note_status" AS ENUM ('DRAFT', 'SIGNED', 'SUPERSEDED', 'ENTERED_IN_ERROR');

-- CreateEnum
CREATE TYPE "violence_screening_result" AS ENUM ('NOT_APPLIED', 'NO_SIGNS', 'SUSPECTED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "violence_type" AS ENUM ('PHYSICAL', 'PSYCHOLOGICAL', 'SEXUAL', 'NEGLECT', 'ECONOMIC');

-- CreateEnum
CREATE TYPE "prescription_status" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "service_order_category" AS ENUM ('LABORATORY', 'IMAGING', 'PROCEDURE');

-- CreateEnum
CREATE TYPE "service_order_priority" AS ENUM ('ROUTINE', 'URGENT', 'STAT');

-- CreateEnum
CREATE TYPE "service_order_item_status" AS ENUM ('REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "diagnostic_report_status" AS ENUM ('PARTIAL', 'FINAL', 'CORRECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "abnormal_flag" AS ENUM ('NORMAL', 'LOW', 'HIGH', 'CRITICAL_LOW', 'CRITICAL_HIGH');

-- CreateEnum
CREATE TYPE "certificate_type" AS ENUM ('ATTENDANCE', 'MEDICAL_REST', 'FITNESS', 'DISABILITY_SUPPORT');

-- CreateEnum
CREATE TYPE "referral_direction" AS ENUM ('REFERRAL', 'DERIVATION', 'COUNTER_REFERRAL');

-- CreateEnum
CREATE TYPE "referral_status" AS ENUM ('ISSUED', 'ACCEPTED', 'REJECTED', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "interconsultation_status" AS ENUM ('REQUESTED', 'ANSWERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "waitlist_status" AS ENUM ('WAITING', 'CONTACTED', 'SCHEDULED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "allergy_criticality" AS ENUM ('LOW', 'HIGH', 'UNABLE_TO_ASSESS');

-- CreateTable
CREATE TABLE "catalog_system" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "canonical_uri" VARCHAR(255),
    "hierarchical" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_system_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_release" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "system_id" UUID NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "published_on" DATE,
    "effective_from" DATE NOT NULL,
    "source_url" VARCHAR(512),
    "source_checksum" CHAR(64),
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_concept" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "system_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "display" VARCHAR(512) NOT NULL,
    "parent_id" UUID,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "validPeriod" daterange,
    "attributes" JSONB,
    "introduced_by_release_id" UUID,
    "retired_by_release_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_concept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "msp_unicode" VARCHAR(20) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "ruc" VARCHAR(13),
    "parish_concept_id" UUID,
    "address_line" VARCHAR(255),
    "phone" VARCHAR(32),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_room" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "site_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "site_room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practitioner" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "msp_code" VARCHAR(32),
    "specialty_concept_id" UUID,
    "schedulable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "practitioner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practitioner_site" (
    "practitioner_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "practitioner_site_pkey" PRIMARY KEY ("practitioner_id","site_id")
);

-- CreateTable
CREATE TABLE "practitioner_schedule_rule" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "practitioner_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "service_type_concept_id" UUID,
    "weekday" SMALLINT NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "slot_minutes" SMALLINT NOT NULL DEFAULT 20,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "practitioner_schedule_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "mrn" VARCHAR(12) NOT NULL,
    "family_name" VARCHAR(120) NOT NULL,
    "second_family_name" VARCHAR(120),
    "given_name" VARCHAR(120) NOT NULL,
    "second_given_name" VARCHAR(120),
    "sex" "patient_sex" NOT NULL,
    "gender_identity_concept_id" UUID,
    "birth_date" DATE NOT NULL,
    "birth_date_estimated" BOOLEAN NOT NULL DEFAULT false,
    "deceased_at" TIMESTAMPTZ(6),
    "ethnicity_concept_id" UUID,
    "nationality_concept_id" UUID,
    "residence_parish_concept_id" UUID,
    "residence_address_line" VARCHAR(255),
    "phone" VARCHAR(32),
    "email" VARCHAR(255),
    "blood_type" VARCHAR(3),
    "is_provisional" BOOLEAN NOT NULL DEFAULT false,
    "mother_patient_id" UUID,
    "merged_into_id" UUID,
    "merged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_identifier" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "patient_id" UUID NOT NULL,
    "type" "identifier_type" NOT NULL,
    "issuing_country" CHAR(3) NOT NULL DEFAULT 'ECU',
    "value" VARCHAR(32) NOT NULL,
    "use" "identifier_use" NOT NULL DEFAULT 'OFFICIAL',
    "valid_from" DATE,
    "valid_to" DATE,
    "patient_merged" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_identifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_contact" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "patient_id" UUID NOT NULL,
    "full_name" VARCHAR(240) NOT NULL,
    "relationship" VARCHAR(80) NOT NULL,
    "phone" VARCHAR(32),
    "cedula" VARCHAR(10),
    "is_legal_representative" BOOLEAN NOT NULL DEFAULT false,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patient_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_allergy" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "patient_id" UUID NOT NULL,
    "substance_concept_id" UUID,
    "substance_text" VARCHAR(240) NOT NULL,
    "reaction" VARCHAR(512),
    "criticality" "allergy_criticality" NOT NULL DEFAULT 'UNABLE_TO_ASSESS',
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refuted_at" TIMESTAMPTZ(6),
    "refuted_notes" TEXT,

    CONSTRAINT "patient_allergy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_merge" (
    "id" BIGSERIAL NOT NULL,
    "source_patient_id" UUID NOT NULL,
    "target_patient_id" UUID NOT NULL,
    "performed_by" UUID,
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,

    CONSTRAINT "patient_merge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agenda_entry" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" "agenda_entry_kind" NOT NULL,
    "site_id" UUID NOT NULL,
    "practitioner_id" UUID NOT NULL,
    "room_id" UUID,
    "patient_id" UUID,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "blocks_calendar" BOOLEAN NOT NULL DEFAULT true,
    "released_at" TIMESTAMPTZ(6),
    "status" "agenda_status" NOT NULL DEFAULT 'BOOKED',
    "service_type_concept_id" UUID,
    "reason" VARCHAR(512),
    "booking_channel" VARCHAR(32),
    "checked_in_at" TIMESTAMPTZ(6),
    "no_show_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancellation_note" VARCHAR(512),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agenda_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agenda_status_history" (
    "id" BIGSERIAL NOT NULL,
    "agenda_entry_id" UUID NOT NULL,
    "from_status" "agenda_status",
    "to_status" "agenda_status" NOT NULL,
    "changed_by_id" UUID,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" VARCHAR(512),

    CONSTRAINT "agenda_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entry" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "patient_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "practitioner_id" UUID,
    "service_type_concept_id" UUID,
    "priority" SMALLINT NOT NULL DEFAULT 5,
    "preferred_from" DATE,
    "preferred_to" DATE,
    "status" "waitlist_status" NOT NULL DEFAULT 'WAITING',
    "contact_attempts" SMALLINT NOT NULL DEFAULT 0,
    "last_contacted_at" TIMESTAMPTZ(6),
    "converted_entry_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "waitlist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "site_id" UUID NOT NULL,
    "practitioner_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "agenda_entry_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "careModality" "care_modality" NOT NULL,
    "careSetting" "care_setting" NOT NULL DEFAULT 'INTRAMURAL',
    "visitSequence" "visit_sequence" NOT NULL,
    "age_years" SMALLINT,
    "age_months" SMALLINT,
    "age_days" SMALLINT,
    "dischargeCondition" "discharge_condition",
    "reported_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_vitals" (
    "encounter_id" UUID NOT NULL,
    "weight_kg" DECIMAL(6,3),
    "height_cm" DECIMAL(5,1),
    "head_circumference_cm" DECIMAL(5,1),
    "abdominal_circumference_cm" DECIMAL(5,1),
    "bmi" DECIMAL(5,2),
    "systolic_bp" SMALLINT,
    "diastolic_bp" SMALLINT,
    "heart_rate" SMALLINT,
    "respiratory_rate" SMALLINT,
    "temperature_c" DECIMAL(4,1),
    "oxygen_saturation" SMALLINT,
    "measured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encounter_vitals_pkey" PRIMARY KEY ("encounter_id")
);

-- CreateTable
CREATE TABLE "encounter_priority_group" (
    "encounter_id" UUID NOT NULL,
    "concept_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encounter_priority_group_pkey" PRIMARY KEY ("encounter_id","concept_id")
);

-- CreateTable
CREATE TABLE "violence_screening" (
    "encounter_id" UUID NOT NULL,
    "result" "violence_screening_result" NOT NULL DEFAULT 'NOT_APPLIED',
    "types" "violence_type"[],
    "screening_tool" VARCHAR(80),
    "action_taken" TEXT,
    "reported_to_authority" BOOLEAN NOT NULL DEFAULT false,
    "screened_by_id" UUID,
    "screened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "violence_screening_pkey" PRIMARY KEY ("encounter_id")
);

-- CreateTable
CREATE TABLE "encounter_diagnosis" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "encounter_id" UUID NOT NULL,
    "concept_id" UUID NOT NULL,
    "cie10_code" VARCHAR(10) NOT NULL,
    "cie10_display" VARCHAR(512) NOT NULL,
    "certainty" "diagnosis_certainty" NOT NULL,
    "occurrence" "diagnosis_occurrence" NOT NULL,
    "rank" SMALLINT NOT NULL DEFAULT 1,
    "notifiable" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encounter_diagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_procedure" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "encounter_id" UUID NOT NULL,
    "concept_id" UUID NOT NULL,
    "procedure_code" VARCHAR(20) NOT NULL,
    "procedure_display" VARCHAR(512) NOT NULL,
    "quantity" SMALLINT NOT NULL DEFAULT 1,
    "tariff_amount" DECIMAL(12,2),
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "encounter_procedure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_note" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "chain_id" UUID NOT NULL,
    "version" SMALLINT NOT NULL DEFAULT 1,
    "form_code" VARCHAR(8) NOT NULL,
    "form_version" VARCHAR(16) NOT NULL DEFAULT '1',
    "encounter_id" UUID NOT NULL,
    "status" "note_status" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "author_id" UUID NOT NULL,
    "signed_by_id" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "content_hash" CHAR(64),
    "supersedes_id" UUID,
    "amendment_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clinical_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "encounter_id" UUID NOT NULL,
    "note_id" UUID,
    "prescriber_id" UUID NOT NULL,
    "status" "prescription_status" NOT NULL DEFAULT 'DRAFT',
    "issued_at" TIMESTAMPTZ(6),
    "verification_code" VARCHAR(16),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_item" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "prescription_id" UUID NOT NULL,
    "concept_id" UUID,
    "generic_name" VARCHAR(240) NOT NULL,
    "presentation" VARCHAR(160),
    "concentration" VARCHAR(80),
    "dose_text" VARCHAR(160) NOT NULL,
    "route_code" VARCHAR(32),
    "frequency_text" VARCHAR(160) NOT NULL,
    "duration_days" SMALLINT,
    "quantity" DECIMAL(10,2),
    "instructions" TEXT,
    "off_formulary_justification" TEXT,

    CONSTRAINT "prescription_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "encounter_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "ordered_by_id" UUID NOT NULL,
    "category" "service_order_category" NOT NULL,
    "priority" "service_order_priority" NOT NULL DEFAULT 'ROUTINE',
    "clinical_note_text" TEXT,
    "pending_items" SMALLINT NOT NULL DEFAULT 0,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_item" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "service_order_id" UUID NOT NULL,
    "concept_id" UUID NOT NULL,
    "test_code" VARCHAR(32) NOT NULL,
    "test_display" VARCHAR(240) NOT NULL,
    "status" "service_order_item_status" NOT NULL DEFAULT 'REQUESTED',
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_report" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "service_order_id" UUID NOT NULL,
    "status" "diagnostic_report_status" NOT NULL DEFAULT 'PARTIAL',
    "performed_by_id" UUID,
    "conclusion" TEXT,
    "issued_at" TIMESTAMPTZ(6),
    "supersedes_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "diagnostic_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observation_result" (
    "id" BIGSERIAL NOT NULL,
    "report_id" UUID NOT NULL,
    "order_item_id" UUID,
    "analyte_concept_id" UUID,
    "analyte_display" VARCHAR(240) NOT NULL,
    "value_numeric" DECIMAL(18,6),
    "value_text" TEXT,
    "value_code" VARCHAR(64),
    "unit" VARCHAR(32),
    "reference_low" DECIMAL(18,6),
    "reference_high" DECIMAL(18,6),
    "reference_text" VARCHAR(160),
    "abnormal_flag" "abnormal_flag",
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "observation_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_certificate" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "issued_by_id" UUID NOT NULL,
    "type" "certificate_type" NOT NULL,
    "rest_from" DATE,
    "rest_to" DATE,
    "include_diagnosis" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "verification_code" VARCHAR(24) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revocation_reason" TEXT,

    CONSTRAINT "medical_certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "issued_by_id" UUID NOT NULL,
    "direction" "referral_direction" NOT NULL,
    "status" "referral_status" NOT NULL DEFAULT 'ISSUED',
    "destination_msp_unicode" VARCHAR(20),
    "destination_name" VARCHAR(240),
    "specialty_concept_id" UUID,
    "reason" TEXT NOT NULL,
    "summary" TEXT,
    "priority" "service_order_priority" NOT NULL DEFAULT 'ROUTINE',
    "responds_to_id" UUID,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interconsultation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "encounter_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "responded_by_id" UUID,
    "specialty_concept_id" UUID,
    "status" "interconsultation_status" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "findings" TEXT,
    "opinion" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(6),

    CONSTRAINT "interconsultation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_system_code_key" ON "catalog_system"("code");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_release_system_id_version_key" ON "catalog_release"("system_id", "version");

-- CreateIndex
CREATE INDEX "catalog_concept_system_id_code_idx" ON "catalog_concept"("system_id", "code");

-- CreateIndex
CREATE INDEX "catalog_concept_parent_id_idx" ON "catalog_concept"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_msp_unicode_key" ON "site"("msp_unicode");

-- CreateIndex
CREATE UNIQUE INDEX "site_room_site_id_name_key" ON "site_room"("site_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "practitioner_user_id_key" ON "practitioner"("user_id");

-- CreateIndex
CREATE INDEX "practitioner_schedule_rule_practitioner_id_weekday_idx" ON "practitioner_schedule_rule"("practitioner_id", "weekday");

-- CreateIndex
CREATE INDEX "practitioner_schedule_rule_site_id_weekday_idx" ON "practitioner_schedule_rule"("site_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "patient_mrn_key" ON "patient"("mrn");

-- CreateIndex
CREATE INDEX "patient_family_name_given_name_idx" ON "patient"("family_name", "given_name");

-- CreateIndex
CREATE INDEX "patient_birth_date_idx" ON "patient"("birth_date");

-- CreateIndex
CREATE INDEX "patient_identifier_patient_id_use_idx" ON "patient_identifier"("patient_id", "use");

-- CreateIndex
CREATE INDEX "patient_identifier_value_idx" ON "patient_identifier"("value");

-- CreateIndex
CREATE INDEX "patient_contact_patient_id_idx" ON "patient_contact"("patient_id");

-- CreateIndex
CREATE INDEX "patient_allergy_patient_id_refuted_at_idx" ON "patient_allergy"("patient_id", "refuted_at");

-- CreateIndex
CREATE INDEX "patient_merge_target_patient_id_idx" ON "patient_merge"("target_patient_id");

-- CreateIndex
CREATE INDEX "agenda_entry_practitioner_id_starts_at_idx" ON "agenda_entry"("practitioner_id", "starts_at");

-- CreateIndex
CREATE INDEX "agenda_entry_site_id_starts_at_idx" ON "agenda_entry"("site_id", "starts_at");

-- CreateIndex
CREATE INDEX "agenda_entry_patient_id_starts_at_idx" ON "agenda_entry"("patient_id", "starts_at" DESC);

-- CreateIndex
CREATE INDEX "agenda_status_history_agenda_entry_id_changed_at_idx" ON "agenda_status_history"("agenda_entry_id", "changed_at");

-- CreateIndex
CREATE INDEX "waitlist_entry_site_id_status_priority_created_at_idx" ON "waitlist_entry"("site_id", "status", "priority", "created_at");

-- CreateIndex
CREATE INDEX "waitlist_entry_patient_id_idx" ON "waitlist_entry"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_agenda_entry_id_key" ON "encounter"("agenda_entry_id");

-- CreateIndex
CREATE INDEX "encounter_patient_id_started_at_idx" ON "encounter"("patient_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "encounter_practitioner_id_started_at_idx" ON "encounter"("practitioner_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "encounter_site_id_started_at_idx" ON "encounter"("site_id", "started_at");

-- CreateIndex
CREATE INDEX "encounter_diagnosis_encounter_id_idx" ON "encounter_diagnosis"("encounter_id");

-- CreateIndex
CREATE INDEX "encounter_diagnosis_cie10_code_recorded_at_idx" ON "encounter_diagnosis"("cie10_code", "recorded_at");

-- CreateIndex
CREATE INDEX "encounter_procedure_encounter_id_idx" ON "encounter_procedure"("encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_note_supersedes_id_key" ON "clinical_note"("supersedes_id");

-- CreateIndex
CREATE INDEX "clinical_note_encounter_id_form_code_idx" ON "clinical_note"("encounter_id", "form_code");

-- CreateIndex
CREATE INDEX "clinical_note_chain_id_version_idx" ON "clinical_note"("chain_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_verification_code_key" ON "prescription"("verification_code");

-- CreateIndex
CREATE INDEX "prescription_encounter_id_idx" ON "prescription"("encounter_id");

-- CreateIndex
CREATE INDEX "prescription_item_prescription_id_idx" ON "prescription_item"("prescription_id");

-- CreateIndex
CREATE INDEX "service_order_encounter_id_idx" ON "service_order"("encounter_id");

-- CreateIndex
CREATE INDEX "service_order_site_id_requested_at_idx" ON "service_order"("site_id", "requested_at");

-- CreateIndex
CREATE INDEX "service_order_item_service_order_id_idx" ON "service_order_item"("service_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_report_supersedes_id_key" ON "diagnostic_report"("supersedes_id");

-- CreateIndex
CREATE INDEX "diagnostic_report_service_order_id_idx" ON "diagnostic_report"("service_order_id");

-- CreateIndex
CREATE INDEX "observation_result_report_id_idx" ON "observation_result"("report_id");

-- CreateIndex
CREATE INDEX "observation_result_analyte_concept_id_observed_at_idx" ON "observation_result"("analyte_concept_id", "observed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "medical_certificate_verification_code_key" ON "medical_certificate"("verification_code");

-- CreateIndex
CREATE INDEX "medical_certificate_patient_id_issued_at_idx" ON "medical_certificate"("patient_id", "issued_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "referral_responds_to_id_key" ON "referral"("responds_to_id");

-- CreateIndex
CREATE INDEX "referral_patient_id_issued_at_idx" ON "referral"("patient_id", "issued_at" DESC);

-- CreateIndex
CREATE INDEX "referral_status_issued_at_idx" ON "referral"("status", "issued_at");

-- CreateIndex
CREATE INDEX "interconsultation_encounter_id_idx" ON "interconsultation"("encounter_id");

-- CreateIndex
CREATE INDEX "interconsultation_status_requested_at_idx" ON "interconsultation"("status", "requested_at");

-- AddForeignKey
ALTER TABLE "catalog_release" ADD CONSTRAINT "catalog_release_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "catalog_system"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_concept" ADD CONSTRAINT "catalog_concept_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "catalog_system"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_concept" ADD CONSTRAINT "catalog_concept_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_concept" ADD CONSTRAINT "catalog_concept_introduced_by_release_id_fkey" FOREIGN KEY ("introduced_by_release_id") REFERENCES "catalog_release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_concept" ADD CONSTRAINT "catalog_concept_retired_by_release_id_fkey" FOREIGN KEY ("retired_by_release_id") REFERENCES "catalog_release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site" ADD CONSTRAINT "site_parish_concept_id_fkey" FOREIGN KEY ("parish_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_room" ADD CONSTRAINT "site_room_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_specialty_concept_id_fkey" FOREIGN KEY ("specialty_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioner_site" ADD CONSTRAINT "practitioner_site_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioner_site" ADD CONSTRAINT "practitioner_site_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioner_schedule_rule" ADD CONSTRAINT "practitioner_schedule_rule_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioner_schedule_rule" ADD CONSTRAINT "practitioner_schedule_rule_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioner_schedule_rule" ADD CONSTRAINT "practitioner_schedule_rule_service_type_concept_id_fkey" FOREIGN KEY ("service_type_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_gender_identity_concept_id_fkey" FOREIGN KEY ("gender_identity_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_ethnicity_concept_id_fkey" FOREIGN KEY ("ethnicity_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_nationality_concept_id_fkey" FOREIGN KEY ("nationality_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_residence_parish_concept_id_fkey" FOREIGN KEY ("residence_parish_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_mother_patient_id_fkey" FOREIGN KEY ("mother_patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_identifier" ADD CONSTRAINT "patient_identifier_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_substance_concept_id_fkey" FOREIGN KEY ("substance_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_source_patient_id_fkey" FOREIGN KEY ("source_patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_target_patient_id_fkey" FOREIGN KEY ("target_patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_entry" ADD CONSTRAINT "agenda_entry_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_entry" ADD CONSTRAINT "agenda_entry_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_entry" ADD CONSTRAINT "agenda_entry_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "site_room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_entry" ADD CONSTRAINT "agenda_entry_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_entry" ADD CONSTRAINT "agenda_entry_service_type_concept_id_fkey" FOREIGN KEY ("service_type_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_status_history" ADD CONSTRAINT "agenda_status_history_agenda_entry_id_fkey" FOREIGN KEY ("agenda_entry_id") REFERENCES "agenda_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_service_type_concept_id_fkey" FOREIGN KEY ("service_type_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_converted_entry_id_fkey" FOREIGN KEY ("converted_entry_id") REFERENCES "agenda_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_agenda_entry_id_fkey" FOREIGN KEY ("agenda_entry_id") REFERENCES "agenda_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_vitals" ADD CONSTRAINT "encounter_vitals_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_priority_group" ADD CONSTRAINT "encounter_priority_group_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_priority_group" ADD CONSTRAINT "encounter_priority_group_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violence_screening" ADD CONSTRAINT "violence_screening_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_signed_by_id_fkey" FOREIGN KEY ("signed_by_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "clinical_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "clinical_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_prescriber_id_fkey" FOREIGN KEY ("prescriber_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_ordered_by_id_fkey" FOREIGN KEY ("ordered_by_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_item" ADD CONSTRAINT "service_order_item_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_item" ADD CONSTRAINT "service_order_item_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_report" ADD CONSTRAINT "diagnostic_report_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_report" ADD CONSTRAINT "diagnostic_report_performed_by_id_fkey" FOREIGN KEY ("performed_by_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_report" ADD CONSTRAINT "diagnostic_report_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "diagnostic_report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observation_result" ADD CONSTRAINT "observation_result_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "diagnostic_report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observation_result" ADD CONSTRAINT "observation_result_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "service_order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observation_result" ADD CONSTRAINT "observation_result_analyte_concept_id_fkey" FOREIGN KEY ("analyte_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_certificate" ADD CONSTRAINT "medical_certificate_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_certificate" ADD CONSTRAINT "medical_certificate_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_certificate" ADD CONSTRAINT "medical_certificate_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral" ADD CONSTRAINT "referral_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral" ADD CONSTRAINT "referral_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral" ADD CONSTRAINT "referral_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral" ADD CONSTRAINT "referral_specialty_concept_id_fkey" FOREIGN KEY ("specialty_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral" ADD CONSTRAINT "referral_responds_to_id_fkey" FOREIGN KEY ("responds_to_id") REFERENCES "referral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interconsultation" ADD CONSTRAINT "interconsultation_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interconsultation" ADD CONSTRAINT "interconsultation_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interconsultation" ADD CONSTRAINT "interconsultation_responded_by_id_fkey" FOREIGN KEY ("responded_by_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interconsultation" ADD CONSTRAINT "interconsultation_specialty_concept_id_fkey" FOREIGN KEY ("specialty_concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
