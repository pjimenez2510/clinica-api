-- agenda_waitlist_contact_trail
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- E5 · LA LISTA DE ESPERA ES UN REPARTO, Y UN REPARTO SE DEFIENDE O NO EXISTE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La tabla `waitlist_entry` existe desde `20260806022931_clinical_core` y hasta
-- hoy NO LA ESCRIBE NADIE: ni un servicio, ni una semilla, ni una ruta. Está
-- vacía en desarrollo y sólo la leen dos contadores de la fusión de fichas
-- (PA-049). Esa es la razón por la que esta migración puede corregir su forma
-- —quitar dos columnas y endurecer otras dos— sin migrar un solo dato ni pedir
-- permiso a ninguna fila: el cambio es barato HOY y caro el día después de la
-- primera inscripción.
--
-- Lo que E5 reparte es un recurso escaso: el cupo que otro paciente acaba de
-- liberar. AG-061 dice a quién se le ofrece, AG-062 que la prioridad
-- constitucional no es una cortesía, y AG-064 que cada intento de contacto se
-- registra y que el cupo NO se reasigna sin confirmación. Las tres juntas dicen
-- una sola cosa: la clínica tiene que poder responder a QUIÉN SE LLAMÓ, CUÁNDO,
-- QUIÉN LLAMÓ Y QUÉ CONTESTÓ. Un contador no responde nada de eso.
--
-- Esta migración hace tres cosas y ninguna más:
--
--   1. crea `waitlist_contact_attempt` — el rastro que AG-064 exige — y quita
--      las dos columnas que decían la misma verdad a medias;
--   2. quita `waitlist_entry.priority`, que congelaba un dato que caduca;
--   3. escribe en la base las invariantes de E5 que hoy no vivían en ninguna
--      parte: el rango de fechas, la coherencia de la conversión y el cierre.
--
-- Y añade el único parámetro de AG-094 que `site_parameter` nunca tuvo.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- 1 · EL RASTRO DE CONTACTOS (AG-064)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUÉ HABÍA. `contact_attempts` (un `smallint`) y `last_contacted_at` (un
-- instante). Al tercer intento la fila dice «3» y la fecha del tercero: cuándo
-- fueron los dos primeros, quién llamó y qué contestó la paciente no están, y
-- no es que se hayan perdido — nunca hubo dónde escribirlos. Con eso, «¿por qué
-- el cupo del martes se lo llevó ella y no yo, que estaba antes?» no tiene
-- respuesta, y ésa es exactamente la pregunta que una lista de espera existe
-- para poder contestar.
--
-- POR QUÉ SE CONSTRUYE Y NO SE REBAJA EL REQUISITO. D-006 anotó el 12-08-2026
-- que el historial «se rebaja, no se migra», y era una decisión razonable
-- cuando E5 no tenía fecha. Rebajar AG-064 hoy es cambiar lo que el sistema
-- PROMETE, y eso lo decide el usuario; construir lo que el requisito ya dice,
-- no. El texto EARS de AG-064 no se ha tocado en esta migración: se ha cumplido.

-- EL RESULTADO, Y POR QUÉ NO BASTA CON EL INSTANTE.
--
-- AG-064 tiene dos mitades y la segunda es «NO DEBERÁ reasignar automáticamente
-- el cupo sin confirmación». Sin resultado, «se le llamó tres veces» no
-- distingue el caso en que NUNCA CONTESTÓ —AG-066: la entrada caduca y el cupo
-- pasa al siguiente— del caso en que CONTESTÓ Y DIJO QUE NO —el cupo pasa al
-- siguiente igual, pero la entrada se cierra por voluntad de la paciente, no
-- por incomparecencia—, ni del caso en que ACEPTÓ, que es la única confirmación
-- que autoriza a convertir la entrada en cita. Son tres desenlaces con tres
-- consecuencias distintas sobre el mismo cupo: el resultado no es un adorno del
-- registro, es lo que hace aplicable la segunda mitad del requisito.
--
-- TRES VALORES Y NO SIETE. `LEFT_MESSAGE`, `WRONG_NUMBER` o `CALLBACK_REQUESTED`
-- son matices del primero mientras nadie tenga que decidir nada distinto con
-- ellos. Añadir un valor a un enum de PostgreSQL es `ALTER TYPE … ADD VALUE`,
-- que no reescribe ninguna fila; inventarlos hoy obliga a decidir ahora qué
-- hace el sistema con cada uno, y eso es política de la clínica.
CREATE TYPE "waitlist_contact_outcome" AS ENUM (
  'NO_ANSWER',
  'ACCEPTED',
  'DECLINED'
);

