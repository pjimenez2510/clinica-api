-- violence_screening_history
--
-- Revisión de `feat/f04-tamizaje-violencia`: lo que el bloque F no puede
-- perder, garantizado por la base y no por la aplicación.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. TIPOS SIN REPETIR (EN-071)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `{PHYSICAL,PHYSICAL}` contaría dos veces el mismo tipo en el RDACAA.
CREATE FUNCTION violence_types_are_distinct(types violence_type[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT COALESCE(cardinality(types), 0)
       = (SELECT count(DISTINCT t) FROM unnest(types) AS t)
$$;

ALTER TABLE "violence_screening"
  ADD CONSTRAINT "violence_screening_types_distinct"
  CHECK (violence_types_are_distinct("types"));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. LA RESPUESTA ANTERIOR NO SE PIERDE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Corregir el tamizaje lo sobrescribe en su fila; sin esto, un «sin signos»
-- puesto encima de un «confirmado» con su formulario 094 borraría el hallazgo
-- sin rastro. Cada UPDATE archiva la fila ENTERA que reemplaza, con quién la
-- reemplazó, en una tabla propia.
--
-- ⚠️ NO VA EN `record_version`: la exportación al titular la lee (PD-040), y
-- lo que ve el paciente de esto está pendiente (D-188 §3). Esta tabla sólo la
-- lee la puerta del tamizaje; hoy, nadie.
CREATE TABLE "violence_screening_version" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "encounter_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "data" JSONB NOT NULL,
  "replaced_by_id" UUID NOT NULL,
  "replaced_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "violence_screening_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "violence_screening_version_unique" UNIQUE ("encounter_id", "version"),
  CONSTRAINT "violence_screening_version_encounter_fkey"
    FOREIGN KEY ("encounter_id") REFERENCES "violence_screening"("encounter_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "violence_screening_version_replaced_by_fkey"
    FOREIGN KEY ("replaced_by_id") REFERENCES "practitioner"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

COMMENT ON TABLE "violence_screening_version" IS
  'EN-070, EN-076. Respuestas anteriores del tamizaje de violencia, archivadas '
  'por trg_violence_screening_guard en cada corrección. DATO DE ACCESO '
  'RESTRINGIDO: fuera de record_version a propósito (D-188 §3).';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. SÓLO CON LA ATENCIÓN VIVA, Y NUNCA SE BORRA (EN-130)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Responder o corregir el tamizaje es contenido nuevo: con la atención de alta,
-- cerrada, interrumpida o anulada, se rechaza aunque quien escriba no pase por
-- el servicio. Borrar la fila nunca: «sin responder» no es una corrección.
-- `screened_at` es el instante de la APLICACIÓN (lo trae la fila nueva), nunca
-- `now()` de la base: los recorridos mueven el reloj de la API.
CREATE FUNCTION violence_screening_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  encounter_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'violence_screening_immutable: a screening is corrected, never deleted';
  END IF;

  SELECT e.status::text INTO encounter_status
    FROM encounter e WHERE e.id = NEW.encounter_id;
  IF encounter_status IS DISTINCT FROM 'OPEN'
     AND encounter_status IS DISTINCT FROM 'ON_HOLD' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'violence_screening_frozen: the attention no longer accepts new content';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    INSERT INTO violence_screening_version
      (encounter_id, version, data, replaced_by_id, replaced_at)
    SELECT OLD.encounter_id,
           COALESCE(MAX(v.version), 0) + 1,
           to_jsonb(OLD),
           NEW.screened_by_id,
           NEW.screened_at
      FROM violence_screening_version v
     WHERE v.encounter_id = OLD.encounter_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_violence_screening_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "violence_screening"
  FOR EACH ROW EXECUTE FUNCTION violence_screening_guard();
