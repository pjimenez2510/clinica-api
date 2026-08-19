-- patient_country_of_nationality
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- DE QUÉ PAÍS ES EL PACIENTE (PA-053, REQ-166, D-036 opción C)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `patient.nationality_concept_id` existe desde la primera migración y desde el
-- 17-08-2026 está sembrado, pero apunta al catálogo `NATIONALITY`, que en el
-- RDACAA es la NACIONALIDAD O PUEBLO INDÍGENA —Kichwa, Shuar, Awa— y no el
-- país: el formulario del ministerio sólo activa ese campo cuando la
-- autoidentificación étnica es «Indígena».
--
-- Consecuencia: hoy una ficha NO PUEDE DECIR QUE ALGUIEN ES VENEZOLANO, y en
-- Ecuador eso es una parte grande de la demanda diaria. Son dos datos
-- distintos y hacen falta los dos —el primero lo exige el reporte al
-- ministerio, el segundo lo exige saber quién es el paciente—, así que son dos
-- columnas. Fusionarlas obliga a elegir entre cumplir el reporte y poder
-- registrar de dónde es la persona, y descubrirlo en el primer reporte
-- devuelto obliga a reinterpretar hacia atrás un dato que ya no se le puede
-- volver a preguntar a nadie.
--
-- Después: pnpm migrations:check && pnpm db:deploy


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. EL PAÍS, COMO CÓDIGO DE TEXTO Y NO COMO CLAVE FORÁNEA AL CATÁLOGO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La alternativa evidente era otra referencia a `catalog_concept`, como las
-- cuatro que la ficha ya tiene (etnia, nacionalidad indígena, parroquia,
-- identidad de género). Se descarta, y el motivo está TRES TABLAS MÁS ALLÁ:
-- `patient_identifier.issuing_country` ya guarda un país —el emisor del
-- documento— como `CHAR(3)` con el mismo estándar `ISO 3166-1 alpha-3`.
--
-- DOS REPRESENTACIONES DEL MISMO DATO EN LA MISMA BASE ES LO QUE GARANTIZA QUE
-- UN DÍA DISCREPEN. Con un `uuid` de concepto aquí y tres letras allí, nadie
-- puede cruzar «pacientes de nacionalidad venezolana» con «documentos emitidos
-- en Venezuela» sin una unión que hay que acordarse de escribir, y el día que
-- el catálogo cargue otra release con una fila nueva para el mismo país, las
-- dos columnas dejan de contar lo mismo.
--
-- El catálogo `COUNTRY` (`prisma/seed-countries.mts`, 249 países del UNTERM y
-- la M49 de la ONU) SIGUE HACIENDO FALTA y no se toca: es de donde la pantalla
-- ELIGE —nadie en el mostrador sabe que Venezuela es `VEN`— y de donde sale el
-- NOMBRE que la ficha devuelve (ADR-005 §5: un código que quien lo lee no
-- puede interpretar no es información). Lo que se GUARDA es el código.
ALTER TABLE "patient"
  ADD COLUMN "country_of_nationality_code" CHAR(3);

COMMENT ON COLUMN "patient"."country_of_nationality_code" IS
  'PA-053, REQ-166. País de nacionalidad del paciente en ISO 3166-1 alpha-3. '
  'NO es nationality_concept_id, que es la nacionalidad o pueblo indígena del '
  'RDACAA (PA-027) y se activa sólo si la etnia es indígena. Texto y no clave '
  'foránea, por lo mismo que patient_identifier.issuing_country: dos '
  'representaciones del país en la misma base acaban discrepando. El nombre '
  'se resuelve del catálogo COUNTRY al leer la ficha.';

-- LA FORMA LA HACE CUMPLIR LA BASE, porque una importación no pasa por el DTO.
--
-- Mismo argumento que el dígito verificador de la cédula
-- (`patient_identifier_cedula_valid`) y que el subconjunto registrable de
-- grupos prioritarios: el servicio explica qué corregir mientras el paciente
-- sigue en el mostrador, la base impide que la fila mala exista. Una carga de
-- datos del registro anterior con `ec`, `Ecu` o `ECUADOR` produciría un país
-- que ningún catálogo puede nombrar y que no cruza con `issuing_country`.
--
-- TRES LETRAS MAYÚSCULAS Y NADA MÁS. `CHAR(3)` rellena con espacios a la
-- derecha, así que `'ec'` se almacena como `'ec '` y el patrón lo rechaza por
-- las dos razones. Que el CHECK sea de FORMA y no de pertenencia al catálogo
-- es deliberado: un `CHECK` no puede consultar otra tabla, y quien decide si
-- `XXX` existe es el servicio contra `COUNTRY` (PA-053), con un error por
-- campo que dice qué hacer.
ALTER TABLE "patient"
  ADD CONSTRAINT "patient_country_of_nationality_format"
  CHECK (
    "country_of_nationality_code" IS NULL
    OR "country_of_nationality_code" ~ '^[A-Z]{3}$'
  );

COMMENT ON CONSTRAINT "patient_country_of_nationality_format" ON "patient" IS
  'PA-053. El país de nacionalidad es un ISO 3166-1 alpha-3: tres letras '
  'mayúsculas. Que exista en el catálogo COUNTRY lo comprueba el servicio; un '
  'CHECK no puede consultar otra tabla.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. EL CAMPO NUEVO ENTRA EN LA LISTA BLANCA DE LO CORREGIBLE (PA-031)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `patient_change_history_field_known` enumera qué campos puede nombrar el
-- histórico de la ficha, y `patient-corrections.ts` repite la lista en
-- `CORRECTABLE_PATIENT_FIELDS` — hay una prueba que compara las dos. Sin este
-- bloque, corregir el país escribiría la fila del paciente y la base rechazaría
-- su rastro: la transacción entera se caería con un CHECK incomprensible, o
-- —peor, si algún día el rastro dejara de ir en la misma transacción— el dato
-- cambiaría sin dejar «desde qué valor», que es justo lo que PA-031 promete y
-- lo que REQ-113 necesita para poder rectificar.
--
-- SE REHACE, NO SE EDITA. La migración que lo creó
-- (20260817013225_patient_record_corrections) ya está aplicada, y una
-- restricción aplicada no se modifica retocando el archivo de ayer: se borra y
-- se vuelve a crear aquí, con la lista completa a la vista. La lista se escribe
-- ENTERA y no «la de antes más una» porque un `CHECK` no se puede ampliar en
-- PostgreSQL, y porque leer la lista vigente en un solo sitio es lo que permite
-- compararla con el dominio de un vistazo.
--
-- El `mrn` sigue sin estar y sigue sin deber estarlo (PA-002): es el ancla de
-- identidad, no un dato de la ficha.
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
    'residenceParishConceptId',
    'genderIdentityConceptId',
    'countryOfNationalityCode',
    'motherPatientId'
  ));
