-- admin_edit_in_place
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- D-127 EN ADMINISTRACIÓN (AD-3, AD-10 del inventario de fix/menos-preguntas)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. UN PRECIO MAL TECLEADO SE CORRIGE EN EL SITIO (BI-230).
--    Hasta hoy la única salida era abrir otro precio «desde» una fecha
--    POSTERIOR, así que el error de hoy se corregía mañana. El importe de una
--    fila vigente o futura pasa a editarse, y la base guarda la versión
--    anterior en `record_version` (EN-210) con quién y cuándo. Los cargos no
--    se mueven: congelan su importe en `charge_item.unit_amount` (BI-050).
--
--    El disparador salta SOLO cuando cambia el importe o el inicio. Cerrar la
--    fila al abrir la siguiente (BI-045) toca `valid_to` y no necesita sello:
--    eso no es corregir, es la vigencia que avanza.
--
-- 2. LA BITÁCORA GUARDA QUÉ HABÍA EN LAS EDICIONES ADMINISTRATIVAS (AD-10).
--    `access_audit_payload_only_for_declared_resources` admitía el antes y el
--    después solo en `configuration` (D-017). Se amplía a los recursos de
--    administración: personal, sedes, cuentas y roles, especialidades,
--    prestaciones, precios, pagadores y el catálogo de exámenes. NINGUNO es
--    de paciente: la historia clínica sigue fuera de la lista, que es lo que
--    D-017 protege. Los datos del personal que entran aquí (nombre, correo,
--    cédula) los recoge D-150. Las contraseñas y los secretos del segundo
--    factor no los manda nadie: cada rastro elige sus campos.
--
--    El CHECK se sustituye por otro más ancho. Toda fila existente cumple el
--    anterior, así que cumple este: la validación es una lectura.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ─── 1. precio con versión ────────────────────────────────────────────────

ALTER TABLE "price"
  ADD COLUMN "changed_by" UUID,
  ADD COLUMN "changed_at" TIMESTAMPTZ(6);

ALTER TABLE "price"
  ADD CONSTRAINT "price_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "price_change_stamped"
    CHECK (("changed_by" IS NULL) = ("changed_at" IS NULL));

CREATE TRIGGER "trg_price_record_version"
  BEFORE UPDATE ON "price"
  FOR EACH ROW
  WHEN (
    (OLD."amount", OLD."valid_from") IS DISTINCT FROM (NEW."amount", NEW."valid_from")
  )
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');

-- ─── 2. antes y después en la bitácora de administración ──────────────────

ALTER TABLE "access_audit"
  DROP CONSTRAINT "access_audit_payload_only_for_declared_resources",
  ADD CONSTRAINT "access_audit_payload_only_for_declared_resources"
  CHECK (
    ("before" IS NULL AND "after" IS NULL)
    OR "resource_type" IN (
      'configuration',
      'staff',
      'organization',
      'auth',
      'billable_service',
      'billable_service_category',
      'price',
      'payer',
      'exam_definition',
      'analyte_definition'
    )
  );

COMMENT ON CONSTRAINT "access_audit_payload_only_for_declared_resources"
  ON "access_audit" IS
  'D-017, D-150 (AD-10). Lista blanca de tipos de recurso que pueden llevar '
  'valor anterior y posterior: configuración y administración. Ningún recurso '
  'de paciente: esta tabla vigila quién mira la historia, es de solo inserción '
  'y no se purga.';

-- ─── 3. códigos que quedan fijos una vez usados (OR-034, OR-035, ORD-140) ──
--
-- El servicio pregunta «¿ya se usó?» antes de escribir, y responde con el
-- error de la SPEC. Pero entre su lectura y su UPDATE cabe una factura, una
-- atención o una orden — y la factura arma su número con el código del punto
-- de emisión LEÍDO EN VIVO, igual que la receta imprime el código MSP de la
-- sede. Lo que la base garantiza no depende de una lectura previa: estos
-- disparadores rechazan el cambio en la misma sentencia, también desde un
-- `psql` o una importación (revisión del 06-10-2026).

CREATE FUNCTION site_msp_unicode_fixed_once_used()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "encounter" WHERE "site_id" = OLD."id") THEN
    RAISE EXCEPTION 'site_msp_unicode_in_use: the site already has attentions carrying its MSP code'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'site_msp_unicode_in_use',
            HINT = 'El código MSP de una sede con atenciones no cambia (OR-034).';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_site_msp_unicode_fixed_once_used"
  BEFORE UPDATE OF "msp_unicode" ON "site"
  FOR EACH ROW
  WHEN (OLD."msp_unicode" IS DISTINCT FROM NEW."msp_unicode")
  EXECUTE FUNCTION site_msp_unicode_fixed_once_used();

CREATE FUNCTION emission_point_code_fixed_once_used()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "invoice" WHERE "emission_point_id" = OLD."id")
     OR EXISTS (SELECT 1 FROM "credit_note" WHERE "emission_point_id" = OLD."id") THEN
    RAISE EXCEPTION 'emission_point_code_in_use: the emission point already issued vouchers with its code'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'emission_point_code_in_use',
            HINT = 'El código de un punto de emisión que ya emitió no cambia (OR-035).';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_emission_point_code_fixed_once_used"
  BEFORE UPDATE OF "code" ON "emission_point"
  FOR EACH ROW
  WHEN (OLD."code" IS DISTINCT FROM NEW."code")
  EXECUTE FUNCTION emission_point_code_fixed_once_used();

CREATE FUNCTION exam_definition_code_fixed_once_ordered()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "service_order_item" WHERE "test_code" = OLD."code") THEN
    RAISE EXCEPTION 'exam_definition_code_in_use: an order line already froze this exam code'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'exam_definition_code_in_use',
            HINT = 'El código de un examen ya pedido no cambia (ORD-140).';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_exam_definition_code_fixed_once_ordered"
  BEFORE UPDATE OF "code" ON "exam_definition"
  FOR EACH ROW
  WHEN (OLD."code" IS DISTINCT FROM NEW."code")
  EXECUTE FUNCTION exam_definition_code_fixed_once_ordered();
