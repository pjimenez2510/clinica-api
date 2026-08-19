-- patient_merge_events
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LA FUSIÓN DE DUPLICADOS DEJA DE SER UNA PROMESA DEL DOCUMENTO (P4)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- PA-043 a PA-049, REQ-010. Esta migración va SOLA y antes de cualquier
-- servicio: la entrega P4 necesita esquema, y el procedimiento del repositorio
-- exige que el esquema vaya primero.
--
-- Lo que el `SPEC.md` de `patients` afirma hoy y la base NO garantiza:
--
--   1. «`patient_merge` es append-only» (PA-044). No hay ningún disparador que
--      lo impida. Es cierto sólo porque ninguna ruta escribe todavía en la
--      tabla — una convención, no una garantía.
--   2. «Toda fusión deja ficha origen, destino, AUTOR, instante y motivo»
--      (PA-044). `performed_by` admite NULL.
--   3. «Una ficha no puede fusionarse consigo misma» (PA-046). Las notas de
--      esquema del propio SPEC lo dicen: no hay `CHECK` que lo impida.
--   4. «Ni encadenarse A→B→C» (PA-046). Nada lo mira.
--   5. «Deshacer deja el mismo rastro» (PA-047). No hay dónde escribirlo.
--
-- Y lo que esta migración deliberadamente NO cambia: el disparador
-- `trg_patient_sync_merged` y el índice único parcial
-- `patient_identifier_active_unique`. Ver la sección 6, que es el resultado de
-- analizar el «defecto confirmado del 6-08-2026» contra el SQL real.
--
-- Después: pnpm migrations:check && pnpm db:deploy


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. DESHACER ES UNA FILA NUEVA, NO UNA EDICIÓN (PA-047)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL PROBLEMA. PA-047 exige poder deshacer una fusión dejando «el mismo
-- rastro: quién, cuándo y por qué». La tabla no tenía dónde decirlo, y el
-- propio SPEC anticipaba la solución evidente: añadir `undone_at` y
-- `undone_by` y EDITAR la fila de la fusión.
--
-- POR QUÉ ESA SOLUCIÓN SE DESCARTA. Editar la fila obliga a abrir un agujero
-- en la inmutabilidad de la sección 3 —«prohibido el UPDATE, salvo estas dos
-- columnas y sólo de NULL a un valor»—, y una tabla append-only «salvo esta
-- columna» deja de ser una garantía y pasa a ser una convención que alguien
-- tiene que recordar. La misma clase de convención que esta migración existe
-- para eliminar. Además el rastro del deshacer sería más pobre que el de la
-- fusión: dos columnas sueltas en vez de autor, instante y motivo propios.
--
-- LO QUE SE HACE EN SU LUGAR. `patient_merge` pasa a ser un registro de
-- SUCESOS: la fusión es una fila y el deshacer es OTRA fila que apunta a la
-- primera. Ninguna fila se toca jamás, el rastro del deshacer es literalmente
-- «el mismo» que el de la fusión —mismas columnas, mismas obligaciones— y la
-- pregunta «¿está deshecha esta fusión?» se responde por el enlace y no
-- adivinando por fechas.

CREATE TYPE "patient_merge_event" AS ENUM ('MERGE', 'UNDO');

COMMENT ON TYPE "patient_merge_event" IS
  'PA-044, PA-047. Qué suceso registra la fila: la fusión o el deshacerla.';

-- SIN VALOR POR DEFECTO, a propósito. Un `DEFAULT 'MERGE'` convertiría en
-- fusión toda fila de deshacer a la que se le olvidara el campo, y esta tabla
-- es la respuesta a «¿qué se hizo con esta ficha?».
ALTER TABLE "patient_merge"
  ADD COLUMN "event" "patient_merge_event" NOT NULL;

