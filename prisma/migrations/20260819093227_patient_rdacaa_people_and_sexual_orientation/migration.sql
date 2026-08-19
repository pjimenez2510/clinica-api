-- patient_rdacaa_people_and_sexual_orientation
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LAS DOS COLUMNAS DEL FORMULARIO QUE ESTE SISTEMA NO TENÍA (PA-056, PA-057)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Salen de leer el instructivo oficial del RDACAA 2.0 —SNS-MSP / Form. 504,
-- abril de 2019—, que el usuario consiguió el 19-08-2026, y de la decisión
-- D-039 que lo siguió. Son dos columnas del formulario del ministerio que la
-- ficha no sabía guardar, así que su casilla salía vacía en el reporte mensual
-- y nadie podía saber que faltaba:
--
--   * `people_concept_id`            — columna 14, «Pueblos» (§ 1.4.14).
--   * `sexual_orientation_concept_id` — columna 7, «Orientación sexual»
--                                       (§ 1.4.7).
--
-- Las dos son REFERENCIAS A `catalog_concept`, como la etnia, la nacionalidad
-- indígena, la parroquia y la identidad de género, y no enumeraciones: el
-- ministerio revisa sus listas entre ediciones y una ficha de hace tres años
-- tiene que seguir mostrando la categoría con la que se registró (PA-026). El
-- país es la excepción y lo sigue siendo por su propio motivo (PA-053): allí
-- hay OTRA representación del mismo dato tres tablas más allá.
--
-- ⚠️ LAS DOS CONDICIONES DEL INSTRUCTIVO NO ESTÁN AQUÍ, Y NO ES UN OLVIDO.
-- «El pueblo sólo si la nacionalidad indígena es Kichwa» depende de QUÉ FILA
-- del catálogo `NATIONALITY` es «Kichwa», y un `CHECK` no consulta otra tabla;
-- «la orientación sexual a partir de los diez años» depende de la edad
-- DERIVADA de la fecha de nacimiento en `America/Guayaquil`, que se mueve sola
-- con el calendario y convertiría una fila válida en inválida sin que nadie la
-- toque. Las dos viven en el servicio, exactamente por lo mismo que PA-027 y
-- PA-059. Quien busque aquí la garantía no la va a encontrar, y esa es la
-- consecuencia asumida: una importación o un `INSERT` por `psql` pueden
-- escribir la combinación contradictoria.
--
-- Después: pnpm migrations:check && pnpm db:deploy


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. «PUEBLOS», LA COLUMNA 14 (PA-056)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Tercer escalón de una cadena que ya tenía dos —etnia → nacionalidad indígena
-- → pueblo—, cada uno condicionado al anterior. Los 18 códigos del instructivo
-- entran como catálogo `PEOPLE` con su release (`prisma/seed-rdacaa.mts`), con
-- la misma disciplina que los otros: versión, origen y checksum del archivo.
ALTER TABLE "patient"
  ADD COLUMN "people_concept_id" UUID;

ALTER TABLE "patient"
  ADD CONSTRAINT "patient_people_concept_id_fkey"
  FOREIGN KEY ("people_concept_id") REFERENCES "catalog_concept"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON COLUMN "patient"."people_concept_id" IS
  'PA-056, REQ-022. Pueblo del paciente: columna 14 del RDACAA, catálogo '
  'PEOPLE. El instructivo lo activa SÓLO cuando la nacionalidad indígena es '
  '«Kichwa» (columna 13), y esa condición la hace cumplir el servicio: '
  'depende de qué fila del catálogo NATIONALITY es Kichwa, y un CHECK no '
  'consulta otra tabla.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. «ORIENTACIÓN SEXUAL», LA COLUMNA 7 (PA-057, PA-058)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ ES DATO DE CATEGORÍA ESPECIAL BAJO LA LOPDP, y eso no se ve en el SQL:
-- se escribe con `patient:write`, como el resto de la ficha del RDACAA, y se
-- LEE tras un permiso propio —`patient:sexual-orientation`, que no trae ningún
-- rol de fábrica— por una ruta aparte que deja su fila de bitácora (PA-058).
-- Quien añada un `select` de esta columna a una lectura de la ficha o del
-- listado estará quitando esa puerta sin que nada falle: la única defensa es
-- que aquí lo diga y que las pruebas de PA-058 lo afirmen sobre la respuesta.
ALTER TABLE "patient"
  ADD COLUMN "sexual_orientation_concept_id" UUID;

ALTER TABLE "patient"
  ADD CONSTRAINT "patient_sexual_orientation_concept_id_fkey"
  FOREIGN KEY ("sexual_orientation_concept_id") REFERENCES "catalog_concept"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON COLUMN "patient"."sexual_orientation_concept_id" IS
  'PA-057, PA-058, REQ-022. Orientación sexual: columna 7 del RDACAA, '
  'catálogo SEXUAL_ORIENTATION. DATO DE CATEGORÍA ESPECIAL (LOPDP): no viaja '
  'en la ficha ni en el listado, y su lectura exige el permiso '
  'patient:sexual-orientation. El instructivo la pide a partir de los 10 '
  'años, y ese umbral lo hace cumplir el servicio: la edad se deriva y un '
  'CHECK sobre ella caducaría con el calendario.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. LOS DOS CAMPOS NUEVOS ENTRAN EN LA LISTA BLANCA DE LO CORREGIBLE (PA-031)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `patient_change_history_field_known` enumera qué campos puede nombrar el
-- histórico de la ficha, y `patient-corrections.ts` repite la lista en
-- `CORRECTABLE_PATIENT_FIELDS` — hay una prueba que compara las dos. Sin este
-- bloque, corregir el pueblo o la orientación sexual escribiría la fila del
-- paciente y la base rechazaría su rastro, tirando la transacción entera con
-- un CHECK incomprensible.
--
-- Y para la orientación sexual el rastro NO es un adorno: es dato de categoría
-- especial, y `patient_change_history` es la única tabla de rastro del sistema
-- SIN disparador de inmutabilidad, justo para que REQ-113 se pueda ejercer
-- sobre lo que guarda. Fuera de ella, corregir ese dato no dejaría «desde qué
-- valor»; dentro de `access_audit`, no se podría borrar nunca.
--
-- SE REHACE, NO SE EDITA la migración que la creó: un `CHECK` no se amplía en
-- PostgreSQL, y leer la lista vigente entera en un solo sitio es lo que
-- permite compararla con el dominio de un vistazo. El `mrn` sigue sin estar y
-- sigue sin deber estarlo (PA-002).
ALTER TABLE "patient_change_history"
  DROP CONSTRAINT "patient_change_history_field_known";

ALTER TABLE "patient_change_history"
  ADD CONSTRAINT "patient_change_history_field_known"
  CHECK ("field" IN (
    'familyName',
    'secondFamilyName',
    'givenName',
    'secondGivenName',
    'sex',
    'birthDate',
    'birthDateEstimated',
    'deceasedAt',
    'phone',
    'email',
    'residenceAddressLine',
    'bloodType',
    'ethnicityConceptId',
    'nationalityConceptId',
    'peopleConceptId',
    'sexualOrientationConceptId',
    'residenceParishConceptId',
    'genderIdentityConceptId',
    'countryOfNationalityCode',
    'motherPatientId'
  ));
