-- clinical_note_template
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (encounter/SPEC.md EN-200, EN-204; D-124).
--
-- 1. La plantilla de la nota de consulta es una serie de VERSIONES PUBLICADAS
--    e inmutables, por formulario y por especialidad (NULL = la de la
--    clínica). Publicar inserta la siguiente; nada se reescribe. Es el patrón
--    de `document_template`: una nota escrita con una versión tiene que poder
--    leerse con ESA versión para siempre.
-- 2. Cada nota guarda la versión con que se abrió (`clinical_note.template_id`)
--    y no la cambia nunca, ni siquiera en borrador: un borrador validado al
--    firmar con otra plantilla que la que se escribió es el fallo que esto
--    evita. NULL en las notas anteriores y en las escritas con la de serie.
--
-- No toca datos existentes: la columna nueva nace nula y no hay relleno.

CREATE TABLE "clinical_note_template" (
  "id"              uuid        NOT NULL DEFAULT uuidv7(),
  "form_code"       varchar(8)  NOT NULL,
  "specialty_id"    uuid,
  "version"         integer     NOT NULL,
  "sections"        jsonb       NOT NULL,
  "published_at"    timestamptz(6) NOT NULL,
  "published_by_id" uuid        NOT NULL,
  CONSTRAINT "clinical_note_template_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "clinical_note_template_specialty_fk" FOREIGN KEY ("specialty_id")
    REFERENCES "specialty" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "clinical_note_template_published_by_fk" FOREIGN KEY ("published_by_id")
    REFERENCES "app_user" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "clinical_note_template_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "clinical_note_template_sections_are_a_list"
    CHECK (jsonb_typeof("sections") = 'array' AND jsonb_array_length("sections") > 0)
);

-- EN-200. Dos versiones con el mismo número para la misma especialidad —o
-- para la de la clínica, cuya especialidad es NULL— no pueden existir.
CREATE UNIQUE INDEX "clinical_note_template_version_unique"
  ON "clinical_note_template" ("form_code", "specialty_id", "version")
  NULLS NOT DISTINCT;

CREATE OR REPLACE FUNCTION clinical_note_template_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'clinical_note_template is insert-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'A template version is what a note was written with (EN-204). '
                 'Publish a NEW version instead; the current one is the highest.';
END;
$$;

CREATE TRIGGER "trg_clinical_note_template_append_only"
  BEFORE UPDATE OR DELETE ON "clinical_note_template"
  FOR EACH ROW
  EXECUTE FUNCTION clinical_note_template_insert_only();

CREATE TRIGGER "trg_clinical_note_template_no_truncate"
  BEFORE TRUNCATE ON "clinical_note_template"
  FOR EACH STATEMENT
  EXECUTE FUNCTION clinical_note_template_insert_only();

ALTER TABLE "clinical_note" ADD COLUMN "template_id" uuid;
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_template_fk"
  FOREIGN KEY ("template_id") REFERENCES "clinical_note_template" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX "clinical_note_template_id_idx" ON "clinical_note" ("template_id");

-- EN-204. La plantilla de una nota es la de su formulario, y no cambia.
CREATE OR REPLACE FUNCTION clinical_note_template_is_fixed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.template_id IS DISTINCT FROM OLD.template_id THEN
    RAISE EXCEPTION 'the template of clinical note % cannot change', OLD.id
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'A note is validated and shown with the template it was opened with (EN-204).';
  END IF;

  IF NEW.template_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM clinical_note_template t
     WHERE t.id = NEW.template_id AND t.form_code = NEW.form_code
  ) THEN
    RAISE EXCEPTION 'template % is not a template of form %', NEW.template_id, NEW.form_code
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_clinical_note_template_is_fixed"
  BEFORE INSERT OR UPDATE OF "template_id", "form_code" ON "clinical_note"
  FOR EACH ROW
  EXECUTE FUNCTION clinical_note_template_is_fixed();
