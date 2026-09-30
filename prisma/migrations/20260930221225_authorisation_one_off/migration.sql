-- authorisation_one_off
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA (AU-042, D-062 punto 2): que una concesión única de
-- `syncAuthorisation` ocurra UNA vez por base. La fila la escribe la misma
-- transacción que concede; si ya existe, no se concede nada.
--
-- POR QUÉ UNA TABLA. «Una vez» no se deduce de las concesiones: un permiso que
-- a un rol le falta puede no habérsele dado nunca o habérselo quitado la
-- clínica, y sólo lo segundo es una decisión que respetar. Tampoco del
-- catálogo: `background:write` ya existe en toda base sincronizada desde
-- `feat/f03-preparacion`, así que la regla de código nuevo de D-012 no vuelve
-- a disparar. Sin esta fila, repetir la concesión en cada despliegue
-- devolvería lo que una clínica quitó.

--
-- `granted` guarda qué se concedió (`ROL → permiso`): cambia quién escribe en
-- la historia clínica, y una auditoría tiene que poder preguntar desde cuándo
-- un rol registra alergias sin depender de la consola de un despliegue.

CREATE TABLE "authorisation_one_off" (
  "name" VARCHAR(64) NOT NULL,
  "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "granted" TEXT[] NOT NULL DEFAULT '{}',

  CONSTRAINT "authorisation_one_off_pkey" PRIMARY KEY ("name")
);