-- LA REFERENCIA A LA FUSIÓN QUE SE DESHACE.
--
-- POR QUÉ NO BASTA CON MIRAR LAS FECHAS. Sin este enlace, «¿está deshecha
-- esta fusión?» se contestaría buscando una fila `UNDO` posterior para la
-- misma pareja de fichas. Funciona una vez; el día que la misma pareja se
-- vuelva a fusionar —que es exactamente lo que ocurre cuando se deshace por
-- error y se rehace— la respuesta queda ambigua PARA SIEMPRE, y ambigua sobre
-- si dos expedientes clínicos están unidos o no.
ALTER TABLE "patient_merge"
  ADD COLUMN "undoes_merge_id" BIGINT;

ALTER TABLE "patient_merge"
  ADD CONSTRAINT "patient_merge_undoes_merge_id_fkey"
  FOREIGN KEY ("undoes_merge_id") REFERENCES "patient_merge"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- UNA FUSIÓN SE DESHACE UNA SOLA VEZ. Dos filas `UNDO` sobre la misma fusión
-- describirían un estado imposible, y bajo concurrencia son dos peticiones
-- que leen las dos «todavía fusionada». Sólo un índice único arbitra eso.
-- PostgreSQL trata los NULL como distintos entre sí, así que las filas `MERGE`
-- —que no deshacen nada— no compiten por él.
ALTER TABLE "patient_merge"
  ADD CONSTRAINT "patient_merge_undone_once" UNIQUE ("undoes_merge_id");

-- El enlace y el tipo dicen lo mismo o la fila miente: una fila `UNDO` sin
-- fusión a la que apuntar no dice qué deshizo, y una fila `MERGE` que apunta a
-- otra fusión no es una fusión.
ALTER TABLE "patient_merge"
  ADD CONSTRAINT "patient_merge_undo_links_merge"
  CHECK (("event" = 'UNDO') = ("undoes_merge_id" IS NOT NULL));

COMMENT ON CONSTRAINT "patient_merge_undo_links_merge" ON "patient_merge" IS
  'PA-047. Deshacer es una fila que nombra la fusión que deshace.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. QUÉ LLEVA CADA FILA: AUTOR, MOTIVO E INSTANTÁNEA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL AUTOR DEJA DE SER OPCIONAL (PA-044). `performed_by` admitía NULL desde la
-- primera migración, donde fue un valor por defecto de Prisma y no una
-- decisión. PA-044 dice «autor», y un rastro del que nadie responde no es un
-- rastro más débil: es uno inútil. Fusionar mal une los expedientes de dos
-- personas distintas —el peor incidente posible de este módulo, D-030— y la
-- pregunta que hay que poder contestar doce meses después es quién lo hizo.
--
-- EL CAMBIO ES SEGURO PORQUE LA TABLA ESTÁ VACÍA: no existe ninguna ruta que
-- escriba en `patient_merge` (`grep patientMerge src/` no devuelve nada) y se
-- comprobó `SELECT count(*) FROM patient_merge` = 0 antes de escribir esto.
-- Con una sola fila anterior, esto habría necesitado una migración de datos y
-- una decisión sobre a quién atribuir lo que no tiene autor.
ALTER TABLE "patient_merge"
  ALTER COLUMN "performed_by" SET NOT NULL;

-- Y CON CLAVE FORÁNEA, como `patient_change_history.changed_by`. Un UUID
-- suelto puede nombrar a nadie; entonces «quién la hizo» tiene por respuesta
-- un identificador que no resuelve. RESTRICT y no CASCADE: quien fusionó dos
-- fichas no desaparece del rastro porque su cuenta se borre. Las cuentas se
-- desactivan, no se borran (AU-024), y esto es lo que lo hace cierto aquí.
ALTER TABLE "patient_merge"
  ADD CONSTRAINT "patient_merge_performed_by_fkey"
  FOREIGN KEY ("performed_by") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- EL MOTIVO ES OBLIGATORIO EN LAS DOS (PA-044 y PA-047). Ya era NOT NULL, que
