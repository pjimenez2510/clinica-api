-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(120) NOT NULL,
    "last_name" VARCHAR(120) NOT NULL,
    "cedula" VARCHAR(10),
    "acess_registration" VARCHAR(32),
    "acess_expires_on" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mfa_secret_encrypted" TEXT,
    "mfa_enabled_at" TIMESTAMPTZ(6),
    "mfa_last_step" BIGINT,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revocation_reason" VARCHAR(32),
    "ip" INET,
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_code" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" VARCHAR(255) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_audit" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID,
    "resource_type" VARCHAR(64) NOT NULL,
    "resource_id" VARCHAR(64) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "ip" INET,
    "user_agent" VARCHAR(512),
    "trace_id" VARCHAR(32),
    "emergency_reason" TEXT,

    CONSTRAINT "access_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_cedula_key" ON "app_user"("cedula");

-- CreateIndex
CREATE INDEX "app_user_email_idx" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "refresh_token_user_id_revoked_at_idx" ON "refresh_token"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_token_expires_at_idx" ON "refresh_token"("expires_at");

-- CreateIndex
CREATE INDEX "backup_code_user_id_used_at_idx" ON "backup_code"("user_id", "used_at");

-- CreateIndex
CREATE INDEX "access_audit_resource_type_resource_id_occurred_at_idx" ON "access_audit"("resource_type", "resource_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "access_audit_user_id_occurred_at_idx" ON "access_audit"("user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "access_audit_occurred_at_idx" ON "access_audit"("occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_code" ADD CONSTRAINT "backup_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
