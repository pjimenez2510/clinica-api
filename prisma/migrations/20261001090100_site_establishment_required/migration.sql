-- site_establishment_required
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (OR-032, DOC-102; decidido en fix/certificado-d105):
--
-- Toda sede pertenece a un establecimiento. La columna era nula sólo para
-- que sobrevivieran las filas anteriores a `establishment`, y la consecuencia
-- se vio en la evidencia de F-05: `createSite` y `seed-agenda.mts` creaban
-- sedes huérfanas, nada las enlazaba después, y los documentos imprimían el
-- nombre de la sede como nombre de la clínica.
--
-- LAS HUÉRFANAS SE ENLAZAN SÓLO SI NO HAY DUDA: con exactamente un
-- establecimiento, que es la clínica. Con cero o con varios, la migración
-- se detiene y lo dice, en vez de inventar a qué clínica pertenece una sede.

UPDATE "site"
   SET "establishment_id" = (SELECT "id" FROM "establishment")
 WHERE "establishment_id" IS NULL
   AND (SELECT count(*) FROM "establishment") = 1;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "site" WHERE "establishment_id" IS NULL) THEN
    RAISE EXCEPTION 'site_establishment_required: hay sedes sin establecimiento y no hay exactamente uno al que enlazarlas; enlácelas a mano antes de migrar';
  END IF;
END $$;

ALTER TABLE "site" ALTER COLUMN "establishment_id" SET NOT NULL;
