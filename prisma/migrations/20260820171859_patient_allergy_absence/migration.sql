-- patient_allergy_absence
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- «SIN ALERGIAS CONOCIDAS» DEJA DE SER UNA CASILLA VACÍA (EN-087, D-A-018)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El *International Patient Summary* de HL7 —alineado con ISO 27269— distingue
-- `nilknown` de `notasked`, y la definición de `nilknown` lleva esta frase, que
-- es la que casi nadie implementa:
--
--   «Esto es una afirmación positiva por parte de un usuario clínico, y no una
--    posición por defecto afirmada por un sistema informático a falta de otra
--    información.»
--
-- Hoy `patient_allergy` sólo sabe decir qué se registró. Una ficha sin filas es
-- indistinguible de una ficha en la que nadie preguntó, así que el sistema no
-- puede afirmar «no tiene alergias» sin inventarlo — y el falso negativo que
-- eso produce es el que hace daño: el médico que lee «ninguna» y prescribe.
--
-- Esta tabla es el tercer estado, y no es una columna de `patient` porque lo
-- que hay que guardar no es un booleano: es UN ACTO, con su autor y su
-- instante. «Sin alergias conocidas (Dra. Villacís, 14-03-2026)» no es lo mismo
-- que «alergias: no registradas», y la diferencia entre las dos frases es
-- exactamente `asserted_by` y `asserted_at`.
--
-- ⚠️ LO QUE ESTA MIGRACIÓN *NO* HACE. No añade autor a `patient_allergy`
-- (EN-086) ni la tabla de antecedentes (EN-085). Siguen bloqueadas por esquema
-- y siguen escritas como tales en el SPEC: resolverlas de paso, sin su
-- requisito y sin sus pruebas, es cómo se cuela una tabla que nadie diseñó.
--
-- Después: pnpm migrations:check && pnpm db:deploy


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. LA AFIRMACIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- UNA FILA POR AFIRMACIÓN, Y NUNCA SE EDITA. La alternativa evidente —una fila
-- por ficha que se va sobrescribiendo— pierde la afirmación anterior, y la
-- pregunta «¿desde cuándo consta que no tiene alergias, y quién lo dijo?» pasa
-- a tener una sola respuesta: la última. Con la vigente basta para pintar la
-- banda; con el registro entero se puede reconstruir qué sabía el médico que
-- prescribió en marzo, que es la pregunta de un juicio.
CREATE TABLE "patient_allergy_absence" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  -- La ficha EN LA QUE SE ESCRIBIÓ, como todo lo demás que le ocurre a la
  -- persona (D-031): una fusión no repunta nada y la superviviente lee por el
  -- enlace. `CASCADE` como `patient_allergy`, por lo mismo.
  "patient_id" UUID NOT NULL,

  -- QUIÉN LO AFIRMÓ. `NOT NULL` y con clave foránea, y ésta es la columna por
  -- la que existe la tabla: sin ella esto vuelve a ser «el sistema no encontró
  -- nada», que es justo lo que el estándar prohíbe llamar «sin alergias
  -- conocidas». `RESTRICT` de vuelta: una cuenta se desactiva, nunca se borra
  -- (AU-024), y el rastro nombra a quien lo dijo.
  "asserted_by" UUID NOT NULL,

  "asserted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "patient_allergy_absence_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "patient_allergy_absence"
  ADD CONSTRAINT "patient_allergy_absence_patient_id_fkey"
  FOREIGN KEY ("patient_id") REFERENCES "patient"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "patient_allergy_absence"
  ADD CONSTRAINT "patient_allergy_absence_asserted_by_fkey"
  FOREIGN KEY ("asserted_by") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- La lectura es siempre la misma: «la afirmación más reciente de esta ficha».
-- El orden va en el índice para que responderla no recorra el historial de la
-- ficha, que con los años es todo lo que hay.
CREATE INDEX "patient_allergy_absence_by_chart"
  ON "patient_allergy_absence" ("patient_id", "asserted_at" DESC);

COMMENT ON TABLE "patient_allergy_absence" IS
  'EN-087, D-A-018. «Sin alergias conocidas» AFIRMADO POR UN CLÍNICO, con '
  'quién y cuándo — el `nilknown` del International Patient Summary de HL7. '
  'No es un booleano de la ficha: es un acto. Una ficha sin filas aquí y sin '
  'alergias registradas significa «no se preguntó» (`notasked`), nunca «no '
  'tiene».';

