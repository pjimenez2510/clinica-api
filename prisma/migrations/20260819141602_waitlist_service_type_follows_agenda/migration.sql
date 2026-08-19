-- waitlist_service_type_follows_agenda
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LA LISTA DE ESPERA Y LA CITA HABLAN DEL MISMO TIPO DE ATENCIÓN (AG-060, AG-061)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `waitlist_entry.service_type_concept_id` nació en
-- `20260806022931_clinical_core` apuntando a `catalog_concept`, el catálogo
-- clínico del MSP. La cita hizo lo mismo y se corrigió con C4
-- (`20260812222827_configuration_specialties_and_durations`, SP-028): el tipo
-- de atención con su duración es dato maestro PROPIO de la clínica —
-- `service_type`, SP-020, D-010— y `agenda_entry.service_type_id` pasó a
-- apuntar ahí. La lista de espera no siguió.
--
-- QUÉ ROMPÍA. AG-061 propone los candidatos «compatibles» con un cupo
-- liberado, y compatible incluye «mismo tipo de servicio» cuando la entrada lo
-- fija. Con las dos columnas apuntando a tablas distintas esa comparación no
-- podía ser cierta NUNCA: ningún identificador de `service_type` existe en
-- `catalog_concept`, así que la inscripción sólo podía rechazar por clave
-- foránea todo tipo legítimo. Por eso E5 se cerró sin admitir el campo, con la
-- nota `> **Falta esquema.**` junto a AG-060: un campo que parece funcionar y
-- sólo puede fallar es peor que un campo ausente.
--
-- POR QUÉ SE MUEVE Y NO SE APILA OTRA COLUMNA. `scripts/database-phase.mjs`
-- declara `development`, no hay ninguna instalación en producción y
-- `waitlist_entry` está VACÍA: nadie se ha inscrito desde que E5 cerró ayer.
-- Corregir el modelo hoy cuesta esta migración; arrastrarlo cuesta una segunda
-- columna que nadie sabría cuál de las dos es la buena. Es la misma decisión
-- que C4 tomó con `agenda_entry`, aplicada a la tabla que se quedó atrás.
--
-- NO HAY MIGRACIÓN DE DATOS, y no falta: la columna que se va no tiene una
-- sola fila no nula que trasladar, y trasladarla sería imposible de todos
-- modos — un concepto del MSP no tiene equivalente en el catálogo de la
-- clínica.

ALTER TABLE waitlist_entry
  DROP CONSTRAINT waitlist_entry_service_type_concept_id_fkey;

ALTER TABLE waitlist_entry
  DROP COLUMN service_type_concept_id;

-- `ON DELETE RESTRICT` es lo mismo que produce SP-025 en `agenda_entry`, por
-- el mismo motivo: borrar un tipo que alguien espera dejaría la entrada
-- diciendo que espera algo que ya no existe, y la base es quien lo arbitra —
-- dos administradores borrando e inscribiendo en el mismo milisegundo leen
-- ambos «no hay nadie esperándolo».
ALTER TABLE waitlist_entry
  ADD COLUMN service_type_id uuid
    REFERENCES service_type (id) ON DELETE RESTRICT;

-- Sin él, cada borrado de un tipo de atención recorre `waitlist_entry` entera
-- para decidir si alguna entrada lo espera — y es PostgreSQL quien lo recorre,
-- en cada DELETE. PARCIAL porque una entrada sin tipo significa «cualquiera»
-- (AG-060) y esas filas no responden a ninguna pregunta que este índice
-- conteste. Gemelo de `agenda_entry_by_service_type`; Prisma no puede
-- describir el predicado, así que `migrations:check` lo protege.
CREATE INDEX waitlist_entry_by_service_type
  ON waitlist_entry (service_type_id)
  WHERE service_type_id IS NOT NULL;
