-- patient_name_spanish_collation
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA: que ordenar el listado de pacientes por nombre siga usando un
-- índice, y no una ordenación completa en memoria.
--
-- POR QUÉ HACE FALTA. La base está creada con colación `C`, que ordena por
-- byte: `Zambrano` queda antes que `alvarez` y `Ñaupa` cae detrás de todo. En
-- Ecuador eso es un apellido que nadie encuentra en la lista, así que la
-- consulta ordena con `COLLATE "es-ES-x-icu"`, que pone la Ñ entre la N y la O.
--
-- El problema es que un índice B-tree sólo sirve para un ORDER BY con SU MISMA
-- colación. El índice que Prisma crea sobre (family_name, given_name) usa la
-- de la base, así que con la colación española PostgreSQL lo ignora y ordena
-- la tabla entera. Con cinco pacientes de prueba no se nota; con cincuenta mil
-- historias, cada búsqueda ordena cincuenta mil filas.
--
-- No se cambia la colación de la base entera: obligaría a recrearla y
-- reindexarla, y hay comparaciones donde el orden byte a byte es el correcto y
-- el más rápido. Se declara donde se ordena para que lo lea una persona.

CREATE INDEX patient_name_es_collation
  ON patient (
    family_name COLLATE "es-ES-x-icu",
    given_name COLLATE "es-ES-x-icu"
  );

COMMENT ON INDEX patient_name_es_collation IS
  'Sirve el ORDER BY del listado de pacientes, que usa es-ES-x-icu para que la '
  'Ñ quede entre la N y la O. Un índice con otra colación no vale para esa '
  'ordenación: PostgreSQL lo ignoraría y ordenaría la tabla completa.';