COMMENT ON COLUMN "patient_allergy_absence"."asserted_by" IS
  'EN-087. El clínico que lo afirmó. Es la columna por la que existe la tabla: '
  'el estándar exige «una afirmación positiva por parte de un usuario clínico, '
  'y no una posición por defecto afirmada por un sistema informático».';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. NO SE EDITA NI SE BORRA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Por lo mismo que `patient_merge` y `access_audit`: una afirmación clínica
-- fechada y firmada que se puede reescribir no es una afirmación, es una
-- casilla. Si mañana aparece una alergia, se REGISTRA la alergia —que es lo
-- que deja de contar esta fila (sección 3)—; si hay que volver a afirmar que no
-- hay ninguna, se afirma otra vez y son dos filas.
--
-- Disparador y no `REVOKE`: la aplicación conecta como propietaria de la tabla
-- y un propietario conserva sus privilegios aunque se le revoquen.
CREATE OR REPLACE FUNCTION patient_allergy_absence_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'patient_allergy_absence is append-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Una afirmación clínica no se corrige: se registra la alergia '
                 'que la deja sin efecto, o se afirma otra vez.';
END;
$$;

CREATE TRIGGER trg_patient_allergy_absence_immutable
  BEFORE UPDATE OR DELETE ON "patient_allergy_absence"
  FOR EACH ROW
  EXECUTE FUNCTION patient_allergy_absence_insert_only();

-- `TRUNCATE` no dispara los `FOR EACH ROW`: necesita el suyo.
CREATE TRIGGER trg_patient_allergy_absence_no_truncate
  BEFORE TRUNCATE ON "patient_allergy_absence"
  FOR EACH STATEMENT
  EXECUTE FUNCTION patient_allergy_absence_insert_only();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. NO SE PUEDE AFIRMAR «NINGUNA» SOBRE UNA FICHA QUE TIENE ALERGIAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Las dos cosas a la vez son una contradicción escrita en la historia clínica,
-- y de las que se leen mal: el médico que ve «sin alergias conocidas» deja de
-- mirar la lista.
--
-- POR QUÉ ADEMÁS DEL SERVICIO. El servicio lo comprueba y da un mensaje que se
-- puede leer, que es lo que un `CHECK` nunca hace. Lo que el servicio no puede
-- es arbitrar dos peticiones simultáneas: registrar la alergia y afirmar que no
-- hay ninguna leen las dos un estado que deja de ser cierto un milisegundo
-- después, y las dos escriben. Sólo la base decide eso.
--
-- ⚠️ LA FICHA Y LAS QUE ABSORBIÓ (PA-055), el mismo predicado que
-- `chartScopeIds`. Mirar sólo `NEW.patient_id` dejaría afirmar «ninguna» sobre
-- una ficha cuya alergia a la penicilina vive en la absorbida — que es PA-009
-- con una receta al final. El enlace es de un solo nivel:
-- `trg_patient_merge_not_chained` impide A→B→C (PA-046).
--
-- ⚠️ SE COMPRUEBA AL INSERTAR Y NO AL REGISTRAR UNA ALERGIA. Registrar una
-- alergia después de la afirmación es lo NORMAL —se preguntó, no había, y en
-- octubre apareció una— y no invalida nada retroactivamente: la afirmación
-- siguió siendo cierta hasta ese día. Lo que hace la lectura es dejar de
-- servirla, porque una afirmación anterior a la alergia ya no es la última
-- palabra sobre la ficha.
CREATE OR REPLACE FUNCTION patient_allergy_absence_needs_empty_chart()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "patient_allergy" AS allergy
     WHERE allergy."refuted_at" IS NULL
       AND allergy."patient_id" IN (
             SELECT chart."id"
               FROM "patient" AS chart
              WHERE chart."id" = NEW."patient_id"
                 OR chart."merged_into_id" = NEW."patient_id"
           )
  ) THEN
    RAISE EXCEPTION
      'chart % has active allergies: an absence assertion would contradict them',
      NEW."patient_id"
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Descarte primero las alergias que ya no sean válidas, con '
                   'su motivo. «Sin alergias conocidas» y una lista con filas '
                   'no pueden ser las dos ciertas.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_patient_allergy_absence_empty_chart
  BEFORE INSERT ON "patient_allergy_absence"
  FOR EACH ROW
  EXECUTE FUNCTION patient_allergy_absence_needs_empty_chart();
