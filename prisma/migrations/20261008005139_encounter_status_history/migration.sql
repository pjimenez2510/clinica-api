-- encounter_status_history
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- EN-133: CADA CAMBIO DE ESTADO DE LA ATENCIÓN, CON SU HECHO, QUIÉN Y CUÁNDO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `encounter.status` sólo dice dónde está la atención AHORA. No dice cuánto
-- esperó el paciente entre abrirla y el alta, ni quién la dejó a medias. Esta
-- tabla es ese historial, y no se edita ni se borra.
--
-- POR QUÉ LA ESCRIBE UN DISPARADOR Y NO EL SERVICIO. Hoy cambian el estado
-- cuatro caminos: la firma de la 002 (alta), el cierre de la cuenta, la salida
-- (anular, interrumpir) y la agenda cuando el paciente se va sin ser visto
-- —este último en OTRO módulo—. Un historial que depende de que cada camino se
-- acuerde de escribirlo es el que tiene huecos, y el día que alguien añada un
-- quinto camino sin leer el SPEC el hueco no avisa.
--
-- DE DÓNDE SALEN EL QUIÉN Y EL CUÁNDO. De las constancias que cada transición
-- YA escribe en la misma sentencia, todas con el reloj de la aplicación (los
-- recorridos mueven ese reloj; `now()` de PostgreSQL no se mueve con él):
--
--   alta al abrir    → `opened_by_id` (nuevo, lo pone el servicio), `created_at`
--   OPEN → DISCHARGED → quien firmó la 002 y su `signed_at` (= `ended_at`)
--   → COMPLETED      → `closed_by_id` (profesional) y `closed_at`
--   → DISCONTINUED   → `discontinued_by_id`, `discontinued_at` (EN-167)
--   → ENTERED_IN_ERROR → `entered_in_error_by_id`, `entered_in_error_at` (EN-166)
--
-- Las transiciones sin constancia propia (`ON_HOLD` y su vuelta, que ninguna
-- ruta produce hoy) quedan con el hecho y sin autor, y el instante de
-- `updated_at`, antes que inventar uno.
--
-- EL HECHO ES EL DOCUMENTO QUE LO PRODUJO. Con EN-134 el estado no se teclea:
-- cada transición tiene exactamente un hecho, y guardarlo es lo que permite a
-- SC-027 contar que el estado se derivó de documentar.
--
-- LAS ATENCIONES ANTERIORES NO TIENEN HISTORIAL, y no se reconstruye (D-177.4):
-- el cierre de la cuenta sobrescribe `closed_by_id`, así que reconstruir el
-- alta inventaría quién firmó. NO SE TOCA NINGUNA FILA GUARDADA: la columna
-- nueva es nula y ningún UPDATE la rellena.

ALTER TABLE "encounter" ADD COLUMN "opened_by_id" UUID;

ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_opened_by_fk"
  FOREIGN KEY ("opened_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TYPE "encounter_status_fact" AS ENUM (
  'OPENED',
  'NOTE_SIGNED',
  'ACCOUNT_CLOSED',
  'INTERRUPTED',
  'ANNULLED',
  'PUT_ON_HOLD',
  'RESUMED'
);

