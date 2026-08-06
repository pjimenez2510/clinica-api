-- CreateTable
CREATE TABLE "usuario" (
    "id" UUID NOT NULL,
    "correo" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "nombres" VARCHAR(120) NOT NULL,
    "apellidos" VARCHAR(120) NOT NULL,
    "cedula" VARCHAR(10),
    "registro_acess" VARCHAR(32),
    "acess_vence_en" DATE,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "mfa_secreto_cifrado" TEXT,
    "mfa_activado_en" TIMESTAMPTZ(6),
    "mfa_ultimo_paso" BIGINT,
    "intentos_fallidos" INTEGER NOT NULL DEFAULT 0,
    "bloqueado_hasta" TIMESTAMPTZ(6),
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "familia_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expira_en" TIMESTAMPTZ(6) NOT NULL,
    "usado_en" TIMESTAMPTZ(6),
    "revocado_en" TIMESTAMPTZ(6),
    "motivo_revocacion" VARCHAR(32),
    "ip" INET,
    "user_agent" VARCHAR(512),
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codigo_respaldo" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "codigo_hash" VARCHAR(255) NOT NULL,
    "usado_en" TIMESTAMPTZ(6),
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codigo_respaldo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuario_correo_key" ON "usuario"("correo");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_cedula_key" ON "usuario"("cedula");

-- CreateIndex
CREATE INDEX "usuario_correo_idx" ON "usuario"("correo");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_familia_id_idx" ON "refresh_token"("familia_id");

-- CreateIndex
CREATE INDEX "refresh_token_usuario_id_revocado_en_idx" ON "refresh_token"("usuario_id", "revocado_en");

-- CreateIndex
CREATE INDEX "refresh_token_expira_en_idx" ON "refresh_token"("expira_en");

-- CreateIndex
CREATE INDEX "codigo_respaldo_usuario_id_usado_en_idx" ON "codigo_respaldo"("usuario_id", "usado_en");

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codigo_respaldo" ADD CONSTRAINT "codigo_respaldo_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