COMMENT ON TYPE "waitlist_contact_outcome" IS
  'AG-064. Qué pasó en el intento: no contestó, aceptó el cupo, o lo rechazó. Los tres cierran el cupo de forma distinta.';

CREATE TABLE "waitlist_contact_attempt" (
  "id"                UUID PRIMARY KEY DEFAULT uuidv7(),
  "waitlist_entry_id" UUID NOT NULL,

  -- El instante literal de AG-064. `timestamptz`, como todo instante de este
  -- esquema: la fecha clínica se resuelve después en America/Guayaquil, y
  -- guardar hora de pared aquí haría que el tercer intento de las 21:30
  -- cambiara de día según el huso de quien pregunte.
  "attempted_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  -- El autor. NOT NULL por lo mismo que `patient_priority_group.recorded_by`:
  -- un rastro del que nadie responde no es un rastro más débil, es uno inútil.
  -- «Se le llamó tres veces» sin nombre no se puede comprobar ni desmentir.
  "recorded_by"       UUID NOT NULL,

  "outcome"           "waitlist_contact_outcome" NOT NULL,

  CONSTRAINT "waitlist_contact_attempt_entry_fkey"
    FOREIGN KEY ("waitlist_entry_id") REFERENCES "waitlist_entry"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  -- RESTRICT, como en toda autoría de este esquema: las cuentas se desactivan,
  -- no se borran (AU-024), y esto es lo que lo hace cierto también aquí.
  CONSTRAINT "waitlist_contact_attempt_recorded_by_fkey"
    FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

COMMENT ON TABLE "waitlist_contact_attempt" IS
  'AG-064. Cada intento de contacto de una entrada de lista de espera, con su instante, su autor y su resultado. Append-only: es la prueba de que el reparto del cupo fue justo.';

-- LA CONSULTA QUE SE HACE SIEMPRE: los intentos de ESTA entrada, del más
-- reciente al más antiguo. Responde a la vez las tres preguntas que sustituyen
-- a las columnas borradas —cuántos van (AG-066), cuándo fue el último, y si
-- alguno fue `ACCEPTED` (AG-064)—, y por eso no hace falta ningún otro índice.
CREATE INDEX "waitlist_contact_attempt_by_entry"
  ON "waitlist_contact_attempt" ("waitlist_entry_id", "attempted_at" DESC);

-- ─── Append-only, por el mismo motivo que `agenda_status_history` (D-022) ────
--
-- Un rastro que se puede reescribir no defiende nada: si «se le llamó tres
-- veces y no contestó» se puede editar después de dar el cupo a otra persona,
-- la tabla no prueba el reparto, lo decora. Se rechazan `UPDATE`, `DELETE` y
-- `TRUNCATE` —el tercero necesita su propio disparador porque no dispara los
-- de fila, y sin él se va el rastro de la clínica entera en una sentencia.
--
-- NO SE RECHAZA `INSERT`: la tabla crece siempre, que es lo que es un registro
-- de intentos. Y no se rechaza la puerta de siempre —un superusuario que
-- desactive el disparador, o `session_replication_role = 'replica'`—, que es la
-- que usa la suite de integración para truncar entre pruebas.
--
-- FUNCIÓN PROPIA Y NO LA DE `agenda_status_history`: el mensaje nombra la
-- tabla, y quien se lo encuentre a las once de la noche lee el mensaje, no el
-- catálogo. Cinco líneas compartidas no valen un error impreciso.
CREATE OR REPLACE FUNCTION waitlist_contact_attempt_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'waitlist_contact_attempt is append-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'El rastro de contactos es la prueba de que el cupo se repartió '
                 'con criterio (AG-064). Un intento equivocado se corrige '
                 'registrando el siguiente, no reescribiendo el anterior.';
END;
$$;

CREATE TRIGGER trg_waitlist_contact_attempt_immutable
  BEFORE UPDATE OR DELETE ON waitlist_contact_attempt
  FOR EACH ROW
  EXECUTE FUNCTION waitlist_contact_attempt_insert_only();

CREATE TRIGGER trg_waitlist_contact_attempt_no_truncate
  BEFORE TRUNCATE ON waitlist_contact_attempt
  FOR EACH STATEMENT
  EXECUTE FUNCTION waitlist_contact_attempt_insert_only();

-- ─── Y las dos columnas que decían lo mismo a medias ─────────────────────────
--
-- SE DERIVAN, NO SE CACHEAN. `contact_attempts` es `count(*)` sobre la tabla de
-- arriba y `last_contacted_at` es `max(attempted_at)`, las dos por el índice
-- `waitlist_contact_attempt_by_entry`. Mantenerlas como caché exigiría un
-- disparador que las recalculara en cada inserción Y prohibir que la aplicación
-- las escribiera: dos verdades sobre el mismo hecho, y la segunda copia sólo
-- puede quedarse corta —un intento registrado sin sumar el contador— sin que
-- nada lo note. La lista de espera de una sede se cuenta por decenas: el coste
-- de derivarlas es una consulta indexada por entrada, y el de mantenerlas es
-- una discrepancia que aparece meses después y en la dirección que perjudica al
-- paciente que sí fue llamado.
--
-- Si algún día un informe las necesita agregadas para toda la sede, lo que
-- entra es una vista o un contador mantenido POR DISPARADOR desde esta tabla,
-- nunca una columna que escriba la aplicación.
ALTER TABLE "waitlist_entry"
  DROP COLUMN "contact_attempts",
  DROP COLUMN "last_contacted_at";

-- ═══════════════════════════════════════════════════════════════════════════
-- 2 · LA PRIORIDAD ALMACENADA, QUE CONTRADECÍA A `patients` (AG-062)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `priority smallint DEFAULT 5` guardaba el número por el que AG-061 ordena.
-- Nació antes que la entrega P3 de `patients` y hoy la contradice de frente:
--
--   * PA-041 — la prioridad es un número DERIVADO de los grupos vigentes hoy, y
--     NO SE ALMACENA. Son dos niveles, `1` y `2`, y los calcula
--     `priorityLevelOf` en `patients/domain/priority-groups.ts`.
--   * PA-035 — los grupos que se deducen de la edad no se guardan: «sería un
--     dato que caduca cada cumpleaños y que nadie recuerda actualizar».
--   * PA-036 — el embarazo caduca solo, «sin que nadie tenga que cerrarlo a
--     mano»; por eso `patient_priority_group_pregnancy_has_end` exige fecha de
--     fin.
--
-- CON LA PRIORIDAD CONGELADA AL INSCRIBIRSE, una mujer que ya dio a luz sigue
-- siendo prioridad 1 en la lista para siempre, y el adolescente que cumple 18
-- también. Es el defecto que PA-036 existe para evitar, reintroducido en otra
-- tabla — y aquí es peor que en la ficha, porque el dato caducado no se
-- muestra: se usa para ordenar una cola, sin que nadie vea el número.
--
-- POR QUÉ SE QUITA Y NO SE REDEFINE. La otra salida era dejarla con otro
-- significado explícito —una marca manual de «atender primero»—, y está cerrada
-- por decisión: D-033 puso esa marca en la SALA DE ESPERA, no en la lista.
-- Convertirla aquí por nuestra cuenta sería crear un segundo sitio donde el
-- orden se puede torcer a mano, en la cola donde precisamente hay que poder
-- demostrar que no se torció.
--
-- QUÉ ORDENA AHORA AG-061: el `priority` que viaja en toda respuesta que lleva
-- un paciente y que basta con `patient:read` —`1` prioritario, `2` corriente,
-- sin decir por qué (PA-042, AG-073)—, resuelto en el instante en que se
-- proponen los candidatos. La antigüedad de inscripción, que es el segundo
-- criterio, sí es un hecho del pasado y sigue donde estaba: `created_at`.
DROP INDEX "waitlist_entry_site_id_status_priority_created_at_idx";

ALTER TABLE "waitlist_entry"
  DROP COLUMN "priority";

-- EL ÍNDICE QUE SUSTITUYE AL QUE SE VA, Y POR QUÉ ES PARCIAL. La única consulta
-- recurrente de E5 es la de AG-061: los candidatos ABIERTOS de una sede, por
-- antigüedad. Las entradas cerradas —`SCHEDULED`, `EXPIRED`, `CANCELLED`— no se
-- proponen nunca (AG-067) y con el tiempo son casi todas: mantenerlas en el
-- índice es pagar en cada inscripción por filas que ninguna consulta caliente
-- lee. El predicado del índice ES el predicado del requisito, escrito una vez.
--
-- ⚠️ ESTE ÍNDICE NO ES LA GARANTÍA DE AG-067, y no hay que leerlo como si lo
-- fuera: un índice acelera la consulta correcta, no impide la incorrecta. Lo
-- que la base sí garantiza está más abajo, en `trg_waitlist_entry_closure_final`.
CREATE INDEX "waitlist_entry_open_candidates"
  ON "waitlist_entry" ("site_id", "created_at")
  WHERE "status" IN ('WAITING', 'CONTACTED');

-- ═══════════════════════════════════════════════════════════════════════════
-- 3 · LO QUE E5 EXIGE Y LA BASE NO GARANTIZABA
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── AG-060 y AG-065: el rango preferido existe y no está invertido ─────────
--
-- AG-060 enumera qué lleva una inscripción: «sede, rango de fechas preferido y,
-- OPCIONALMENTE, profesional y tipo de servicio». Lo opcional está dicho, y el
-- rango no está en esa lista. Las dos columnas eran anulables desde
-- `clinical_core`, donde nadie decidió que lo fueran: es el defecto de una
-- tabla generada.
--
-- Y ES QUE UNA ENTRADA SIN FECHA MÁXIMA NO PUEDE CADUCAR NUNCA. AG-065 dice
-- «CUANDO la fecha preferida máxima quede en el pasado, márquela EXPIRED»: con
-- `preferred_to` nulo esa condición no se cumple jamás, así que la entrada
-- compite por cada cupo de la sede hasta el fin de los tiempos y sólo AG-066
-- —agotar los intentos de contacto— podría cerrarla. Un requisito que un NULL
-- desactiva no es un requisito.
ALTER TABLE "waitlist_entry"
  ALTER COLUMN "preferred_from" SET NOT NULL,
  ALTER COLUMN "preferred_to"   SET NOT NULL;

-- Inclusivo por los dos lados, como `patient_priority_group_period_valid`:
-- «del 3 al 3» es un rango legítimo —la paciente sólo puede ese día— y lo que
-- no es un rango es terminar antes de empezar. Sin este CHECK, la entrada
-- existe y no la satisface ningún cupo: espera para siempre sin que nada falle.
ALTER TABLE "waitlist_entry"
  ADD CONSTRAINT "waitlist_entry_preferred_range_valid"
  CHECK ("preferred_to" >= "preferred_from");

-- ─── AG-063: el estado y el enlace a la cita son el mismo hecho ─────────────
--
-- «CUANDO una entrada se convierta en cita, el sistema DEBERÁ marcarla
-- SCHEDULED y DEBERÁ enlazarla con la cita creada». Son dos obligaciones sobre
-- el mismo acto, así que las dos columnas se contradicen si una va sin la otra:
--
--   * `SCHEDULED` sin enlace dice que a esta persona se le dio un cupo y no
--     dice cuál — la entrada queda cerrada y la cita, huérfana de su origen;
--   * enlace sin `SCHEDULED` deja a la entrada compitiendo por otro cupo
--     cuando ya tiene el suyo, que es AG-067 roto por dentro.
--
-- Bicondicional, como `patient_priority_group_closure_complete`.
ALTER TABLE "waitlist_entry"
  ADD CONSTRAINT "waitlist_entry_conversion_complete"
  CHECK (("status" = 'SCHEDULED') = ("converted_entry_id" IS NOT NULL));

-- UN CUPO, UNA ENTRADA. Sin esto, dos entradas pueden apuntar a la misma cita y
-- las dos quedan `SCHEDULED`: la lista dice que se atendió a dos personas con
-- un cupo, y la que se quedó fuera aparece como servida. Es un índice único
-- PARCIAL —`converted_entry_id` es NULL en toda entrada abierta y en PostgreSQL
-- dos NULL no chocan, pero el índice parcial dice además POR QUÉ sólo se
-- vigilan las convertidas—, así que Prisma no puede describirlo y va en la
-- lista protegida de `scripts/check-migrations.mts`.
CREATE UNIQUE INDEX "waitlist_entry_one_per_converted_entry"
  ON "waitlist_entry" ("converted_entry_id")
  WHERE "converted_entry_id" IS NOT NULL;

-- ─── AG-063 y AG-064: la conversión es del mismo paciente y consentida ──────
--
-- DOS COMPROBACIONES QUE MIRAN OTRAS TABLAS, y por eso un disparador y no un
-- CHECK: un CHECK no puede consultar `agenda_entry` ni `waitlist_contact_attempt`.
--
--   1. LA CITA ES DE ESTE PACIENTE. Una entrada de María enlazada con la cita
--      de Juan dice, en la única tabla que registra el reparto, que el turno de
--      María se cumplió — y el cupo se lo llevó otra persona. No es una errata
--      de tecleo cualquiera: es exactamente la forma que tiene de verse un
--      reparto torcido, y la tabla lo estaría certificando. De paso cierra el
--      caso del bloqueo de agenda: `kind = BLOCK` no tiene paciente
--      (`agenda_entry_patient_coherence`), así que convertir una entrada en un
--      bloqueo es imposible sin necesidad de nombrarlo aparte.
--
--   2. HAY UNA ACEPTACIÓN REGISTRADA. Es la segunda mitad de AG-064 —«NO DEBERÁ
--      reasignar automáticamente el cupo sin confirmación»— dicha en lo único
--      que la base puede comprobar: una conversión sin NINGÚN intento con
--      resultado `ACCEPTED` es, literalmente, un cupo reasignado sin que conste
--      confirmación. La paciente que acepta en el mostrador se registra igual:
--      un intento con resultado `ACCEPTED` y el autor que la atendió. Lo que
--      esto impide no es la aceptación verbal, es la que nadie escribió.
--
-- CONSECUENCIA DELIBERADA: una entrada NO PUEDE NACER convertida. En un INSERT
-- no puede haber intentos —la clave foránea de `waitlist_contact_attempt` exige
-- que la entrada exista antes—, así que la conversión es siempre un UPDATE
-- posterior. Es lo correcto: inscribir a alguien y darle el cupo en el mismo
-- acto no es una lista de espera, es una reserva (AG-060 empieza «CUANDO NO
-- HAYA cupo disponible»).
CREATE OR REPLACE FUNCTION waitlist_entry_conversion_is_consented()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  appointment_patient uuid;
BEGIN
  SELECT patient_id INTO appointment_patient
    FROM agenda_entry
   WHERE id = NEW.converted_entry_id;

  IF appointment_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION
      'waitlist entry % cannot be converted into an appointment of another patient',
      NEW.id
      USING ERRCODE = 'check_violation',
            HINT = 'La cita enlazada tiene que ser del mismo paciente que espera '
                   '(AG-063). Un bloqueo de agenda no tiene paciente y por eso '
                   'tampoco sirve.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM waitlist_contact_attempt
     WHERE waitlist_entry_id = NEW.id
       AND outcome = 'ACCEPTED'
  ) THEN
    RAISE EXCEPTION
      'waitlist entry % has no recorded acceptance', NEW.id
      USING ERRCODE = 'check_violation',
            HINT = 'AG-064: el cupo no se reasigna sin confirmación. Registre el '
                   'intento de contacto con resultado ACCEPTED antes de convertir '
                   'la entrada en cita.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_waitlist_entry_conversion_consented
  BEFORE INSERT OR UPDATE ON waitlist_entry
  FOR EACH ROW
  WHEN (NEW.converted_entry_id IS NOT NULL)
  EXECUTE FUNCTION waitlist_entry_conversion_is_consented();