CREATE TABLE "encounter_status_history" (
  "id"            BIGSERIAL PRIMARY KEY,
  "encounter_id"  UUID NOT NULL,
  "from_status"   "encounter_status",
  "to_status"     "encounter_status" NOT NULL,
  "fact"          "encounter_status_fact" NOT NULL,
  "changed_by_id" UUID,
  "changed_at"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "encounter_status_history_encounter_fk"
    FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "encounter_status_history_actor_fk"
    FOREIGN KEY ("changed_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  -- Abrir es la única fila sin estado de origen, y la única que lo es.
  CONSTRAINT "encounter_status_history_origin" CHECK (
    ("from_status" IS NULL) = ("fact" = 'OPENED')
  )
);

-- Por el ORDEN EN QUE OCURRIERON (`id`), no por su instante: una constancia
-- puede llevar un instante anterior al de la fila que la precede —la apertura
-- registra cuándo se escribió y la atención pudo darse antes (EN-034)—, y lo
-- que el historial cuenta es la secuencia.
CREATE INDEX "encounter_status_history_by_encounter"
  ON "encounter_status_history" ("encounter_id", "id");

-- ── El historial lo escribe la base ─────────────────────────────────────────
CREATE FUNCTION encounter_status_history_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_fact  "encounter_status_fact";
  v_by    UUID;
  v_at    TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "encounter_status_history"
      ("encounter_id", "from_status", "to_status", "fact", "changed_by_id", "changed_at")
    VALUES (NEW."id", NULL, NEW."status", 'OPENED', NEW."opened_by_id", NEW."created_at");
    RETURN NULL;
  END IF;

  IF OLD."status" IS NOT DISTINCT FROM NEW."status" THEN
    RETURN NULL;
  END IF;

  CASE NEW."status"
    WHEN 'DISCHARGED' THEN
      v_fact := 'NOTE_SIGNED';
      SELECT p."user_id", n."signed_at" INTO v_by, v_at
        FROM "clinical_note" n
        JOIN "practitioner" p ON p."id" = n."signed_by_id"
       WHERE n."encounter_id" = NEW."id"
         AND n."form_code" = '002'
         AND n."signed_at" IS NOT NULL
       ORDER BY n."signed_at" DESC, n."id" DESC
       LIMIT 1;
      v_at := COALESCE(NEW."ended_at", v_at);
    WHEN 'COMPLETED' THEN
      v_fact := 'ACCOUNT_CLOSED';
      SELECT p."user_id" INTO v_by FROM "practitioner" p WHERE p."id" = NEW."closed_by_id";
      v_at := NEW."closed_at";
    WHEN 'DISCONTINUED' THEN
      v_fact := 'INTERRUPTED';
      v_by := NEW."discontinued_by_id";
      v_at := NEW."discontinued_at";
    WHEN 'ENTERED_IN_ERROR' THEN
      v_fact := 'ANNULLED';
      v_by := NEW."entered_in_error_by_id";
      v_at := NEW."entered_in_error_at";
    WHEN 'ON_HOLD' THEN
      v_fact := 'PUT_ON_HOLD';
    WHEN 'OPEN' THEN
      v_fact := 'RESUMED';
  END CASE;

  INSERT INTO "encounter_status_history"
    ("encounter_id", "from_status", "to_status", "fact", "changed_by_id", "changed_at")
  VALUES (NEW."id", OLD."status", NEW."status", v_fact, v_by,
          COALESCE(v_at, NEW."updated_at"));
  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_encounter_status_history_open"
  AFTER INSERT ON "encounter"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_status_history_record();

CREATE TRIGGER "trg_encounter_status_history"
  AFTER UPDATE OF "status" ON "encounter"
  FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION encounter_status_history_record();

-- ── Y no se reescribe ──────────────────────────────────────────────────────
-- Su propia función y no la de `agenda_status_history`: el mensaje nombra la
-- tabla, y quien lo lea a las once de la noche lee el mensaje, no el catálogo.
CREATE FUNCTION encounter_status_history_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'encounter_status_history_immutable: the state trail of an attention cannot be altered (operation %)', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'EN-133: who changed the state of an attention, when and by '
                 'which act is a record, not a working table.';
END;
$$;

CREATE TRIGGER "trg_encounter_status_history_immutable"
  BEFORE UPDATE OR DELETE ON "encounter_status_history"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_status_history_insert_only();

CREATE TRIGGER "trg_encounter_status_history_no_truncate"
  BEFORE TRUNCATE ON "encounter_status_history"
  FOR EACH STATEMENT
  EXECUTE FUNCTION encounter_status_history_insert_only();