-- es lo que impide la ausencia pero no la cadena vacía: `''` satisface un NOT
-- NULL y no explica nada. «Un motivo obligatorio es lo que distingue esto de
-- un clic», y una cadena de espacios es un clic con más teclas.
ALTER TABLE "patient_merge"
  ADD CONSTRAINT "patient_merge_reason_not_blank"
  CHECK (length(btrim("reason")) > 0);

COMMENT ON CONSTRAINT "patient_merge_reason_not_blank" ON "patient_merge" IS
  'PA-044, PA-047. Fusionar y deshacer exigen motivo, y en blanco no es motivo.';

-- LA INSTANTÁNEA ES DE LA FUSIÓN Y SÓLO DE LA FUSIÓN.
--
-- QUÉ SE DECIDIÓ Y POR QUÉ. `source_snapshot` era NOT NULL, y con el registro
-- de sucesos había que decir qué lleva la fila de deshacer. Lleva NADA, y esto
-- es el porqué: la instantánea existe (PA-044) para explicar la operación y
-- para PODER DESHACERLA. De un deshacer no hay nada que deshacer —rehacer una
-- fusión es fusionar otra vez, con su propia fila y su propia instantánea—, y
-- el estado de la ficha absorbida en el momento de deshacer es el mismo que la
-- fila de la fusión ya guarda: mientras está fusionada, PA-045 rechaza toda
-- operación que la nombre, así que no ha podido cambiar.
--
-- Y NO SE DEJA NULABLE A SECAS: una columna que se puede omitir se omite. Se
-- ata al tipo de suceso, de modo que la fusión sin instantánea es imposible y
-- el deshacer con una instantánea inventada —el `'{}'::jsonb` que acaba
-- poniendo quien encuentra una columna obligatoria sin nada que meter en
-- ella— también.
ALTER TABLE "patient_merge"
  ALTER COLUMN "source_snapshot" DROP NOT NULL;

ALTER TABLE "patient_merge"
  ADD CONSTRAINT "patient_merge_snapshot_matches_event"
  CHECK (("event" = 'MERGE') = ("source_snapshot" IS NOT NULL));

COMMENT ON CONSTRAINT "patient_merge_snapshot_matches_event" ON "patient_merge" IS
  'PA-044. La instantánea de la ficha absorbida es de la fusión: sin ella no '
  'se puede deshacer, y en la fila de deshacer sería inventada.';

-- UNA FUSIÓN NO ES DE UNA FICHA CONSIGO MISMA, TAMPOCO EN EL RASTRO (PA-046).
-- El `CHECK` gemelo sobre `patient` está en la sección 4; éste impide que la
-- tabla que explica lo ocurrido registre algo que no puede ocurrir.
ALTER TABLE "patient_merge"
  ADD CONSTRAINT "patient_merge_not_self"
  CHECK ("source_patient_id" <> "target_patient_id");

-- LA CONSULTA DEL DESHACER es «¿qué fusión absorbió ESTA ficha?», por
-- `source_patient_id`, y no tenía índice: el que existe es por
-- `target_patient_id`, que contesta la pregunta contraria. Sin él, deshacer
-- recorre la tabla entera de fusiones de la clínica.
CREATE INDEX "patient_merge_source_patient_id_idx"
  ON "patient_merge" ("source_patient_id");


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. APPEND-ONLY DE VERDAD (PA-044)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El SPEC afirma que esta tabla es append-only, y hasta esta línea no lo era:
-- no había un solo disparador que lo impidiera. Se sostenía porque ninguna
-- ruta escribe todavía en ella, que es la peor forma de sostener una garantía
-- — se cae el día que alguien escriba la primera.
--
-- MISMO PATRÓN QUE `access_audit` Y `agenda_status_history`, y por las mismas
-- razones, que no se repiten aquí enteras:
--
--   * DISPARADOR Y NO `REVOKE UPDATE, DELETE`: el dueño de la tabla conserva
--     sus privilegios tras un REVOKE, y la aplicación conecta como dueño.
--   * TRUNCATE NECESITA EL SUYO: no dispara los de fila, y sin él el rastro de
--     todas las fusiones de la clínica se va en una sentencia.
--   * NO SE PROHÍBE EL `INSERT`: append-only no es congelado. Esta tabla crece
--     —cada fusión y cada deshacer añaden una fila— y crecer es su función.
--   * LA PUERTA DE `session_replication_role = 'replica'` sigue abierta y no
--     es un agujero: exige privilegios que la aplicación no tiene, queda en el
--     registro del servidor y es la que usa la suite de integración para
--     vaciar entre pruebas (`test/integration/setup/database.ts`).
--
-- FUNCIÓN PROPIA Y NO LA DE `access_audit`: el mensaje nombra la tabla, y
-- quien lo lea a las once de la noche lee el mensaje, no el catálogo. Un
-- nombre que dice `patient_merge` lo manda al requisito correcto.