-- ─── AG-067: lo que se cierra, se cierra ────────────────────────────────────
--
-- «MIENTRAS una entrada esté en SCHEDULED, EXPIRED o CANCELLED, el sistema NO
-- DEBERÁ proponerla como candidata».
--
-- LO QUE LA BASE NO PUEDE GARANTIZAR, DICHO PRIMERO: que una consulta filtre.
-- AG-067 habla de lo que el sistema PROPONE, y proponer es leer; ninguna
-- restricción impide que un `SELECT` mal escrito devuelva una fila cerrada. Esa
-- mitad se prueba contra el servicio que lista candidatos, en la tanda que lo
-- escriba, y el índice parcial de arriba es la forma que tiene esa consulta.
--
-- LO QUE SÍ GARANTIZA, y es la mitad que ninguna prueba de servicio puede dar:
-- QUE EL CONJUNTO CERRADO SEA CERRADO. Sin esto, un `UPDATE` —un script de
-- corrección, una pantalla futura de «reabrir», un `psql`— devuelve a `WAITING`
-- una entrada que caducó por no contestar tres veces, y esa entrada vuelve a
-- competir CON SU ANTIGÜEDAD ORIGINAL: se cuela por delante de todos los que se
-- inscribieron después y AG-067 queda roto sin que ninguna consulta se haya
-- equivocado.
--
-- QUÉ HACER ENTONCES CUANDO ALGUIEN VUELVE A NECESITAR EL CUPO: inscribirlo otra
-- vez. La entrada nueva nace con `created_at` de hoy, que es lo justo — quien
-- rechazó un cupo el martes no conserva el turno del lunes — y la anterior sigue
-- ahí, contando lo que pasó.
--
-- TAMBIÉN SE CONGELA `converted_entry_id` en una entrada ya cerrada: cambiar a
-- qué cita apunta una entrada `SCHEDULED` es reescribir a posteriori qué cupo se
-- le dio a quién, que es la misma mentira contra la que existe el rastro.
CREATE OR REPLACE FUNCTION waitlist_entry_closure_is_final()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'waitlist entry % is closed as % and cannot be reopened', OLD.id, OLD.status
    USING ERRCODE = 'check_violation',
          HINT = 'AG-067. Una entrada cerrada no vuelve a competir por un cupo: '
                 'si el paciente sigue esperando, inscríbalo de nuevo y la '
                 'entrada nueva empieza a contar antigüedad desde hoy.';
