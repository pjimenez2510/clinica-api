-- assistant_ai_run
--
-- Escrito a mano. feat/ia-a4-puerto-llm (D-239 §3 y §5, módulo assistant).
--
-- 1. AS-011. `ai_run`: una fila por intento a un proveedor de modelos, sin
--    texto. El respaldo deja varias filas con el mismo `request_id`.
-- 2. AS-012. La base rechaza un resultado, nivel o proveedor fuera de su lista,
--    un intento menor que 1, cifras negativas, y un motivo de respaldo que no
--    cuadre con el número de intento: el primero no tiene, los siguientes sí,
--    y sólo puede ser un fallo de disponibilidad (AS-007). El `IS NOT NULL` no
--    sobra: `NULL IN (...)` es NULL, y un CHECK que da NULL deja pasar la fila.
-- 3. AS-014. `ai_exchange`: el texto seudonimizado de un intento, sólo si
--    `ASSISTANT_EXCHANGE_LOG` está encendido; se borra con su fila de `ai_run`.
BEGIN;

CREATE TABLE "ai_run" (
  "id"                 UUID          NOT NULL DEFAULT uuidv7(),
  "request_id"         UUID          NOT NULL,
  "attempt"            SMALLINT      NOT NULL,
  "provider"           VARCHAR(16)   NOT NULL,
  "model"              VARCHAR(80)   NOT NULL,
  "tier"               VARCHAR(8)    NOT NULL,
  "purpose"            VARCHAR(40)   NOT NULL,
  "prompt_version"     VARCHAR(40)   NOT NULL,
  "outcome"            VARCHAR(16)   NOT NULL,
  "http_status"        SMALLINT,
  "input_tokens"       INTEGER,
  "output_tokens"      INTEGER,
  "cache_read_tokens"  INTEGER,
  "cache_write_tokens" INTEGER,
  "reasoning_tokens"   INTEGER,
  "cost_usd"           DECIMAL(14,8),
  "worst_case_usd"     DECIMAL(14,8) NOT NULL,
  "price_valid_from"   DATE          NOT NULL,
  "latency_ms"         INTEGER       NOT NULL,
  "started_at"         TIMESTAMPTZ(6) NOT NULL,
  "fallback_from"      VARCHAR(16),
  "encounter_id"       UUID,

  CONSTRAINT "ai_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_run_encounter_id_fkey" FOREIGN KEY ("encounter_id")
    REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_run_provider_known"
    CHECK ("provider" IN ('gemini', 'anthropic', 'openai')),
  CONSTRAINT "ai_run_tier_known" CHECK ("tier" IN ('fast', 'quality')),
  CONSTRAINT "ai_run_outcome_known" CHECK ("outcome" IN (
    'ok', 'invalid-answer', 'cut-off', 'refused', 'timeout', 'rate-limited',
    'provider-error', 'cancelled')),
  CONSTRAINT "ai_run_attempt_positive" CHECK ("attempt" >= 1),
  CONSTRAINT "ai_run_figures_not_negative" CHECK (
    COALESCE("input_tokens", 0) >= 0 AND COALESCE("output_tokens", 0) >= 0
    AND COALESCE("cache_read_tokens", 0) >= 0
    AND COALESCE("cache_write_tokens", 0) >= 0
    AND COALESCE("reasoning_tokens", 0) >= 0
    AND COALESCE("cost_usd", 0) >= 0 AND "worst_case_usd" >= 0
    AND "latency_ms" >= 0),
  CONSTRAINT "ai_run_http_status_valid"
    CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599),
  CONSTRAINT "ai_run_fallback_matches_attempt" CHECK (
    ("attempt" = 1 AND "fallback_from" IS NULL)
    OR ("attempt" > 1
        AND "fallback_from" IS NOT NULL
        AND "fallback_from" IN ('timeout', 'rate-limited', 'provider-error')))
);

CREATE UNIQUE INDEX "ai_run_request_id_attempt_key" ON "ai_run"("request_id", "attempt");
CREATE INDEX "ai_run_started_at_idx" ON "ai_run"("started_at");
CREATE INDEX "ai_run_encounter_id_idx" ON "ai_run"("encounter_id");

CREATE TABLE "ai_exchange" (
  "ai_run_id" UUID NOT NULL,
  "system"    TEXT NOT NULL,
  "prompt"    TEXT NOT NULL,
  "raw"       TEXT,

  CONSTRAINT "ai_exchange_pkey" PRIMARY KEY ("ai_run_id"),
  CONSTRAINT "ai_exchange_ai_run_id_fkey" FOREIGN KEY ("ai_run_id")
    REFERENCES "ai_run"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

COMMIT;