CREATE OR REPLACE FUNCTION patient_merge_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'patient_merge is append-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Undoing a merge is a NEW row with event = UNDO pointing at '
                 'the merge it undoes (PA-047), never an edit of this one. '
                 'To debug in development, disable the trigger explicitly.';
END;
$$;

CREATE TRIGGER trg_patient_merge_immutable
  BEFORE UPDATE OR DELETE ON "patient_merge"
  FOR EACH ROW
  EXECUTE FUNCTION patient_merge_insert_only();

CREATE TRIGGER trg_patient_merge_no_truncate
  BEFORE TRUNCATE ON "patient_merge"
  FOR EACH STATEMENT
  EXECUTE FUNCTION patient_merge_insert_only();

-- LA COHERENCIA DE LA FILA DE DESHACER, que ningún `CHECK` puede ver porque
-- depende de OTRA fila de la misma tabla.
--
-- La clave foránea garantiza que `undoes_merge_id` existe; no garantiza que
-- sea una FUSIÓN ni que hable de las mismas dos fichas. Una fila de deshacer
-- que nombrara otra pareja pasaría todos los `CHECK` de arriba y dejaría el
-- rastro diciendo que se deshizo algo que nunca se fusionó. Como el enlace es
-- lo único que contesta «¿está deshecha esta fusión?», que sea cierto es la
-- condición de que la respuesta sirva.
CREATE OR REPLACE FUNCTION check_patient_merge_undo_coherent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_event  "patient_merge_event";
  v_source UUID;
  v_target UUID;
BEGIN
  SELECT "event", "source_patient_id", "target_patient_id"
    INTO v_event, v_source, v_target
    FROM "patient_merge"
   WHERE "id" = NEW."undoes_merge_id";

  IF v_event <> 'MERGE' THEN
    RAISE EXCEPTION 'patient_merge row % is not a merge and cannot be undone',
      NEW."undoes_merge_id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_source <> NEW."source_patient_id" OR v_target <> NEW."target_patient_id" THEN
    RAISE EXCEPTION 'undo of patient_merge % names a different pair of charts',
      NEW."undoes_merge_id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- `WHEN` y no un `IF` dentro: las filas de fusión no pagan una consulta por
-- una comprobación que no les toca.
CREATE TRIGGER trg_patient_merge_undo_coherent
  BEFORE INSERT ON "patient_merge"
  FOR EACH ROW
  WHEN (NEW."undoes_merge_id" IS NOT NULL)
  EXECUTE FUNCTION check_patient_merge_undo_coherent();

COMMENT ON TABLE "patient_merge" IS
  'PA-043 a PA-049, REQ-010. Registro de SUCESOS de la resolución de '
  'duplicados: una fila por fusión y otra por deshacerla, apuntando a la que '
  'deshace. APPEND-ONLY: protegido por disparador contra UPDATE, DELETE y '
  'TRUNCATE. Deshacer NO edita la fila de la fusión — ver la migración '
  '20260817204801_patient_merge_events.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. UNA FICHA NO SE FUSIONA CONSIGO MISMA (PA-046)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Las notas de esquema del `SPEC.md` lo dicen literalmente: «No hay CHECK que
