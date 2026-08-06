-- CreateTable
CREATE TABLE "auditoria_acceso" (
    "id" BIGSERIAL NOT NULL,
    "ocurrido_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuario_id" UUID,
    "recurso_tipo" VARCHAR(64) NOT NULL,
    "recurso_id" VARCHAR(64) NOT NULL,
    "accion" VARCHAR(32) NOT NULL,
    "ip" INET,
    "user_agent" VARCHAR(512),
    "trace_id" VARCHAR(32),
    "motivo_emergencia" TEXT,

    CONSTRAINT "auditoria_acceso_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auditoria_acceso_recurso_tipo_recurso_id_ocurrido_en_idx" ON "auditoria_acceso"("recurso_tipo", "recurso_id", "ocurrido_en" DESC);

-- CreateIndex
CREATE INDEX "auditoria_acceso_usuario_id_ocurrido_en_idx" ON "auditoria_acceso"("usuario_id", "ocurrido_en" DESC);

-- CreateIndex
CREATE INDEX "auditoria_acceso_ocurrido_en_idx" ON "auditoria_acceso"("ocurrido_en" DESC);
