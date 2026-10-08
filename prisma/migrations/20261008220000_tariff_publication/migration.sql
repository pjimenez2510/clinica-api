-- tariff_publication
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-110 A BI-115: EL TARIFARIO QUE SE EXHIBE AL PÚBLICO (LOS art. 184)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La publicación es una FOTO de la lista particular el día en que se publicó:
-- los precios, los nombres, la categoría y el IVA se COPIAN, no se
-- referencian. Si leyera `price`, el cartel cambiaría solo al editar una fila
-- y BI-115 —«la publicada quedó desactualizada»— no podría existir; y la
-- pregunta de un reclamo, «¿qué decía el cartel el día que atendieron a mi
-- madre?», tendría por respuesta lo que dice hoy.
--
-- Por eso las dos tablas son de SOLO INSERCIÓN (BI-113: se conservan las
-- anteriores). Publicar otra vez es una fila nueva con la versión siguiente.
--
-- Y por eso la vista pública lee ESTAS tablas y nunca `price` (BI-112): no hay
-- consulta a la tabla de precios general detrás de la ruta abierta, así que
-- ningún parámetro puede desviarla a la lista de un convenio.

CREATE TABLE "tariff_publication" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  -- 1, 2, 3… en el orden en que se publicaron. La asigna el servicio bajo el
  -- candado de la lista; el índice único es la garantía si dos administradores
  -- pulsan a la vez.
  "version" INTEGER NOT NULL,

  -- El día, en Ecuador, desde el que rige lo publicado.
  "effective_from" DATE NOT NULL,

  -- El instante con el reloj de la aplicación, no `now()` de PostgreSQL: los
  -- recorridos mueven el de la aplicación.
  "published_at" TIMESTAMPTZ(6) NOT NULL,
  "published_by" UUID NOT NULL,

  -- La lista de la que salió (la del pagador particular, BI-111). Sólo para
  -- la trazabilidad interna: la vista pública no la devuelve.
  "price_list_id" UUID NOT NULL,

  -- El nombre con que la clínica firma el cartel, copiado como el resto. NULL
  -- en una instalación sin establecimiento configurado.
  "establishment_name" VARCHAR(160),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tariff_publication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tariff_publication_version_positive" CHECK ("version" > 0),
  CONSTRAINT "tariff_publication_published_by_fk"
    FOREIGN KEY ("published_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "tariff_publication_price_list_fk"
    FOREIGN KEY ("price_list_id") REFERENCES "price_list"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "tariff_publication_version_unique"
  ON "tariff_publication" ("version");

CREATE TABLE "tariff_publication_item" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "publication_id" UUID NOT NULL,

  -- Para comparar con lo vigente (BI-115); lo que se exhibe es lo copiado.
  "billable_service_id" UUID NOT NULL,

  "service_code"  VARCHAR(32)  NOT NULL,
  "service_name"  VARCHAR(200) NOT NULL,
  "category_name" VARCHAR(120) NOT NULL,

  -- Decimal, nunca float (BI-001). Sin IVA, como en la lista.
  "amount" DECIMAL(12, 2) NOT NULL,

  -- El porcentaje de IVA que se exhibe junto al precio. NULL si la tarifa del
  -- SRI no lleva porcentaje (no objeto, exento).
  "tax_percentage" DECIMAL(5, 2),

  CONSTRAINT "tariff_publication_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tariff_publication_item_publication_fk"
    FOREIGN KEY ("publication_id") REFERENCES "tariff_publication"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "tariff_publication_item_service_fk"
    FOREIGN KEY ("billable_service_id") REFERENCES "billable_service"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "tariff_publication_item_amount_not_negative" CHECK ("amount" >= 0)
);

-- Una prestación aparece una vez por publicación.
CREATE UNIQUE INDEX "tariff_publication_item_service_unique"
  ON "tariff_publication_item" ("publication_id", "billable_service_id");

-- ── Y no se reescribe (BI-113) ─────────────────────────────────────────────
CREATE FUNCTION tariff_publication_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'tariff_publication_immutable: a published tariff cannot be altered (table %, operation %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'BI-113: publish again; the previous versions are what the '
                 'wall said on their day.';
END;
$$;

CREATE TRIGGER "trg_tariff_publication_immutable"
  BEFORE UPDATE OR DELETE ON "tariff_publication"
  FOR EACH ROW
  EXECUTE FUNCTION tariff_publication_insert_only();

CREATE TRIGGER "trg_tariff_publication_no_truncate"
  BEFORE TRUNCATE ON "tariff_publication"
  FOR EACH STATEMENT
  EXECUTE FUNCTION tariff_publication_insert_only();

CREATE TRIGGER "trg_tariff_publication_item_immutable"
  BEFORE UPDATE OR DELETE ON "tariff_publication_item"
  FOR EACH ROW
  EXECUTE FUNCTION tariff_publication_insert_only();

CREATE TRIGGER "trg_tariff_publication_item_no_truncate"
  BEFORE TRUNCATE ON "tariff_publication_item"
  FOR EACH STATEMENT
  EXECUTE FUNCTION tariff_publication_insert_only();