-- impida `merged_into_id = id`. PA-046 lo prohíbe y hoy nada lo garantiza en
-- la base; la garantía debería vivir ahí, no sólo en el servicio.»
--
-- Es el mismo caso que `patient_mother_not_self`: una clave foránea a la misma
-- tabla acepta encantada que la fila se apunte a sí misma. Y el efecto es
-- peor que una fila rara: una ficha fusionada consigo misma es, para PA-045,
-- una ficha que rechaza toda operación y remite a sí misma. Nadie puede
-- abrirla ni deshacerla desde la aplicación.
ALTER TABLE "patient"
  ADD CONSTRAINT "patient_merged_into_not_self"
  CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id");

COMMENT ON CONSTRAINT "patient_merged_into_not_self" ON "patient" IS
  'PA-046. Una ficha no puede fusionarse consigo misma.';

-- Y LAS DOS COLUMNAS DE LA FUSIÓN VAN JUNTAS O NO VAN. `merged_into_id` dice
-- a dónde se movió la historia y `merged_at` cuándo; separadas, un deshacer
-- que limpiara sólo la primera dejaría una ficha que se comporta como entera y
-- arrastra la fecha de una fusión que ya no existe, y una fusión que pusiera
-- sólo el enlace dejaría a PA-044 sin el instante que exige. Que la base lo
-- exija es lo que hace que deshacer esté completo o no ocurra.
ALTER TABLE "patient"
  ADD CONSTRAINT "patient_merged_at_matches_link"
  CHECK (("merged_into_id" IS NULL) = ("merged_at" IS NULL));

-- «¿QUÉ FICHAS ABSORBIÓ ÉSTA?» NO TENÍA ÍNDICE, y con D-031 es una pregunta
-- del camino de lectura y no una rareza: la superviviente lee por el enlace,
-- así que recorrerlo hacia atrás es lo que hace la sección 5 para detectar la
-- cadena y lo que hará toda consulta de historia unificada. Sin él, cada
-- fusión recorre las 50 000 fichas de SC-007.
--
-- PARCIAL porque `merged_into_id` es NULL en la práctica totalidad de las
-- fichas: el índice guarda las fusionadas y nada más. Prisma no puede
-- describir el predicado, así que lo leería como sobrante — por eso entra en
-- la lista de `scripts/check-migrations.mts`, igual que
-- `agenda_entry_by_service_type`.
CREATE INDEX "patient_absorbed_charts"
  ON "patient" ("merged_into_id")
  WHERE "merged_into_id" IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. NI SE ENCADENAN LAS FUSIONES (PA-046)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- «Una cadena A→B→C obliga a todo lector a recorrerla, y el primero que no lo
-- haga enseñará la ficha equivocada. Se resuelve prohibiéndola, no
-- siguiéndola.» Con D-031 —la superviviente lee por el enlace y ninguna fila
-- hija se mueve— cada módulo que se escriba tiene que seguir ese enlace; que
-- sea UN salto y no N es lo que hace la regla recordable.
--
-- POR QUÉ NO ES UN `CHECK`. Un `CHECK` sólo ve la fila que se escribe. Las
-- dos formas de encadenar dependen de OTRA fila de `patient`:
--
--   * fusionar hacia una ficha que ya está fusionada (A→B cuando B→C), y
--   * fusionar una ficha a la que ya apuntan otras (B→C cuando A→B).
--
-- Ninguna de las dos cabe en una expresión sobre `NEW`. Donde sí se puede
-- hacer cumplir es en un disparador, y ahí va.
--
-- POR QUÉ `FOR UPDATE` Y NO UN `SELECT` A SECAS. Sin el bloqueo, dos
-- transacciones simultáneas —una fusionando A→B, otra B→C— leen las dos que no
-- hay cadena y las dos aciertan: la cadena aparece al confirmar, y ningún
-- constraint la ve nunca. `FOR UPDATE` sobre la ficha DESTINO, más el bloqueo
-- que el propio `UPDATE` toma sobre la ficha ORIGEN, hacen que las dos
-- compitan por la misma fila y se serialicen: la segunda vuelve a leer el
-- estado ya confirmado por la primera y la rechaza. Es la misma razón por la
-- que la agenda no comprueba el solape en la aplicación.
--
-- LA TERCERA PUERTA: volver a fusionar una ficha YA fusionada hacia otro
-- destino. No es una cadena, es una reescritura — A→B se convierte en A→C sin
-- que nada lo registre, y el rastro de la primera fusión queda apuntando a
-- donde la ficha ya no está. Para eso está PA-045 y el código
-- `PATIENT_ALREADY_MERGED`: primero se deshace, y deshacer deja su fila.
-- Poner `merged_into_id` a NULL —eso es deshacer— sigue permitido, que es lo
-- que la sección 6 comprueba que funciona.

