-- patient_identifier_follows_merge
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EL DOCUMENTO SIGUE A LA PERSONA, Y LA BASE TIENE QUE SABERLO (PA-014, P4)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL DEFECTO. Al fusionar A en B, el disparador `trg_patient_sync_merged`
-- saca la cédula de A del índice único parcial —correcto y querido, PA-014—
-- pero NADA la llevaba a B. `merge()` escribía sólo `patient.merged_into_id`
-- y la fila del rastro, así que al día siguiente el paciente volvía, en el
-- mostrador se tecleaba su cédula y `findByIdentifier` —que filtra
-- `merged_into_id IS NULL`— no devolvía NADA. El alta no veía duplicado, el
-- índice ya no lo impedía, y se abría una TERCERA ficha con la misma cédula.
-- A partir de ahí deshacer respondía `MERGE_UNDO_CONFLICT` para siempre: la
-- fusión quedaba irreversible en la práctica, que es justo lo que REQ-010 y
-- PA-047 existen para evitar.
--
-- Y no era una decisión abierta: la entrega P4 del `SPEC.md` ya lo pedía
-- literalmente —«comprobar que la cédula de A deja de bloquear el índice único
-- Y QUE B LA CONSERVA»—. Faltaba la implementación, y faltaba esto.
--
-- LO QUE FALTABA EN LA BASE. La corrección mueve las filas de
-- `patient_identifier` de uso `OFFICIAL` a la ficha superviviente, y ninguno
-- de los dos disparadores que mantienen la bandera desnormalizada cubría ese
-- movimiento:
--
--   * `trg_patient_sync_merged` es `AFTER UPDATE OF merged_into_id ON patient`
--     — mira la FICHA, no la fila del documento.
--   * `trg_patient_identifier_set_merged` era `BEFORE INSERT` y sólo `INSERT`.
--
-- Comprobado contra PostgreSQL 18 antes de escribir una línea de esta
-- migración: tras fusionar A→B y mover la fila, `patient_merged` se quedaba en
-- `true` sobre una fila que ya pertenecía a B, que está ACTIVA. La fila seguía
-- fuera del índice único parcial y una tercera ficha con esa misma cédula era
-- ACEPTADA — el defecto seguía en pie después de la corrección, y SC-008
-- («el número de fichas activas que comparten un documento es cero, sin
-- excepción») dejaba de ser cierto.
--
-- Después: pnpm migrations:check && pnpm db:deploy


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. LA BANDERA SIGUE A LA FILA CUANDO LA FILA CAMBIA DE FICHA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ ESTA MIGRACIÓN DEROGA LO QUE AFIRMA LA §6 DE
-- `20260817204801_patient_merge_events`. Aquel comentario decía:
--
--     «SÓLO EN `INSERT`. `patient_id` no cambia nunca —D-031: las filas hijas
--      no se repuntan, la superviviente lee por el enlace—, así que un
--      `UPDATE` de esa columna no es un caso que haya que cubrir, sino uno que
--      no debe existir.»
--
-- Era exacto sobre D-031 y equivocado sobre el alcance de D-031, y esa
-- confusión es la que produjo el defecto. Se corrige aquí y no se deja al
-- lado: un comentario que contradice al código es peor que ninguno.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ ESTO NO CONTRADICE A D-031
-- ---------------------------------------------------------------------------
--
-- D-031 decide qué pasa con la HISTORIA CLÍNICA de la ficha absorbida: citas,
-- atenciones, certificados, derivaciones, alergias, contactos, grupos
-- prioritarios, lista de espera. Esa historia NO SE MUEVE y se lee por el
-- enlace, porque repuntarla sería reescribir el pasado y porque una cita
-- creada DESPUÉS de la fusión no debe volver al deshacer. Nada de eso cambia,
-- y `linkedRecords` sigue contándolo fila por fila para que sea comprobable.
--
-- UN DOCUMENTO DE IDENTIDAD NO ES HISTORIA. No es algo que le OCURRIÓ a la
-- persona: es CÓMO SE LA ENCUENTRA. Consolidarlo no reescribe ningún pasado —
-- la cédula es la misma cédula de la misma persona— y es el propósito entero
-- de fusionar: que en el mostrador se teclee ese número y salga la ficha
-- vigente. Una fusión que deja el documento en la ficha muerta no ha unificado
-- nada; ha escondido a la persona.
--
-- Por eso las filas hijas se quedan y ésta se mueve, y por eso deshacer la
-- devuelve: `patient_identifier` es la única tabla hija cuyo `patient_id`
-- cambia en una fusión, y este disparador es lo que hace que ese cambio no
-- pueda dejar el índice único mintiendo.
--
-- `CREATE OR REPLACE TRIGGER` Y NO `DROP` + `CREATE`: PostgreSQL 14 en
-- adelante lo sustituye en una sola sentencia, sin una ventana en la que la
-- tabla se quede sin disparador. La función no cambia — sigue leyendo la ficha
-- a la que la fila PERTENECE, que es exactamente la pregunta correcta antes y
-- después del movimiento—; lo que cambia es cuándo se le pregunta.

CREATE OR REPLACE TRIGGER trg_patient_identifier_set_merged
  BEFORE INSERT OR UPDATE OF "patient_id" ON "patient_identifier"
  FOR EACH ROW
  EXECUTE FUNCTION set_patient_identifier_merged();

COMMENT ON TRIGGER trg_patient_identifier_set_merged ON "patient_identifier" IS
  'PA-014, PA-043. Mantiene patient_merged coherente con la ficha a la que la '
  'fila PERTENECE, en los dos momentos en que esa ficha puede cambiar: al '
  'insertar el documento, y al MOVERLO a la superviviente durante una fusión. '
  'El movimiento no contradice a D-031: aquella decisión es sobre la historia '
  'clínica, que no se mueve; un documento de identidad no es historia, es '
  'cómo se encuentra a la persona. Ver la migración '
  '20260817222356_patient_identifier_follows_merge.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. EL COMENTARIO DE LA COLUMNA, QUE HABÍA DEJADO DE SER EXACTO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Decía «No se escribe a mano», y sigue siendo cierto en lo que importaba —
-- ninguna capa de la aplicación asigna esta columna— pero se quedaba corto en
-- lo demás: enumeraba dos disparadores y dos momentos, y ahora son tres
-- momentos. Enumerar mal es peor que no enumerar, porque quien lo lee deja de
-- buscar.

COMMENT ON COLUMN "patient_identifier"."patient_merged" IS
  'PA-014. Copia desnormalizada de «la ficha a la que esta fila pertenece está '
  'fusionada», porque el predicado de patient_identifier_active_unique no '
  'admite subconsultas. La mantienen trg_patient_identifier_set_merged (al '
  'insertar la fila Y al moverla de ficha durante una fusión) y '
  'trg_patient_sync_merged (al fusionar y al deshacer la ficha entera). LA '
  'APLICACIÓN NUNCA LA ESCRIBE: escribirla a mano es cómo se desincroniza del '
  'índice, y el índice es SC-008.';
