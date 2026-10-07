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
--    cédula) los recoge D-145. Las contraseñas y los secretos del segundo
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
  'D-017, D-145 (AD-10). Lista blanca de tipos de recurso que pueden llevar '
  'valor anterior y posterior: configuración y administración. Ningún recurso '
  'de paciente: esta tabla vigila quién mira la historia, es de solo inserción '
  'y no se purga.';
