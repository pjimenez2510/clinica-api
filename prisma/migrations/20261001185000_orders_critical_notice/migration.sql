-- ════════════════════════════════════════════════════════════════════════════
-- LA CONSTANCIA DEL AVISO DE UN VALOR CRÍTICO, Y QUIÉN RESPONDE DE LAS COLAS
-- ORD-046, ORD-062 a ORD-065 · D-050 §2 y §4 · A.M. 00002393 art. 39
-- ════════════════════════════════════════════════════════════════════════════
--
-- El art. 39 obliga a informar «de manera urgente al médico tratante y/o al
-- usuario» de un valor de alerta, y el aviso telefónico es un ACTO CLÍNICO
-- (D-050 §2): sin constancia no se puede demostrar que ocurrió. Hasta hoy no
-- había dónde guardarla, y la cola de críticos no se podía vaciar.

-- CreateEnum
CREATE TYPE "CriticalNoticeRecipient" AS ENUM (
  'ORDERING_PRACTITIONER',
  'OTHER_PRACTITIONER',
  'PATIENT',
  'REPRESENTATIVE'
);

-- CreateEnum
CREATE TYPE "CriticalNoticeChannel" AS ENUM ('PHONE', 'IN_PERSON', 'VIDEO_CALL');

-- CreateTable
CREATE TABLE "critical_result_notice" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "observation_result_id" BIGINT NOT NULL,
  "recipient_kind" "CriticalNoticeRecipient" NOT NULL,
  "recipient_name" VARCHAR(200) NOT NULL,
  "channel" "CriticalNoticeChannel" NOT NULL,
  -- Quién avisó: la cuenta de la sesión, nunca un campo del cuerpo (ORD-062).
  "notified_by_id" UUID NOT NULL,
  -- Cuándo ocurrió la llamada, que puede ser antes de anotarla: la de las
  -- 03:00 se registra a las 08:00 y la constancia tiene que decir las 03:00.
  "notified_at" TIMESTAMPTZ(6) NOT NULL,
  "note" VARCHAR(500),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "critical_result_notice_pkey" PRIMARY KEY ("id"),
  -- Un nombre en blanco es una constancia de que se avisó a nadie.
  CONSTRAINT "critical_result_notice_recipient_named"
    CHECK (btrim("recipient_name") <> '')
  -- Que `notified_at` no sea futuro ni anterior al resultado lo juzga la
  -- aplicación (CRITICAL_NOTICE_TIME_INVALID): un CHECK contra `created_at`
  -- dependería de que el reloj de la API y el de la base coincidan.
);

-- CreateIndex
CREATE INDEX "critical_result_notice_observation_result_id_idx"
  ON "critical_result_notice"("observation_result_id");

-- AddForeignKey
ALTER TABLE "critical_result_notice"
  ADD CONSTRAINT "critical_result_notice_observation_result_id_fkey"
  FOREIGN KEY ("observation_result_id") REFERENCES "observation_result"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "critical_result_notice"
  ADD CONSTRAINT "critical_result_notice_notified_by_id_fkey"
  FOREIGN KEY ("notified_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ORD-064. NI SE REESCRIBE NI SE BORRA. Una constancia que se puede cambiar no
-- prueba nada; el aviso mal anotado se corrige registrando otro.
--
-- Disparador y no `REVOKE`: la aplicación conecta como propietaria de la tabla
-- y un propietario conserva sus privilegios aunque se le revoquen.
CREATE OR REPLACE FUNCTION critical_result_notice_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'critical_result_notice is append-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'El aviso de un valor crítico no se borra ni se reescribe: si '
                 'se anotó mal, se registra otro.';
END;
$$;

CREATE TRIGGER trg_critical_result_notice_append_only
  BEFORE UPDATE OR DELETE ON "critical_result_notice"
  FOR EACH ROW
  EXECUTE FUNCTION critical_result_notice_append_only();

-- `TRUNCATE` no dispara los `FOR EACH ROW`: necesita el suyo.
CREATE TRIGGER trg_critical_result_notice_no_truncate
  BEFORE TRUNCATE ON "critical_result_notice"
  FOR EACH STATEMENT
  EXECUTE FUNCTION critical_result_notice_append_only();

-- ════════════════════════════════════════════════════════════════════════════
-- LA POLÍTICA DE CADA SEDE (ORD-046, ORD-063, ORD-065)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Los críticos: plazo y rol de escalado VACÍOS DE FÁBRICA. Un plazo por
-- defecto convertiría «la clínica no lo ha decidido» en «va bien» o en «va
-- tarde» (el argumento de ORD-022); qué valor deberían traer es D-111.
--
-- Los sin orden: D-050 §4 sí fijó el defecto —el médico que pidió el examen,
-- con 24 h—, así que el rol es nulo (= quien pidió) y el plazo nace en 24.
ALTER TABLE "site_parameter"
  ADD COLUMN "critical_notice_within_minutes" SMALLINT,
  ADD COLUMN "critical_escalation_role_id" UUID,
  ADD COLUMN "unmatched_result_owner_role_id" UUID,
  ADD COLUMN "unmatched_result_deadline_hours" SMALLINT NOT NULL DEFAULT 24,
  -- De 5 minutos a un día: por debajo es ruido, por encima deja de ser
  -- «de manera urgente».
  ADD CONSTRAINT "site_parameter_critical_notice_within_minutes_range"
    CHECK ("critical_notice_within_minutes" IS NULL
           OR "critical_notice_within_minutes" BETWEEN 5 AND 1440),
  -- De una hora a una semana: un resultado que nadie ha visto en una semana
  -- ya no está en una cola, está perdido.
  ADD CONSTRAINT "site_parameter_unmatched_result_deadline_hours_range"
    CHECK ("unmatched_result_deadline_hours" BETWEEN 1 AND 168);

-- RESTRICT y no SET NULL: borrar el rol que responde de una cola no puede
-- devolverla en silencio a otra persona.
ALTER TABLE "site_parameter"
  ADD CONSTRAINT "site_parameter_critical_escalation_role_id_fkey"
  FOREIGN KEY ("critical_escalation_role_id") REFERENCES "role"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_parameter"
  ADD CONSTRAINT "site_parameter_unmatched_result_owner_role_id_fkey"
  FOREIGN KEY ("unmatched_result_owner_role_id") REFERENCES "role"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