CREATE OR REPLACE FUNCTION check_patient_merge_not_chained()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_target_merged_into UUID;
BEGIN
  -- Ya estaba fusionada y se la manda a otro sitio sin deshacer antes.
  -- `IF` anidado y no una sola condición con `AND`: en un disparador de
  -- `INSERT` el registro `OLD` no está asignado, y nombrar uno de sus campos
  -- en la misma expresión falla aunque la parte que lo protege sea falsa.
  IF TG_OP = 'UPDATE' THEN
    IF OLD."merged_into_id" IS NOT NULL
       AND OLD."merged_into_id" <> NEW."merged_into_id" THEN
      RAISE EXCEPTION 'patient % is already merged into %; undo first',
        NEW."id", OLD."merged_into_id"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- El destino no puede estar fusionado a su vez: sería A→B→C.
  SELECT "merged_into_id" INTO v_target_merged_into
    FROM "patient"
   WHERE "id" = NEW."merged_into_id"
     FOR UPDATE;

  IF v_target_merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'patient % is itself merged into %; merging into it would chain',
      NEW."merged_into_id", v_target_merged_into
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Ni la absorbida puede tener a otras apuntándola: sería A→B→C por el otro
  -- extremo. Basta con que exista una.
  IF EXISTS (
    SELECT 1 FROM "patient" WHERE "merged_into_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'patient % already absorbed other charts; merging it would chain',
      NEW."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- También en `INSERT`: una importación puede traer la ficha ya fusionada, y no
-- pasa por ninguna ruta. `WHEN` deja fuera el alta corriente y el deshacer,
-- que son la inmensa mayoría de las escrituras sobre esta tabla.
CREATE TRIGGER trg_patient_merge_not_chained
  BEFORE INSERT OR UPDATE OF "merged_into_id" ON "patient"
  FOR EACH ROW
  WHEN (NEW."merged_into_id" IS NOT NULL)
  EXECUTE FUNCTION check_patient_merge_not_chained();


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. EL «DEFECTO DEL 6-08-2026»: QUÉ ES Y QUÉ NO ES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- PA-047 afirma que deshacer una fusión es HOY IMPOSIBLE porque
-- `trg_patient_sync_merged` vuelve a poner `patient_merged = false` y choca
-- con `patient_identifier_active_unique`. Se reprodujo contra PostgreSQL 18
-- antes de escribir una línea de esta migración, y el resultado es que el
-- diagnóstico es DEMASIADO AMPLIO:
--
--   * CASO NORMAL — nadie reclamó el documento mientras la ficha estaba
--     fusionada. Deshacer FUNCIONA. `patient_merged` vuelve a `false`, la fila
--     reentra en el índice parcial y no hay con qué chocar, porque el índice
--     impedía desde el principio que dos fichas ACTIVAS compartieran el
--     documento: si A lo tenía, B no podía tenerlo.
--
--   * CASO DE CONFLICTO — otra ficha activa reclamó el documento en el
--     intervalo, que es posible precisamente porque la fusión lo liberó.
--     Deshacer choca, y DEBE chocar: eso es PA-048 al pie de la letra, y es la
--     consecuencia técnica de PA-014, no un defecto. La transacción entera se
--     deshace, así que tampoco queda la fusión a medio deshacer.
--
-- POR ESO ESTA MIGRACIÓN NO TOCA NI EL DISPARADOR NI EL ÍNDICE: lo que hacen
-- es correcto, y cambiarlo sería permitir dos fichas activas con la misma
-- cédula — SC-008 dice que ese número es cero, sin excepción.
--
-- LO QUE SÍ ESTÁ MAL ES EL MENSAJE, y no es esquema: quien deshace recibe
-- `DUPLICATE_IDENTIFIER` sobre un documento que no estaba tocando, porque el
-- mapeo de `patient_identifier_active_unique` está escrito para el alta. El
-- arreglo es `MERGE_UNDO_CONFLICT` (409, PA-048) desde el servicio de la
-- fusión, que sabe que la operación era un deshacer. Es trabajo de la tanda de
-- código, no de ésta.
--
-- `test/integration/patient-merge.spec.ts` reproduce los dos casos y es lo que
-- deja constancia de que la base ya se comporta bien.
--
-- ---------------------------------------------------------------------------
-- LO QUE SÍ APARECIÓ AL ANALIZARLO: EL `INSERT` NO MANTIENE LA BANDERA
-- ---------------------------------------------------------------------------
--
-- `patient_identifier.patient_merged` está desnormalizada porque el predicado
-- de un índice no admite subconsultas (PA-014), y `trg_patient_sync_merged` la
-- mantiene... sólo en el `UPDATE` de `patient.merged_into_id`. Una fila de
-- documento INSERTADA para una ficha ya fusionada toma el `DEFAULT false` y
-- entra en el índice único como si la ficha estuviera activa. Consecuencias,
-- las dos reales: la ficha fusionada bloquea un documento que debería estar
-- libre, y ese documento no se puede volver a registrar en la superviviente.
--
-- Es alcanzable por importación o por `psql` —los caminos que no pasan por el
-- DTO, el mismo argumento del dígito verificador de la cédula— y desde que
-- exista la ruta de PA-015, también desde la aplicación. Se cierra donde vive
-- el resto de la garantía: en la base.

CREATE OR REPLACE FUNCTION set_patient_identifier_merged()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_merged BOOLEAN;
BEGIN
  SELECT "merged_into_id" IS NOT NULL INTO v_merged
    FROM "patient"
   WHERE "id" = NEW."patient_id";

  -- `coalesce` para el caso de que la ficha no exista: la fila debe fallar por
  -- la clave foránea, que dice lo que pasa, y no por un NOT NULL sobre una
  -- columna que quien escribe ni siquiera nombró.
  NEW."patient_merged" := coalesce(v_merged, false);
  RETURN NEW;
END;
$$;

-- SÓLO EN `INSERT`. `patient_id` no cambia nunca —D-031: las filas hijas no se
-- repuntan, la superviviente lee por el enlace—, así que un `UPDATE` de esa
-- columna no es un caso que haya que cubrir, sino uno que no debe existir.
CREATE TRIGGER trg_patient_identifier_set_merged
  BEFORE INSERT ON "patient_identifier"
  FOR EACH ROW
  EXECUTE FUNCTION set_patient_identifier_merged();

COMMENT ON COLUMN "patient_identifier"."patient_merged" IS
  'PA-014. Copia desnormalizada de «la ficha está fusionada», porque el '
  'predicado de patient_identifier_active_unique no admite subconsultas. La '
  'mantienen trg_patient_identifier_set_merged (al insertar) y '
  'trg_patient_sync_merged (al fusionar y al deshacer). No se escribe a mano.';