END;
$$;

CREATE TRIGGER trg_waitlist_entry_closure_final
  BEFORE UPDATE ON waitlist_entry
  FOR EACH ROW
  WHEN (
    OLD."status" IN ('SCHEDULED', 'EXPIRED', 'CANCELLED')
    AND (
      NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."converted_entry_id" IS DISTINCT FROM OLD."converted_entry_id"
    )
  )
  EXECUTE FUNCTION waitlist_entry_closure_is_final();

COMMENT ON TABLE "waitlist_entry" IS
  'AG-060 a AG-067. Quién espera un cupo en qué sede y entre qué fechas. No guarda ni la prioridad (se deriva de los grupos vigentes, PA-041) ni el recuento de llamadas (se deriva de waitlist_contact_attempt).';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4 · EL PARÁMETRO DE AG-094 QUE NUNCA SE MIGRÓ
-- ═══════════════════════════════════════════════════════════════════════════
--
-- AG-094 enumera lo que cada sede configura y termina con «y el número máximo
-- de intentos de contacto de la lista de espera». `site_parameter` tiene los
-- otros siete y nunca tuvo éste, porque E5 no se había abierto: AG-066 —«SI una
-- entrada alcanza el número máximo de intentos de contacto de la sede, ENTONCES
-- márquela EXPIRED»— no tenía de dónde leer el número. Entra aquí, con el resto
-- del esquema de E5, para que la tanda que escriba el servicio no necesite una
-- migración propia.
--
-- ⚠️ EL NÚMERO ES UNA DECISIÓN DEL USUARIO, NO NUESTRA. D-001 fijó los valores
-- de arranque de los otros parámetros y no incluyó éste. Queda registrado en
-- `DECISIONES-PENDIENTES.md` con su recomendación; mientras tanto la columna
-- nace en 3, que es lo que hace falta para que la sede TENGA un valor y no para
-- decidir por nadie: es un parámetro por sede, cambiable sin desplegar código
-- (REQ-145), así que equivocarse en el defecto cuesta una pantalla, no una
-- migración.
--
-- EL RANGO SÍ ES NUESTRO Y NO ES ADORNO. En 0 la entrada caducaría antes del
-- primer intento y la lista no llamaría a nadie; por encima de 10, «agotar los
-- intentos» deja de cerrar nada y el cupo se queda retenido días esperando a
-- quien no contesta.
ALTER TABLE "site_parameter"
  ADD COLUMN "waitlist_max_contact_attempts" int NOT NULL DEFAULT 3;

ALTER TABLE "site_parameter"
  ADD CONSTRAINT "site_parameter_waitlist_max_contact_attempts_range"
  CHECK ("waitlist_max_contact_attempts" BETWEEN 1 AND 10);

COMMENT ON COLUMN "site_parameter"."waitlist_max_contact_attempts" IS
  'AG-066, AG-094. Cuántos intentos de contacto agotan una entrada de lista de espera en esta sede.';
