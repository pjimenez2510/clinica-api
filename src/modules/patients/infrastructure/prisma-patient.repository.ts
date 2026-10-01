import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import {
  chartScope,
  chartScopeIds,
  chartScopeRows,
  chartScopeSelect,
} from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  lockRestsOfCharts,
  maternityRestOverlapsOnMerge,
} from '../../../shared/infrastructure/prisma/rests-on-merge';
import {
  reEnrolOpenWaitlistEntries,
  reEnrolledWaitlistEntryIdsOf,
  reEnrolledWaitlistEntrySnapshot,
  undoWaitlistReEnrolment,
} from '../../../shared/infrastructure/prisma/waitlist-follows-merge';
import { parishLocationOf } from '../domain/dpa-parish';
import {
  PROVISIONAL_IDENTIFIER_TYPE,
  isDefinitiveDocument,
} from '../domain/identity-document';
import { formatMrn } from '../domain/mrn';
import { patientAgeOn } from '../domain/patient-age';
import {
  planCorrection,
  type CorrectablePatientField,
  type PatientCorrectionRequest,
  type PatientCorrectionSnapshot,
  type PatientFieldChange,
} from '../domain/patient-corrections';
import {
  DuplicateIdentifierError,
  PatientMergedError,
} from '../domain/patient.errors';
import { ABSORBED_MRN_LIMIT } from '../domain/patient.repository';
import type {
  AgendaEntryContext,
  AbsorbedCharts,
  AppliedCorrection,
  CatalogConceptReference,
  CatalogReference,
  CountryReference,
  IdentifierType,
  LinkedRecordCounts,
  MergeOutcome,
  NewPatient,
  NewPriorityGroup,
  ParishReference,
  PatientCorrectionState,
  PatientSortField,
  PatientDetail,
  PatientIdentifier,
  PatientMergeEvent,
  PatientMergeState,
  PatientPage,
  PatientRepository,
  PatientSearchCriteria,
  PatientSummary,
  PriorityGroupRecord,
  SexualOrientationRead,
  UndoMergeOutcome,
} from '../domain/patient.repository';
import { rdacaaMissingFields } from '../domain/rdacaa-completeness';
import { priorityLevelOf } from '../../../shared/domain/priority-level';
import {
  clinicalDateToday,
  type PriorityGroup,
  type PriorityGroupOrigin,
} from '../domain/priority-groups';

/**
 * Rows in, domain shapes out.
 *
 * Everything Prisma-shaped stops here. The application above never sees a
 * `Prisma.` type, which is what makes the search strategy below replaceable.
 */

/**
 * El catálogo del que se leen los nombres de provincia y cantón (PA-028).
 *
 * SE ESCRIBE AQUÍ Y NO SE IMPORTA DE `catalogs`: ningún módulo importa de otro,
 * y `patients` ya trata con este mismo catálogo por su propio puerto —ver
 * `EXPECTED_SYSTEM` en el servicio, que es quien valida que la referencia
 * enviada sea del DPA y no de otra lista—.
 */
const DPA_SYSTEM_CODE = 'DPA';

/**
 * El catálogo del que sale el NOMBRE del país guardado (PA-053).
 *
 * Se escribe aquí por lo mismo que el de arriba, y lo que se le pregunta es
 * «cómo se llama `VEN`». La ficha no guarda una fila de este catálogo: guarda
 * el código, igual que `patient_identifier.issuing_country`.
 */
const COUNTRY_SYSTEM_CODE = 'COUNTRY';

/**
 * PA-041 y PA-042. Los dos campos con los que se calcula la prioridad, y
 * NINGUNO que diga por qué.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO HAY `groupCode` EN ESTE `select`, Y ES LA MITAD DE LA GARANTÍA.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El nivel depende de si HAY alguna valoración vigente, nunca de CUÁL, así que
 * el motivo no hace falta para calcularlo. Dejándolo fuera de la consulta,
 * «el motivo no viaja en ningún listado» deja de ser una regla que alguien
 * tiene que recordar al mapear la respuesta: el dato no sale de la base. El
 * motivo tiene su propia consulta, su propio permiso y su propia fila de
 * bitácora (PA-040).
 */
const PRIORITY_PERIOD_SELECT = {
  select: { startsOn: true, endsOn: true },
} satisfies Prisma.Patient$priorityGroupsArgs;

/** The columns a list row needs, and no clinical data at all. */
const SUMMARY_SELECT = {
  id: true,
  /**
   * PA-055, D-038. LOS PERIODOS DE ESTA FICHA **Y LOS DE LAS QUE ABSORBIÓ**.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ES LA CONSECUENCIA VISIBLE DE D-038, Y ES LA CORRECTA.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Una embarazada cuyo embarazo está registrado en la ficha absorbida dejaba
   * de constar como prioritaria en cuanto se fusionaba: `priorityGroups` a
   * secas trae la relación de ESTA fila y de ninguna otra, así que ningún
   * `patient_id` aparecía en la consulta y nada podía fallar. Ahora la
   * prioridad calculada de la superviviente PUEDE CAMBIAR al fusionar, y la
   * agenda la ordena antes (PA-041, AG-062). Es la misma persona.
   *
   * SIGUE SIENDO UNA SOLA CONSULTA. `relationJoins` está activo (ver la
   * cabecera de `schema.prisma`), así que esto viaja como un `LEFT JOIN
   * LATERAL` dentro de la misma sentencia, resuelto por el índice PARCIAL
   * `patient_absorbed_charts`. La inmensa mayoría de las fichas no absorbió a
   * ninguna y el join no encuentra nada que recorrer, que es lo que lo hace
   * admisible en un listado que se dispara con cada letra tecleada (PA-021).
   *
   * Y SIGUE SIN HABER `groupCode`: el motivo no viaja en ningún listado
   * (PA-042, SC-010), tampoco el de la absorbida.
   */
  ...chartScopeSelect('priorityGroups', PRIORITY_PERIOD_SELECT),
  mrn: true,
  familyName: true,
  secondFamilyName: true,
  givenName: true,
  secondGivenName: true,
  sex: true,
  birthDate: true,
  birthDateEstimated: true,
  deceasedAt: true,
  /**
   * PA-032. Las tres referencias, como COLUMNAS y no como joins.
   *
   * Es lo que permite decir «a esta ficha le falta la etnia» en cada fila del
   * listado sin resolver cuatro conceptos por paciente en una búsqueda que se
   * dispara con cada letra tecleada (PA-021). La redacción del concepto sólo
   * hace falta al abrir la ficha, y allí sí se une.
   */
  ethnicityConceptId: true,
  nationalityConceptId: true,
  residenceParishConceptId: true,
  /**
   * AND THE COUNTRY, WHICH IS A GATE AND NOT A REQUIRED DATUM (PA-032, PA-059).
   *
   * A foreign chart must NOT be told it is missing the ethnicity or the
   * nationality — the ministry says to leave columns 12 to 14 blank and PA-059
   * refuses to record them — so the indicator needs to know the country on
   * EVERY ROW OF THE LISTING too, which is where admission works from. It is a
   * plain column: no join, no cost. The country's NAME is another matter and
   * still travels only on the chart (PA-053, PA-021).
   */
  countryOfNationalityCode: true,
  /**
   * AND THE ETHNICITY'S `code` BESIDES ITS ID (PA-032, D-037).
   *
   * The indicator no longer counts the nationality on a chart whose ethnicity
   * is recorded and is not «Indígena» — PA-027 forbids filling it in — and
   * telling which one it is needs the catalogue code: the id on its own says
   * the question was asked, not what was answered.
   *
   * ⚠️ NOT ONE QUERY MORE. `relationJoins` is on (see the header of
   * `schema.prisma`), so this travels as a `LEFT JOIN LATERAL` inside the same
   * statement instead of the second query Prisma would emit without it. That is
   * what lets it into a listing that fires on every keystroke (PA-021). ONLY
   * THE CODE: the concept's wording is still joined when a chart is opened and
   * nowhere else.
   */
  ethnicity: { select: { code: true } },
  /**
   * EL PRIMER DOCUMENTO DEFINITIVO, y el filtro por tipo es la mitad que
   * faltaba (PA-014, PA-015, PA-032).
   *
   * De esta consulta salen DOS respuestas —cuál es el documento que citaría
   * una recepcionista y si la ficha tiene documento— y las dos son sobre un
   * documento DEFINITIVO. Con `take: 1` sobre todos los activos, un marcador
   * `PROVISIONAL` creado antes de la cédula era el que salía por las dos.
   *
   * Se filtra EN SQL en vez de traerse la ficha entera y descartar aquí: este
   * `select` sirve cada fila de un listado que se dispara con cada letra
   * tecleada (PA-021), y `take: 1` es lo que impide que una ficha con seis
   * documentos cueste seis filas por fila de pantalla. `toSummary` vuelve a
   * aplicar el predicado de dominio de todas formas, porque `findById` sí trae
   * la lista completa para poder devolverla entera.
   */
  identifiers: {
    where: { validTo: null, type: { not: PROVISIONAL_IDENTIFIER_TYPE } },
    select: { type: true, issuingCountry: true, value: true },
    orderBy: { createdAt: 'asc' },
    take: 1,
  },
} satisfies Prisma.PatientSelect;

/** Lo que hace falta para poner nombre a una referencia guardada. */
const CONCEPT_SELECT = {
  select: { id: true, code: true, display: true },
} satisfies Prisma.Patient$ethnicityArgs;

/** Los veinte campos corregibles, más a dónde se movió la ficha. */
const CORRECTION_SELECT = {
  familyName: true,
  secondFamilyName: true,
  givenName: true,
  secondGivenName: true,
  sex: true,
  birthDate: true,
  birthDateEstimated: true,
  deceasedAt: true,
  phone: true,
  email: true,
  residenceAddressLine: true,
  bloodType: true,
  ethnicityConceptId: true,
  nationalityConceptId: true,
  peopleConceptId: true,
  sexualOrientationConceptId: true,
  residenceParishConceptId: true,
  genderIdentityConceptId: true,
  countryOfNationalityCode: true,
  motherPatientId: true,
  employerName: true,
  jobTitle: true,
  mergedInto: { select: { mrn: true } },
} satisfies Prisma.PatientSelect;

/**
 * Las columnas que una corrección escribe, COMPROBADAS CONTRA PRISMA.
 *
 * `Pick` sobre el tipo de actualización es lo que convierte «el nombre de
 * dominio y el del modelo coinciden» en algo que el compilador verifica: si
 * `CORRECTABLE_PATIENT_FIELDS` gana un nombre que no es columna del paciente,
 * esta línea deja de compilar. Sin ella, escribir por clave dinámica pondría
 * el valor en una columna inexistente y Prisma lo diría en tiempo de ejecución
 * —o, peor, el CHECK de la base admitiría el rastro de un cambio que no se
 * aplicó—.
 */
type CorrectableColumns = Pick<
  Prisma.PatientUncheckedUpdateInput,
  CorrectablePatientField
>;

/**
 * Colación española, y no la de la base.
 *
 * La base está creada con colación `C`, que ordena por byte. Con eso
 * `Zambrano` va antes que `alvarez` —porque las mayúsculas tienen byte menor—
 * y `Ñaupa` cae detrás de TODO, después incluso de las minúsculas. Un listado
 * de pacientes donde los Ñaupa están al final es un apellido que nadie
 * encuentra, y en Ecuador no es un caso raro.
 *
 * `es-ES-x-icu` pone `Ñ` entre `N` y `O`, que es donde va en español, y deja de
 * separar por mayúsculas.
 *
 * NO se cambia la colación de la base entera: eso obligaría a recrearla y
 * reindexarla, y afectaría a comparaciones donde el orden byte a byte es lo
 * correcto y lo más rápido. Se aplica sólo donde se ordena para que lo lea una
 * persona.
 */
const SPANISH = 'COLLATE "es-ES-x-icu"';

/**
 * Del criterio de dominio a las expresiones de orden.
 *
 * UNA LISTA, no una cadena, y esa es la corrección. Antes esto era
 * `'p.family_name, p.given_name'` y se concatenaba la dirección al final:
 *
 *     ORDER BY p.family_name, p.given_name DESC
 *
 * En SQL la dirección se aplica a UNA expresión, no a la lista: eso ordena el
 * apellido ASCENDENTE y sólo el nombre descendente. Como los apellidos casi
 * siempre difieren, el resultado de «descendente» era idéntico al de
 * «ascendente» — que es exactamente lo que se veía en pantalla.
 *
 * El mapa también permite que el cliente no conozca ni un nombre de columna:
 * pide «name» y aquí se decide que eso son dos columnas, apellido y nombre, en
 * ese orden — que es como se archiva a la gente en una clínica.
 */
const SORT_COLUMNS: Record<PatientSortField, readonly string[]> = {
  name: [`p.family_name ${SPANISH}`, `p.given_name ${SPANISH}`],
  mrn: ['p.mrn'],
  birthDate: ['p.birth_date'],
};

/**
 * The patient port over PostgreSQL. Search goes through raw SQL on the
 * generated `search_name` column; uniqueness, merge chains and immutability
 * are enforced by indexes and triggers, and this class translates their
 * refusals into the domain's errors.
 */
@Injectable()
export class PrismaPatientRepository implements PatientRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Name search over the accent-insensitive generated column, plus an exact
   * match on an identifier.
   *
   * RAW SQL, and not because Prisma is inadequate. `search_name` is a GENERATED
   * column created in a migration, and Prisma does not know it exists — adding
   * it to the schema would invite `prisma migrate dev` to try to manage a
   * column PostgreSQL computes, which is precisely the kind of drop this
   * project has already been bitten by twice.
   *
   * Going through SQL also removes a second hazard: normalising the query in
   * JavaScript to match what the column stores means two implementations of
   * "remove the accents" that must agree forever. They would not, and the
   * symptom would be a search that silently finds nothing. Calling the
   * database's own `immutable_unaccent` leaves exactly one implementation.
   *
   * TWO DIFFERENT SEARCHES ON PURPOSE. Names are typed half-remembered and
   * misspelt, so they go through the trigram index. A document number is
   * either right or it is a different person — searching for a "similar"
   * cedula would surface somebody else's chart, which is the worst possible
   * result on this screen.
   */
  async search(criteria: PatientSearchCriteria): Promise<PatientPage> {
    const query = criteria.query?.trim() ?? '';
    const pattern = `%${query}%`;
    const offset = (criteria.page - 1) * criteria.pageSize;

    // `Prisma.sql` with placeholders: never string concatenation. The query is
    // whatever a receptionist typed.
    const matches = Prisma.sql`
      p.merged_into_id IS NULL OR ${criteria.includeMerged}
    `;
    /**
     * PA-009. La madre, como un FILTRO MÁS y no como otra búsqueda.
     *
     * Se combina con el texto en vez de sustituirlo: al recién nacido se le
     * busca por su madre porque no tiene documento ni, a veces, nombre
     * todavía, pero el apellido sigue sirviendo para acotar entre hermanos.
     * `Prisma.empty` cuando no se pide, para no mandar un parámetro que
     * PostgreSQL tendría que tipar sin contexto.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * ⚠️ LA MADRE ES **LA FICHA Y LAS QUE ABSORBIÓ** (PA-055), Y NO ES UN
     * ADORNO: SIN ESTO, FUSIONAR A LA MADRE HACE DESAPARECER AL RECIÉN NACIDO
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El escenario, entero y corriente:
     *
     *   1. Se da de alta a la madre → ficha `A`.
     *   2. Se da de alta al recién nacido SIN documento, con `motherPatientId:
     *      A`. Es el caso normal de PA-003 y PA-009.
     *   3. Admisión descubre que la madre estaba duplicada y fusiona `A→B`.
     *   4. `GET /patients?motherId=B` devolvía CERO, y `GET /patients/A`
     *      responde 409 con el MRN de `B` (PA-045): nadie podía llegar a `A`.
     *
     * El neonato quedaba inalcanzable por el ÚNICO camino que tenía antes de
     * tener documento propio, así que se le volvía a registrar y su historia
     * se partía en dos — exactamente el duplicado que PA-009 existe para
     * evitar, provocado por la operación que existe para arreglarlos.
     *
     * `assertMotherExists` no cubría esto y no podía: defiende el instante de
     * ESCRIBIR el vínculo, y aquí la fusión ocurre después, sobre un vínculo
     * que ya era correcto cuando se escribió.
     *
     * `chartScopeIds` Y NO UN `OR` A MANO: es el mismo predicado que
     * `chartScope` en el ORM, escrito una sola vez (D-038, opción C), y
     * `patient-chart-scope.spec.ts` falla si esta comparación vuelve a
     * escribirse con un id desnudo.
     */
    const motherFilter =
      criteria.motherId === undefined
        ? Prisma.empty
        : Prisma.sql`AND p.mother_patient_id IN ${chartScopeIds(criteria.motherId)}`;
    /**
     * EL DOCUMENTO SE BUSCA POR PREFIJO, con un mínimo de cuatro dígitos.
     *
     * Coincidencia exacta era demasiado rígida: en el mostrador se teclean los
     * primeros dígitos mientras el paciente sigue leyendo la cédula en voz
     * alta, y obligar a escribir los diez completos hace que se abandone la
     * búsqueda y se registre un duplicado — el problema que el registro existe
     * para evitar.
     *
     * PREFIJO Y NO `%valor%`, y el mínimo de cuatro tampoco es capricho:
     *
     *  - Un `contains` sobre documentos convierte el buscador en un oráculo:
     *    con `7` se enumera medio registro. El prefijo sólo responde a quien
     *    ya sabe cómo empieza el número.
     *  - Menos de cuatro dígitos devuelve cientos de personas que no se
     *    buscaban, y de paso pierde el índice B-tree `varchar_pattern_ops`
     *    —que es exactamente el que sirve un `LIKE 'algo%'`—.
     *
     * El nombre sí va con `%…%`: se teclea a medias y mal, y no identifica a
     * nadie por sí solo.
     */
    /**
     * `Prisma.raw` SÓLO sobre valores que salen del mapa de arriba.
     *
     * Es la única forma de parametrizar un ORDER BY —PostgreSQL no admite un
     * placeholder ahí— y por eso el campo llega como una unión cerrada y la
     * dirección se normaliza a dos literales. Nada de lo que escribe el
     * usuario toca esta línea.
     */
    const direction = criteria.sortDirection === 'desc' ? 'DESC' : 'ASC';

    /**
     * La dirección en CADA columna, y un desempate final por id.
     *
     * El desempate no es cosmético: sin un orden total, dos pacientes con el
     * mismo apellido y nombre pueden intercambiarse entre dos consultas, y con
     * `LIMIT/OFFSET` eso hace que una fila aparezca dos veces en páginas
     * distintas o no aparezca en ninguna. `id` es único, así que basta.
     */
    const orderBy = [
      ...SORT_COLUMNS[criteria.sortBy].map(
        (column) => `${column} ${direction}`,
      ),
      `p.id ${direction}`,
    ].join(', ');

    /**
     * EL NÚMERO DE HISTORIA SE ESCRIBE COMO SE DICE.
     *
     * `HC0000000801` es lo que hay impreso en la carpeta, pero nadie lo dicta
     * así: se dice «la ochocientos uno». Exigir los diez dígitos y el prefijo
     * convertía el buscador en un ejercicio de transcripción, y un cero de más
     * o de menos no devolvía nada sin explicar por qué.
     *
     * Se normaliza a la parte numérica: `801`, `0801`, `hc801` y
     * `HC0000000801` son la misma historia. Sigue siendo COINCIDENCIA EXACTA
     * sobre ese número —no un prefijo—, así que teclear `80` no lista todas
     * las que empiezan por 80.
     */
    const mrnBuscado = normaliseMrn(query);

    const documentPrefix = `${query}%`;
    const searchesDocument = /^[A-Za-z0-9-]{4,}$/.test(query);

    /**
     * Las condiciones se COMPONEN, no se escriben todas siempre.
     *
     * Un parámetro suelto dentro de `IS NOT NULL` deja a PostgreSQL sin forma
     * de deducir su tipo y la consulta falla con `could not determine data type
     * of parameter`. Incluir sólo las condiciones que aplican evita el problema
     * y, de paso, no manda parámetros que no se van a usar.
     */
    const condiciones: Prisma.Sql[] = [
      Prisma.sql`p.search_name LIKE immutable_unaccent(lower(${pattern}))`,
    ];

    if (mrnBuscado !== null) {
      condiciones.push(Prisma.sql`p.mrn = ${mrnBuscado}`);
    }

    if (searchesDocument) {
      condiciones.push(Prisma.sql`EXISTS (
        SELECT 1 FROM patient_identifier pi
        WHERE pi.patient_id = p.id
          AND pi.valid_to IS NULL
          AND pi.value LIKE ${documentPrefix}
      )`);
    }

    const filter =
      query === ''
        ? Prisma.sql`TRUE`
        : Prisma.sql`(${Prisma.join(condiciones, ' OR ')})`;

    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id
      FROM patient p
      WHERE (${matches}) AND ${filter} ${motherFilter}
      ORDER BY ${Prisma.raw(orderBy)}
      LIMIT ${criteria.pageSize} OFFSET ${offset}
    `;

    const [{ count }] = await this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT count(*) AS count
      FROM patient p
      WHERE (${matches}) AND ${filter} ${motherFilter}
    `;

    // The ids come from SQL; the ROWS come back through Prisma so the shape
    // stays in one place and `select` cannot drift between the two paths.
    /**
     * El orden lo fija el SQL de arriba, no esta consulta.
     *
     * `WHERE id IN (...)` no conserva ningún orden, así que reordenar aquí con
     * un `orderBy` distinto daría una página ordenada de dos maneras a la vez.
     * Se reindexa por id contra la lista que ya vino ordenada.
     */
    const byId = new Map(
      (
        await this.prisma.patient.findMany({
          where: { id: { in: rows.map((r) => r.id) } },
          select: SUMMARY_SELECT,
        })
      ).map((row) => [row.id, row]),
    );
    const items = rows
      .map((r) => byId.get(r.id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);

    return {
      items: items.map((row) => this.toSummary(row)),
      total: Number(count),
    };
  }

  /**
   * The chart with every active identifier and its catalogue concepts joined
   * as they were recorded. Merged charts are returned too, carrying the MRN of
   * their survivor.
   */
  async findById(id: string): Promise<PatientDetail | null> {
    const row = await this.prisma.patient.findUnique({
      where: { id },
      select: {
        ...SUMMARY_SELECT,
        // The detail view needs every identifier, not only the first one: a
        // refugee card AND a later cedula are both part of who this person is.
        identifiers: {
          where: { validTo: null },
          select: { type: true, issuingCountry: true, value: true },
          orderBy: { createdAt: 'asc' },
        },
        phone: true,
        email: true,
        bloodType: true,
        residenceAddressLine: true,
        // PA-061.
        employerName: true,
        jobTitle: true,
        /**
         * Los conceptos elegidos, UNIDOS SÓLO AQUÍ (PA-026 a PA-029, PA-056).
         *
         * La redacción es la que se guardó, sin condición de vigencia: una
         * parroquia retirada del DPA no debe dejar en blanco la dirección de
         * alguien que no se ha mudado, ni una categoría del INEC reescrita
         * borrar la etnia con la que alguien se declaró. Mismo criterio que
         * `CatalogsService.byId`.
         */
        ethnicity: CONCEPT_SELECT,
        nationality: CONCEPT_SELECT,
        /**
         * PA-056. El pueblo, con la redacción con la que se registró.
         *
         * ⚠️ Y `sexualOrientation` NO ESTÁ AQUÍ, que es la mitad visible de
         * PA-058: es dato de categoría especial y se lee por su propia ruta,
         * con su propio permiso y su propia fila de bitácora
         * (`findSexualOrientation`). Añadirla a este `select` la pondría en la
         * respuesta que recibe todo el que tenga `patient:read` —recepción y
         * caja incluidas— sin que nada fallara.
         */
        people: CONCEPT_SELECT,
        genderIdentity: CONCEPT_SELECT,
        residenceParish: CONCEPT_SELECT,
        /**
         * PA-053. El país va como COLUMNA y no como unión: es un código, no
         * una fila del catálogo. El nombre se resuelve abajo.
         */
        countryOfNationalityCode: true,
        motherPatientId: true,
        isProvisional: true,
        createdAt: true,
        mergedInto: { select: { mrn: true } },
        /**
         * PA-054. EL MISMO ENLACE, LEÍDO HACIA ATRÁS.
         *
         * ═══════════════════════════════════════════════════════════════════
         * NI CONSULTA APARTE NI ESQUEMA NUEVO.
         * ═══════════════════════════════════════════════════════════════════
         *
         * Viaja dentro de este `findUnique`, junto a las uniones que la ficha
         * ya paga, y lo resuelve el índice PARCIAL `patient_absorbed_charts`
         * (`WHERE merged_into_id IS NOT NULL`), creado en la migración de P4
         * exactamente «para recorrer el enlace hacia atrás». Sin él cada
         * lectura barrería las 50 000 fichas de SC-007.
         *
         * SÓLO EL `mrn`: ni nombre, ni documento, ni fecha de nacimiento de la
         * absorbida (PA-025). Es lo único que este módulo publica ya de una
         * ficha ajena — es lo que nombra `PATIENT_MERGED` (PA-045).
         *
         * EL RECORTE A CINCO ES DE LA RESPUESTA, NO DE LA CONSULTA, y desde
         * PA-055 no puede ser de otra manera. Una ficha con veinte absorbidas
         * convierte el aviso en un muro, así que sólo viajan cinco MRN con el
         * total al lado — pero la PRIORIDAD CALCULADA se resuelve sobre los
         * periodos de TODAS ellas, y un `take: 5` en SQL escondería el
         * embarazo registrado en la sexta. El recorte vive por tanto en
         * `toAbsorbedCharts`, y el total es cuántas filas vinieron: con la
         * lista completa en la mano, `_count` sería una agregación de más para
         * contar lo que ya está contado.
         *
         * `mergedAt` ordena y no `createdAt`: lo que se enumera son FUSIONES,
         * y el orden en que se registraron las fichas no dice nada de ellas.
         * La columna no es nula en ninguna ficha absorbida —
         * `patient_merged_at_matches_link` obliga a que el enlace y el instante
         * vayan juntos—, así que el orden es total.
         *
         * ⚠️ EL `select` SE EXTIENDE, NO SE SUSTITUYE. Debajo de `mergedFrom`
         * viajan los periodos de prioridad que PA-055 necesita
         * (`SUMMARY_SELECT`), y escribir aquí un `select` nuevo los tiraría sin
         * que nada se quejara: la ficha volvería a esconder la prioridad de la
         * absorbida y sólo al abrirla, que es la mitad que peor se ve.
         */
        mergedFrom: {
          ...SUMMARY_SELECT.mergedFrom,
          select: { ...SUMMARY_SELECT.mergedFrom.select, mrn: true },
          orderBy: { mergedAt: 'asc' },
        },
      },
    });
    if (!row) return null;

    /**
     * La lista COMPLETA entra al resumen, que ya sabe quedarse con el primer
     * documento definitivo.
     *
     * Antes entraba `slice(0, 1)`: el primer activo, fuera cual fuera su tipo.
     * En una ficha con un marcador `PROVISIONAL` anterior a la cédula, eso
     * hacía que `primaryIdentifier` fuera el marcador y que la ficha se
     * declarase completa para el RDACAA sin documento de identidad.
     */
    return {
      ...this.toSummary(row),
      identifiers: row.identifiers.map(toIdentifier),
      phone: row.phone,
      email: row.email,
      bloodType: row.bloodType,
      residenceAddressLine: row.residenceAddressLine,
      employerName: row.employerName,
      jobTitle: row.jobTitle,
      ethnicity: toConceptReference(row.ethnicity),
      nationality: toConceptReference(row.nationality),
      people: toConceptReference(row.people),
      genderIdentity: toConceptReference(row.genderIdentity),
      countryOfNationality: await this.namedCountry(
        row.countryOfNationalityCode,
      ),
      residenceParish: await this.namedParish(
        toParishReference(row.residenceParish),
      ),
      motherPatientId: row.motherPatientId,
      isProvisional: row.isProvisional,
      mergedIntoMrn: row.mergedInto?.mrn ?? null,
      absorbedCharts: toAbsorbedCharts(
        row.mergedFrom.length,
        row.mergedFrom.slice(0, ABSORBED_MRN_LIMIT).map((chart) => chart.mrn),
      ),
      createdAt: row.createdAt,
    };
  }

  async findByIdentifier(
    identifier: PatientIdentifier,
  ): Promise<PatientSummary | null> {
    const row = await this.prisma.patient.findFirst({
      where: {
        mergedIntoId: null,
        identifiers: {
          some: {
            type: identifier.type,
            issuingCountry: identifier.issuingCountry,
            value: identifier.value,
            validTo: null,
          },
        },
      },
      select: SUMMARY_SELECT,
    });
    return row ? this.toSummary(row) : null;
  }

  /**
   * Creates the chart and its first identifier as ONE operation.
   *
   * `mrn` is ignored on purpose — the caller cannot know it. It comes from a
   * sequence read inside the same transaction, so two receptionists
   * registering at the same moment cannot receive the same number. Computing
   * it as max+1 in application code is the obvious version of this and it is
   * broken under exactly the concurrency a busy morning produces.
   */
  async create(patient: NewPatient): Promise<PatientDetail> {
    try {
      return await this.insert(patient);
    } catch (error) {
      /**
       * PA-013. `patient_identifier_active_unique` fired: another live chart
       * took this document while this registration was in flight.
       *
       * ═══════════════════════════════════════════════════════════════════
       * THE COURTESY CHECK IN THE SERVICE CANNOT COVER THIS, BY DEFINITION.
       * ═══════════════════════════════════════════════════════════════════
       *
       * Under concurrency both registrations read the document as free and
       * both go on; the partial index is what actually stops the second chart
       * (PA-014). Without this translation the loser of that race left
       * through the generic unique-violation map as `DUPLICATE_IDENTIFIER`
       * while the loser of the sequential case got `PATIENT_IDENTIFIER_TAKEN`
       * — TWO CODES FOR ONE FACT, decided by who won a race. The `code` is
       * what the client branches on, so the desk would see the same situation
       * handled two ways depending on the millisecond.
       *
       * The error is DOMAIN and is thrown, not defined, here (CLAUDE.md §4),
       * the same way the undo translates this very index into
       * `MERGE_UNDO_CONFLICT` — only the caller knows what the operation was.
       */
      if (hitsActiveIdentifierIndex(error))
        throw new DuplicateIdentifierError();
      throw error;
    }
  }

  /**
   * The transaction `create` wraps: the MRN from `patient_mrn_seq` (PA-001),
   * then the chart and its first identifier together. Translating a unique
   * violation is left to `create`.
   */
  private async insert(patient: NewPatient): Promise<PatientDetail> {
    const id = await this.prisma.$transaction(async (tx) => {
      const [{ nextval }] = await tx.$queryRaw<[{ nextval: bigint }]>`
        SELECT nextval('patient_mrn_seq') AS nextval
      `;

      const created = await tx.patient.create({
        data: {
          mrn: formatMrn(Number(nextval)),
          familyName: patient.familyName,
          secondFamilyName: patient.secondFamilyName,
          givenName: patient.givenName,
          secondGivenName: patient.secondGivenName,
          sex: patient.sex,
          birthDate: patient.birthDate,
          birthDateEstimated: patient.birthDateEstimated,
          phone: patient.phone,
          email: patient.email,
          residenceAddressLine: patient.residenceAddressLine,
          bloodType: patient.bloodType,
          // D-028: opcionales al dar de alta. La ficha existe igualmente y
          // dice qué le falta (PA-032).
          ethnicityConceptId: patient.ethnicityConceptId,
          nationalityConceptId: patient.nationalityConceptId,
          // PA-056, PA-057. Las dos columnas del instructivo que faltaban. Sus
          // condiciones —Kichwa, y diez años— las hace cumplir el servicio.
          peopleConceptId: patient.peopleConceptId,
          sexualOrientationConceptId: patient.sexualOrientationConceptId,
          residenceParishConceptId: patient.residenceParishConceptId,
          genderIdentityConceptId: patient.genderIdentityConceptId,
          // PA-053. El país como código; el catálogo sólo dice cómo se llama.
          countryOfNationalityCode: patient.countryOfNationalityCode,
          motherPatientId: patient.motherPatientId,
          /**
           * No DEFINITIVE document yet means the chart is provisional. It
           * still exists, and it still gets an MRN — a newborn cannot wait for
           * paperwork.
           *
           * ⚠️ THE PREDICATE, NOT `!patient.identifier`. Registering with a
           * `PROVISIONAL` marker used to produce a chart that declared itself
           * NOT provisional while holding no document at all — the exact state
           * `is_provisional` exists to name (`isDefinitiveDocument`).
           */
          isProvisional: !(
            patient.identifier && isDefinitiveDocument(patient.identifier)
          ),
          identifiers: patient.identifier
            ? {
                create: {
                  type: patient.identifier.type,
                  issuingCountry: patient.identifier.issuingCountry,
                  value: patient.identifier.value,
                },
              }
            : undefined,
        },
        select: { id: true },
      });

      return created.id;
    });

    // Re-read through the same path the detail endpoint uses, so what the
    // caller gets back is byte for byte what a later GET will return.
    const detail = await this.findById(id);
    if (!detail) {
      throw new Error(`Patient ${id} vanished immediately after creation`);
    }
    return detail;
  }

  /**
   * PA-053. Cómo se llama el país que la ficha guarda.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * «VEN» NO ES INFORMACIÓN (ADR-005 §5).
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El código es lo que se guarda y lo que viaja a cualquier interoperación; el
   * nombre es lo que lee quien tiene al paciente delante. Devolviendo sólo el
   * código, la pantalla no puede hacer otra cosa que pintarlo tal cual, y nadie
   * en el mostrador sabe que Venezuela es `VEN` — que es exactamente el motivo
   * por el que existe el catálogo `COUNTRY`.
   *
   * SÓLO EN LA FICHA. El listado no pasa por aquí: se dispara con cada letra
   * tecleada (PA-021) y esto es un viaje más a la base por ficha abierta.
   *
   * SIN CONDICIÓN DE VIGENCIA, como el resto de la ficha: un país retirado del
   * catálogo no debe dejar en blanco la nacionalidad de quien no ha cambiado de
   * nacionalidad. Y si no se puede nombrar, el nombre viaja `null` y EL CÓDIGO
   * SIGUE VIAJANDO — nunca revienta la ficha por eso.
   */
  private async namedCountry(
    code: string | null,
  ): Promise<CountryReference | null> {
    if (code === null) return null;

    const row = await this.prisma.catalogConcept.findFirst({
      where: { system: { code: COUNTRY_SYSTEM_CODE }, code },
      select: { display: true },
      // Un código es único POR PERIODO, no en absoluto: un país renombrado
      // tiene una fila por release. La más reciente gana, que es el nombre con
      // el que hoy se le conoce.
      orderBy: { validFrom: 'desc' },
    });

    return { code, display: row?.display ?? null };
  }

  /**
   * PA-028. Cómo se llaman la provincia y el cantón que el código deriva.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * POR QUÉ SE PREGUNTA POR CÓDIGO Y NO SE SUBE POR `parent_id`
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Porque subir por el padre es leer la jerarquía que el archivo del INEC
   * declara, y ésa es exactamente la que dos de sus filas contradicen: dos
   * parroquias de Durán cuelgan del cantón que el archivo dice —Daule— y no del
   * que su código dice. Preguntando por el código DERIVADO, el error del
   * archivo no puede llegar a la pantalla ni al reporte. Sigue siendo derivar:
   * `0908` sale del prefijo, y aquí sólo se pregunta cómo se llama `0908`.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * UNA CONSULTA, Y SÓLO EN LA FICHA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Los dos códigos se resuelven en un `IN`, así que abrir una ficha cuesta un
   * viaje más, no dos ni uno por fila. Y el LISTADO no pasa por aquí: PA-021 lo
   * dispara con cada letra tecleada y no lleva estos campos, que es la razón de
   * que `toSummary` no los tenga.
   *
   * SIN CONDICIÓN DE VIGENCIA, igual que el resto de la ficha: una provincia
   * retirada del DPA no debe dejar en blanco la dirección de quien no se ha
   * mudado. Si el catálogo no sabe el nombre —una parroquia de una edición
   * vieja cuyo cantón ya no está—, el nombre viaja `null` y el código sigue
   * viajando. Nunca revienta la ficha por eso; mismo criterio que
   * `CatalogsService.byId`.
   */
  private async namedParish(
    parish: ParishReference | null,
  ): Promise<ParishReference | null> {
    if (parish === null) return null;

    const codes = [parish.provinceCode, parish.cantonCode].filter(
      (code): code is string => code !== null,
    );
    // Un código de parroquia que no tiene seis dígitos no deriva nada, y
    // preguntar por una lista vacía sería un viaje para no traer nada.
    if (codes.length === 0) return parish;

    const rows = await this.prisma.catalogConcept.findMany({
      where: { system: { code: DPA_SYSTEM_CODE }, code: { in: codes } },
      select: { code: true, display: true },
      // Un código es único POR PERIODO, no en absoluto: un cantón renombrado
      // tiene dos filas. Se ordena de la más antigua a la más reciente y la
      // última gana, así que el nombre que se muestra es el vigente — que es lo
      // que se espera de una dirección, a diferencia de la parroquia misma, que
      // se resuelve por el id con el que se registró.
      orderBy: { validFrom: 'asc' },
    });

    const displayByCode = new Map(rows.map((row) => [row.code, row.display]));

    return {
      ...parish,
      provinceDisplay:
        parish.provinceCode === null
          ? null
          : (displayByCode.get(parish.provinceCode) ?? null),
      cantonDisplay:
        parish.cantonCode === null
          ? null
          : (displayByCode.get(parish.cantonCode) ?? null),
    };
  }

  /**
   * A concept and the catalogue it belongs to, with its validity dates. Not
   * filtered by validity: whether a retired concept is acceptable is the
   * caller's decision.
   */
  async findConceptReference(id: string): Promise<CatalogReference | null> {
    const row = await this.prisma.catalogConcept.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        display: true,
        validFrom: true,
        validTo: true,
        // A QUÉ CATÁLOGO PERTENECE, que es la mitad que importa: un id de
        // parroquia enviado como etnia existe, y aceptarlo pondría una fila
        // del DPA en la autoidentificación étnica del reporte mensual.
        system: { select: { code: true } },
      },
    });
    if (!row) return null;

    return {
      id: row.id,
      systemCode: row.system.code,
      code: row.code,
      display: row.display,
      validFrom: toClinicalDate(row.validFrom),
      validTo: row.validTo === null ? null : toClinicalDate(row.validTo),
    };
  }

  /**
   * PA-053. El mismo concepto, buscado por su código dentro de un sistema.
   *
   * `findFirst` con el sistema en el `where` y no una consulta por código a
   * secas: `170150` puede ser una parroquia del DPA y, mañana, el código de
   * otra lista. Preguntar sin el sistema devolvería la fila equivocada.
   *
   * LA MÁS RECIENTE, porque un código no es único en absoluto sino por periodo:
   * un país renombrado tiene una fila por release. La que decide si `SUN` puede
   * elegirse hoy es la última, no la primera que se cargó.
   */
  /**
   * PA-057, PA-058. La orientación sexual, y NADA MÁS de la ficha.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * UN `select` DE UN SOLO CAMPO, Y ESO ES LA MITAD DEL REQUISITO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Devolver aquí la ficha entera —o reutilizar `findById` y quedarse con un
   * campo— convertiría esta ruta en una segunda puerta a todo lo demás, y la
   * bitácora diría «leyó la orientación sexual» sobre una lectura que trajo el
   * apellido, el documento y la dirección. Lo que la puerta protege es lo que
   * viaja, no lo que se pide.
   *
   * `undefined` es «no existe»; `{ orientation: null }` es «existe y nadie lo
   * ha preguntado todavía». El servicio los distingue: el primero es un 404 y
   * el segundo una respuesta legítima.
   *
   * ⚠️ NO FILTRA POR FICHA FUSIONADA: eso lo decide el servicio, que es quien
   * sabe responder `PATIENT_MERGED` con el MRN de la superviviente (PA-045).
   */
  async findSexualOrientation(
    patientId: string,
  ): Promise<SexualOrientationRead | undefined> {
    const row = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: {
        sexualOrientation: CONCEPT_SELECT,
        /**
         * AND WHERE THE CHART WENT, because PA-045 covers «toda operación que
         * la nombre» and this is one. It rides in the same statement: a second
         * query to find out whether the chart was merged would double the cost
         * of a route that reads one column.
         */
        mergedInto: { select: { mrn: true } },
      },
    });
    if (!row) return undefined;

    return {
      mergedIntoMrn: row.mergedInto?.mrn ?? null,
      orientation: toConceptReference(row.sexualOrientation),
    };
  }

  async findAgendaEntryContext(
    entryId: string,
  ): Promise<AgendaEntryContext | null> {
    return this.prisma.agendaEntry.findUnique({
      where: { id: entryId },
      select: { patientId: true, siteId: true },
    });
  }

  async findConceptReferenceByCode(
    systemCode: string,
    code: string,
  ): Promise<CatalogReference | null> {
    const row = await this.prisma.catalogConcept.findFirst({
      where: { system: { code: systemCode }, code },
      select: {
        id: true,
        code: true,
        display: true,
        validFrom: true,
        validTo: true,
        system: { select: { code: true } },
      },
      orderBy: { validFrom: 'desc' },
    });
    if (!row) return null;

    return {
      id: row.id,
      systemCode: row.system.code,
      code: row.code,
      display: row.display,
      validFrom: toClinicalDate(row.validFrom),
      validTo: row.validTo === null ? null : toClinicalDate(row.validTo),
    };
  }

  async findCorrectionState(
    id: string,
  ): Promise<PatientCorrectionState | null> {
    const row = await this.prisma.patient.findUnique({
      where: { id },
      select: CORRECTION_SELECT,
    });
    if (!row) return null;

    return {
      mergedIntoMrn: row.mergedInto?.mrn ?? null,
      values: correctionSnapshotOf(row),
    };
  }

  /**
   * PA-031. La ficha y su rastro, EN LA MISMA TRANSACCIÓN Y SOBRE LA FILA
   * BLOQUEADA.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * LA INSTANTÁNEA SE LEE DENTRO, O EL RASTRO PUEDE MENTIR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Dos mostradores corrigen el mismo apellido. Con el plan calculado fuera —de
   * una lectura anterior, en READ COMMITTED— los dos escriben el valor que
   * LEYERON, y quedan dos filas de `patient_change_history` afirmando que el
   * valor anterior era el original. La cadena real de cambios ya no se puede
   * reconstruir, que es exactamente lo que PA-031 promete.
   * `patient_change_history_value_changed` no lo detecta: los dos valores
   * difieren.
   *
   * `SELECT … FOR UPDATE` primero, y la instantánea DESPUÉS: en READ COMMITTED
   * cada sentencia toma una vista nueva, así que la lectura posterior al
   * bloqueo ve ya lo que la otra transacción acabó de confirmar. La segunda
   * corrección planifica desde el valor de la primera y el histórico queda
   * ENCADENADO.
   *
   * `planCorrection` es una función PURA de `domain`, y la infraestructura
   * puede importar de `domain` —ya lo hace con `formatMrn` y `priorityLevelOf`—,
   * así que traer el plan aquí dentro no cuesta ninguna frontera.
   *
   * LA FICHA FUSIONADA SE COMPRUEBA AQUÍ TAMBIÉN, no sólo antes. Si la fusión
   * se confirma entre la lectura del servicio y esta escritura, la corrección
   * aterrizaría sobre la ficha absorbida y `PatientMergedError` no se lanzaría
   * nunca. La comprobación previa del servicio sigue existiendo para fallar
   * pronto y con buen mensaje; ésta es la que no se puede saltar.
   *
   * ⚠️ NADA DE ESTO VA A `access_audit`. Esa tabla es append-only y no se purga
   * nunca; `access_audit_payload_only_for_declared_resources` rechaza una fila
   * de `'patient'` con payload, y como registrar no lanza, se perdería en
   * silencio (D-032). La bitácora recibe sólo quién y cuándo, desde el
   * servicio, y SÓLO SI algo cambió.
   */
  async correct(input: {
    patientId: string;
    changedById: string;
    requested: PatientCorrectionRequest;
  }): Promise<AppliedCorrection | null> {
    const changed = await this.prisma.$transaction(async (tx) => {
      /**
       * El bloqueo, en su propia sentencia y por SQL.
       *
       * Prisma no expresa `FOR UPDATE`. Se bloquea por id y se lee después con
       * el `select` de siempre, en vez de escribir a mano las diecisiete
       * columnas: una lista de columnas duplicada aquí es la que se queda atrás
       * el día que la lista corregible crece.
       */
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM patient WHERE id = ${input.patientId}::uuid FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const row = await tx.patient.findUnique({
        where: { id: input.patientId },
        select: CORRECTION_SELECT,
      });
      if (!row) return null;

      if (row.mergedInto !== null) {
        throw new PatientMergedError(row.mergedInto.mrn);
      }

      const changes = planCorrection(
        correctionSnapshotOf(row),
        input.requested,
      );
      if (changes.length === 0) return false;

      const data: CorrectableColumns = {};
      for (const change of changes) {
        (data as Record<string, unknown>)[change.field] = columnValueOf(change);
      }

      await tx.patient.update({ where: { id: input.patientId }, data });
      await tx.patientChangeHistory.createMany({
        data: changes.map((change) => ({
          patientId: input.patientId,
          field: change.field,
          valueBefore: change.valueBefore,
          valueAfter: change.valueAfter,
          changedById: input.changedById,
        })),
      });
      return true;
    });

    if (changed === null) return null;

    // Re-read through the path the detail endpoint uses, so what comes back is
    // byte for byte what a later GET will return.
    const patient = await this.findById(input.patientId);
    return patient === null ? null : { patient, changed };
  }

  /**
   * PA-015. El documento que aparece después, y el fin de lo provisional.
   *
   * LAS DOS COSAS EN UNA TRANSACCIÓN: una ficha con cédula que sigue marcada
   * provisional es la que el mostrador vuelve a registrar «porque parece que no
   * se guardó», y ese es el duplicado que esta ruta existe para evitar.
   *
   * NO escribe en `patient_change_history`: `isProvisional` y los documentos no
   * están entre los campos corregibles del CHECK. No se corrigen, se mueven, y
   * el documento deja su propia fila en `patient_identifier`.
   *
   * ⚠️ SÓLO UN DOCUMENTO DEFINITIVO TERMINA EL ESTADO PROVISIONAL. Un marcador
   * `PROVISIONAL` —el `SN-001` que se escribe en la carpeta de un politraumado
   * inconsciente— se guarda igual, porque es un dato real de la ficha, pero no
   * la declara documentada: el índice único parcial lo excluye por lo mismo
   * (`isDefinitiveDocument`).
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ⚠️ Y LA FUSIÓN SE RELEE **BAJO EL BLOQUEO**, IGUAL QUE EN `correct`
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El comentario de {@link correct} aplica aquí palabra por palabra: si la
   * fusión se confirma entre la lectura del servicio y esta escritura, la fila
   * aterriza sobre la ficha ABSORBIDA y `PatientMergedError` no se lanza nunca.
   * Y aquí duele más que en una corrección, porque el `INSERT` no espera al
   * mismo candado que la fusión:
   *
   *   1. La fusión toma `FOR UPDATE` sobre la ficha.
   *   2. El `INSERT` del documento se detiene en el `FOR KEY SHARE` que exige
   *      su clave foránea, y REANUDA **después** de que la fusión haya movido
   *      los identificadores a la superviviente.
   *   3. La fila cae en la absorbida, `trg_patient_identifier_set_merged` la
   *      marca `patient_merged`, y queda fuera del índice único sobre una ficha
   *      que ninguna búsqueda devuelve. Ya no la mueve nadie: la fusión pasó.
   *
   * Al día siguiente se teclea ese número, no aparece, se abre una TERCERA
   * ficha, y deshacer responde conflicto para siempre — la misma avería que la
   * migración `20260817222356_patient_identifier_follows_merge` se escribió
   * para eliminar. De paso, `is_provisional = false` se escribía sobre una
   * ficha ya absorbida.
   *
   * BLOQUEAR PRIMERO Y LEER DESPUÉS, en ese orden y en sentencias distintas:
   * ver la cabecera de {@link lockChart}, donde está el porqué —EPQ sustituye
   * la tupla actualizada sólo en la relación bloqueada, así que un `JOIN` en la
   * MISMA sentencia del `FOR UPDATE` seguiría leyendo el enlace viejo—.
   */
  async addIdentifier(input: {
    patientId: string;
    identifier: PatientIdentifier;
  }): Promise<PatientDetail | null> {
    try {
      const exists = await this.prisma.$transaction(async (tx) => {
        await lockChart(tx, input.patientId);

        const state = await tx.$queryRaw<{ survivingMrn: string | null }[]>`
          SELECT survivor.mrn AS "survivingMrn"
            FROM patient AS chart
            LEFT JOIN patient AS survivor ON survivor.id = chart.merged_into_id
           WHERE chart.id = ${input.patientId}::uuid
        `;
        const chart = state[0];
        if (chart === undefined) return false;
        if (chart.survivingMrn !== null) {
          throw new PatientMergedError(chart.survivingMrn);
        }

        await tx.patientIdentifier.create({
          data: {
            patientId: input.patientId,
            type: input.identifier.type,
            issuingCountry: input.identifier.issuingCountry,
            value: input.identifier.value,
          },
        });
        if (isDefinitiveDocument(input.identifier)) {
          await tx.patient.update({
            where: { id: input.patientId },
            data: { isProvisional: false },
          });
        }
        return true;
      });
      if (!exists) return null;
    } catch (error) {
      // PA-013. Same race as registration, same answer: the check in the
      // service is courtesy, the partial index is the guarantee.
      if (hitsActiveIdentifierIndex(error))
        throw new DuplicateIdentifierError();
      throw error;
    }

    return this.findById(input.patientId);
  }

  /**
   * PA-009. Existe Y no fue absorbida por una fusión.
   *
   * `findFirst` con `mergedIntoId: null` y no `findUnique` por id: la ficha
   * absorbida NO se borra —los documentos impresos siguen citando su MRN—, así
   * que preguntar sólo por el id la encuentra.
   *
   * ⚠️ EL MOTIVO CAMBIÓ Y EL REQUISITO NO (18-08-2026). Antes esto era lo único
   * que impedía que el recién nacido desapareciera: enlazarlo a una ficha
   * absorbida lo sacaba de `GET /patients?motherId=<superviviente>`. Ya no —el
   * filtro resuelve «la ficha y las que absorbió» (PA-009, PA-055)—, y aun así
   * se queda, por dos razones que siguen siendo ciertas:
   *
   *  - El mostrador debe nombrar la ficha VIGENTE de la madre. Aceptar una
   *    absorbida deja escrito en la ficha del bebé un id que `GET /patients/:id`
   *    contesta con 409 (PA-045), y eso se arrastra para siempre.
   *  - Esta comprobación corre FUERA de cualquier transacción, así que una
   *    fusión que se confirme justo después de ella se le escapa por
   *    definición. Lo que hace inofensiva esa carrera es el alcance del filtro,
   *    no esta línea: son dos defensas de cosas distintas, y ninguna sustituye
   *    a la otra.
   */
  async existsUnmerged(id: string): Promise<boolean> {
    const row = await this.prisma.patient.findFirst({
      where: { id, mergedIntoId: null },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * PA-040, PA-055. LA FICHA Y LAS QUE ABSORBIÓ, en una sola consulta.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ES EL ESCENARIO DE D-038 CON EL DATO QUE YA TIENE CÓDIGO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Un grupo prioritario es dato clínico y se queda en la ficha absorbida
   * (D-031), así que hasta PA-055 una embarazada fusionada dejaba de constar
   * como prioritaria y el motivo desaparecía de la pantalla del médico. Es la
   * misma avería que la alergia a la penicilina, sobre la única tabla de
   * historia que hoy existe.
   *
   * `chartScope` FILTRA POR LA RELACIÓN y no por una lista de ids resuelta
   * antes: pedir los ids primero sería un viaje de ida y vuelta más en cada
   * lectura, y una fusión o una reversión que cayera entre los dos se leería
   * con un alcance que ya no es cierto.
   *
   * NO SE REPUNTA NADA. Las filas conservan su `patient_id`; deshacer sólo
   * limpia `merged_into_id` y esta consulta deja de verlas en el mismo
   * instante, sin que nadie tenga que acordarse de nada.
   */
  async listPriorityGroups(
    patientId: string,
  ): Promise<readonly PriorityGroupRecord[]> {
    const rows = await this.prisma.patientPriorityGroup.findMany({
      where: chartScope(patientId),
      // Newest assessment first: the current situation is what somebody
      // deciding a turn is looking for, and the history is below it.
      orderBy: [{ startsOn: 'desc' }, { recordedAt: 'desc' }],
    });

    return rows.map(toPriorityGroupRecord);
  }

  /**
   * PA-033. Records one assessment.
   *
   * ⚠️ NO LOCK HERE, AND IT WAS CHECKED RATHER THAN ASSUMED (18-08-2026). The
   * service reads the merge state outside any transaction (`assertLiveChart`),
   * so a merge confirmed in between files this row on the ABSORBED chart —
   * the same race `addIdentifier` had. The OUTCOME is different, and that is
   * the whole reason this stays as it is: an identifier landing there falls
   * out of `patient_identifier_active_unique` and becomes unfindable, while a
   * priority group keeps its `patient_id` and IS read from the survivor
   * through the link (PA-055, D-031) — including its restricted rows, its
   * calculated level and its closing route.
   *
   * SO THE DEPENDENCY IS WRITTEN DOWN: what makes this benign is PA-055. If
   * the scope ever stops covering `patient_priority_group`, this needs the
   * same lock-and-re-read as `addIdentifier` and `correct`.
   */
  async addPriorityGroup(
    record: NewPriorityGroup,
  ): Promise<PriorityGroupRecord> {
    const row = await this.prisma.patientPriorityGroup.create({
      data: {
        patientId: record.patientId,
        groupCode: record.group,
        startsOn: fromClinicalDate(record.startsOn),
        endsOn: record.endsOn === null ? null : fromClinicalDate(record.endsOn),
        origin: record.origin,
        evidenceDocument: record.evidenceDocument,
        recordedById: record.recordedById,
      },
    });

    return toPriorityGroupRecord(row);
  }

  /**
   * PA-037. Closing SETS A DATE; it never deletes the row.
   *
   * `updateMany` with the patient in the `where` and not `update` by id: the
   * record has to belong to the patient in the URL, and checking that in a
   * separate read would leave the window between the two. Zero rows updated is
   * the same answer for «no existe» and «es de otro paciente», which is what
   * the caller turns into one message.
   *
   * PA-055: THE SAME SCOPE AS THE READ, and it has to be. A motive that can be
   * seen from the surviving chart and not closed from it leaves the doctor
   * looking at a pregnancy from two years ago with no way to end it — PA-037
   * would be unreachable for exactly the charts that were merged. Closing SETS
   * A DATE and moves no row: the assessment stays on the chart it was written
   * on, so undoing takes it back with its end date, like any other.
   */
  async closePriorityGroup(input: {
    patientId: string;
    recordId: string;
    endsOn: ClinicalDate;
    closedById: string;
  }): Promise<PriorityGroupRecord | null> {
    const { count } = await this.prisma.patientPriorityGroup.updateMany({
      where: { id: input.recordId, ...chartScope(input.patientId) },
      data: {
        endsOn: fromClinicalDate(input.endsOn),
        closedById: input.closedById,
        closedAt: new Date(),
      },
    });
    if (count === 0) return null;

    const records = await this.listPriorityGroups(input.patientId);
    return records.find((record) => record.id === input.recordId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Duplicate resolution (P4: PA-043 to PA-049)
  // -------------------------------------------------------------------------

  /** PA-045. Who the chart is and whether it was absorbed. Opens nothing. */
  async findMergeState(id: string): Promise<PatientMergeState | null> {
    const row = await this.prisma.patient.findUnique({
      where: { id },
      select: { id: true, mrn: true, mergedInto: { select: { mrn: true } } },
    });
    if (!row) return null;

    return {
      id: row.id,
      mrn: row.mrn,
      mergedIntoMrn: row.mergedInto?.mrn ?? null,
    };
  }

  /**
   * PA-043, PA-044. The link and the append-only row, IN ONE TRANSACTION.
   *
   * ⚠️ THE `UPDATE` GOES THROUGH RAW SQL, and that is not a stylistic choice.
   * What refuses a chain is `trg_patient_merge_not_chained`, and its rejection
   * has to be told apart from any other integrity failure by the sentence it
   * raises. A rejection routed through the ORM's own error wrapping does not
   * reliably carry that sentence; a raw statement does, which is the same
   * reason `test/integration/patient-merge.spec.ts` attacks the constraints
   * through raw SQL.
   *
   * NOTHING ABOUT THE PATIENT IS READ FROM THAT MESSAGE — only whether it
   * matches one of two sentences this repository wrote itself. PostgreSQL puts
   * the offending row in `detail`, which is never touched here.
   */
  async merge(input: {
    sourcePatientId: string;
    targetPatientId: string;
    reason: string;
    performedById: string;
  }): Promise<MergeOutcome> {
    let mergeId: bigint | 'SOURCE_MERGED';
    let survivingMrn = '';
    let restOverlaps = 0;
    try {
      mergeId = await this.prisma.$transaction(async (tx) => {
        /**
         * ⚠️ THE SOURCE CHART IS LOCKED BEFORE ANYTHING IS READ, and this is
         * the whole defence against a double click on «Fusionar».
         *
         * The service reads the chart's state and then writes, and between
         * those two moments a second request reads the same state. Nothing
         * arbitrated it: `trg_patient_merge_not_chained` only raises when the
         * target CHANGES, and re-writing the SAME target changes no column, so
         * the second request sailed through and left a second `MERGE` row for
         * one merge — on an append-only table, which makes it unfixable for
         * ever, and with `merged_at` holding the second request's instant
         * instead of the first's, which is the instant PA-044 asks for.
         *
         * `FOR UPDATE` on the SOURCE is the same defence the trigger already
         * applies to the TARGET, and in the same order — source then target —
         * so the two locks cannot deadlock against each other. The second
         * request blocks here, and when it resumes it re-reads the state the
         * first one committed instead of the stale one it arrived with.
         *
         * A DECLARATIVE GUARANTEE WOULD BE BETTER and does not fit: «one open
         * merge per source chart» is a partial unique index over
         * `patient_merge (source_patient_id) WHERE event = 'MERGE'` minus the
         * rows an `UNDO` row points at — a predicate that needs a subquery,
         * which index predicates do not admit. The alternative is schema
         * (a `patient.open_merge_id` column, or a trigger), and that is not
         * this batch's to write.
         */
        // PA-062. The rest locks of both charts FIRST, before the chart row:
        // the order an issue takes them in (see `rests-on-merge.ts`).
        await lockRestsOfCharts(tx, [input.sourcePatientId, input.targetPatientId]); // prettier-ignore
        await lockChart(tx, input.sourcePatientId);

        const state = await tx.$queryRaw<{ survivingMrn: string | null }[]>`
          SELECT survivor.mrn AS "survivingMrn"
            FROM patient AS chart
            LEFT JOIN patient AS survivor ON survivor.id = chart.merged_into_id
           WHERE chart.id = ${input.sourcePatientId}::uuid
        `;
        const alreadyMerged = state[0]?.survivingMrn;
        if (alreadyMerged !== undefined && alreadyMerged !== null) {
          survivingMrn = alreadyMerged;
          return 'SOURCE_MERGED' as const;
        }

        /**
         * The snapshot is taken BEFORE the link, and inside the transaction.
         *
         * It is what makes the operation explainable and undoable (PA-044), so
         * reading it outside would describe a chart that another desk may have
         * corrected in between.
         */
        const snapshot = await snapshotOf(tx, input.sourcePatientId);

        await tx.$executeRaw`
          UPDATE patient
             SET merged_into_id = ${input.targetPatientId}::uuid,
                 merged_at = now(),
                 updated_at = now()
           WHERE id = ${input.sourcePatientId}::uuid
        `;

        /**
         * ⚠️ AND THE DOCUMENTS FOLLOW THE PERSON. This is the whole point of
         * merging, and leaving it out is what made the merge hide her.
         *
         * ═════════════════════════════════════════════════════════════════
         * WHY THIS DOES NOT CONTRADICT D-031
         * ═════════════════════════════════════════════════════════════════
         *
         * D-031 is about the HISTORY — appointments, encounters, documents,
         * allergies — which does not move and is read through the link. A
         * document of identity is not history: it is not something that
         * HAPPENED to the person, it is HOW SHE IS FOUND. The line above
         * takes her cedula out of `patient_identifier_active_unique`
         * (PA-014, correct), and if nothing carried it to the survivor the
         * desk typed that number the next morning and got NOTHING, opened a
         * third chart, and the merge became impossible to undo for ever.
         *
         * AFTER the chart is linked, never before: `trg_patient_sync_merged`
         * has just flagged every row of the absorbed chart as merged, and
         * `trg_patient_identifier_set_merged` clears the flag again as each
         * row lands on the survivor, which is live. Reversing the order
         * would flag the rows on the survivor.
         *
         * `use = 'OFFICIAL'` AND NOT `PROVISIONAL`, which is the index
         * predicate written out: those are the only rows uniqueness applies
         * to, so moving any other buys nothing — and dragging a `PROVISIONAL`
         * placeholder onto a chart that has a real document only dirties it.
         *
         * `NOT EXISTS`: if the survivor already holds that exact type,
         * country and value, the absorbed row STAYS. The index is already
         * satisfied, and moving it would leave two copies of one number on
         * one chart. (Two LIVE charts cannot both hold it as `OFFICIAL` —
         * that is precisely what the index forbids — so the survivor's copy
         * is always one that sits outside the index.)
         *
         * `RETURNING`: what moved is recorded in the trail, because undoing
         * has to put back EXACTLY these rows and no others.
         */
        const moved = await tx.$queryRaw<{ id: string }[]>`
          UPDATE patient_identifier AS mine
             SET patient_id = ${input.targetPatientId}::uuid
           WHERE mine.patient_id = ${input.sourcePatientId}::uuid
             AND mine.use = 'OFFICIAL'
             AND mine.type <> 'PROVISIONAL'
             AND NOT EXISTS (
                   SELECT 1
                     FROM patient_identifier theirs
                    WHERE theirs.patient_id = ${input.targetPatientId}::uuid
                      AND theirs.type = mine.type
                      AND theirs.issuing_country = mine.issuing_country
                      AND theirs.value = mine.value
                 )
          RETURNING mine.id::text AS id
        `;

        /**
         * ⚠️ AND THE PLACE IN THE QUEUE FOLLOWS THE PERSON (PA-060, D-041 B).
         *
         * The open waiting-list enrolments of the absorbed chart are RE-MADE
         * on the survivor carrying their original `created_at`. Not moved:
         * `waitlist_entry` keeps its `patient_id` like the rest of the
         * history (D-031), and `linkedRecords` still counts exactly the rows
         * it counted before.
         *
         * It is a NEW ROW and not a scope read (PA-055) because an enrolment
         * does not only get read — IT TURNS INTO AN APPOINTMENT, and booking
         * for a merged chart is refused (AG-027) while
         * `trg_waitlist_entry_conversion_consented` demands the appointment be
         * of the same `patient_id`. Proposing the absorbed chart's entry would
         * offer a slot nobody can take.
         *
         * IN `shared` AND NOT HERE: `waitlist_entry` belongs to `agenda`, and
         * no module writes another module's table — `arch:check` reads
         * imports, so doing it inline would cross the boundary through the
         * back door. See the header of `waitlist-follows-merge.ts`.
         *
         * IN THE SAME TRANSACTION as everything else: a merge that moves half
         * a thing cannot exist.
         */
        const reEnrolled = await reEnrolOpenWaitlistEntries(tx, {
          absorbedChartId: input.sourcePatientId,
          survivingChartId: input.targetPatientId,
        });

        // PA-062, D-110 §7. Rests the merge brings together that CER-048 would
        // have refused at issue: the merge goes ahead, and says so.
        restOverlaps = await maternityRestOverlapsOnMerge(tx, {
          absorbedChartId: input.sourcePatientId,
          survivingChartId: input.targetPatientId,
        });

        const row = await tx.patientMerge.create({
          data: {
            event: 'MERGE',
            sourcePatientId: input.sourcePatientId,
            targetPatientId: input.targetPatientId,
            performedBy: input.performedById,
            reason: input.reason,
            sourceSnapshot: {
              ...snapshot,
              /**
               * PA-044, PA-047. WHICH ROWS THIS OPERATION MOVED — not chart
               * state, so it sits under a key of its own.
               *
               * The snapshot exists «para explicar la operación y poder
               * deshacerla», and this is the half that makes the undo exact.
               * Deriving it later from the snapshot's identifier list cannot
               * work: a document the survivor already held stayed behind, and
               * from outside the two are indistinguishable. Ids are the only
               * answer that never guesses.
               */
              movedIdentifierIds: moved.map((identifier) => identifier.id),
              /**
               * PA-060. WHICH ENROLMENTS THIS OPERATION CREATED, by id, for
               * the same reason as the line above: undoing has to take back
               * exactly these rows and no others. Deducing them from their
               * shape would guess wrong about an enrolment the survivor made
               * on her own account after the merge.
               */
              ...reEnrolledWaitlistEntrySnapshot(reEnrolled),
            },
          },
          select: { id: true },
        });
        return row.id;
      });
    } catch (error) {
      const refusal = mergeRefusalOf(error);
      if (refusal === undefined) throw error;

      /**
       * THE SOURCE WAS RE-POINTED AT A NEW TARGET — the trigger's third
       * sentence, and PA-045 rather than PA-046: the chart the desk is holding
       * has MOVED, so the answer is the MRN to open and not «undo the other
       * merge first».
       *
       * ⚠️ DEFENCE IN DEPTH, not a live path: `lockChart` reads the state
       * under the lock, so this route decides before the trigger can. It is
       * mapped anyway because the alternative to a mapped rejection is a 500,
       * and because leaving the sentence unclaimed is how the wrong code got
       * here in the first place — it used to be lumped in with the chain and
       * answered `PATIENT_ALREADY_MERGED`.
       */
      if (refusal === 'source-merged') {
        const state = await this.findMergeState(input.sourcePatientId);
        if (state?.mergedIntoMrn != null) {
          return { status: 'SOURCE_MERGED', survivingMrn: state.mergedIntoMrn };
        }
        // Somebody undid it in between: there is no chart to send anyone to,
        // and inventing one would be worse than the generic refusal.
        return { status: 'WOULD_CHAIN', chart: 'source', survivingMrn: null };
      }

      const chart = refusal === 'target' ? 'target' : 'source';
      const chained =
        chart === 'target' ? input.targetPatientId : input.sourcePatientId;
      const state = await this.findMergeState(chained);
      return {
        status: 'WOULD_CHAIN',
        chart,
        survivingMrn: state?.mergedIntoMrn ?? null,
      };
    }

    if (mergeId === 'SOURCE_MERGED') {
      return { status: 'SOURCE_MERGED', survivingMrn };
    }

    return {
      status: 'MERGED',
      event: await this.mergeEventOf(mergeId),
      restOverlaps,
    };
  }

  /**
   * PA-047. The merge of this chart that nobody has undone yet.
   *
   * BY THE LINK: `undoneBy: { is: null }` is the unique
   * `patient_merge_undone_once` read backwards, and it keeps answering after
   * the same pair has been merged, undone and merged again — which is exactly
   * when guessing by dates stops working.
   */
  async findOpenMerge(
    sourcePatientId: string,
  ): Promise<{ mergeId: string } | null> {
    const row = await this.prisma.patientMerge.findFirst({
      where: { event: 'MERGE', sourcePatientId, undoneBy: { is: null } },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    return row === null ? null : { mergeId: row.id.toString() };
  }

  /**
   * PA-047, PA-048. The chart becomes whole again and a NEW row says who undid
   * it, when and why — never an edit of the merge row.
   *
   * ⚠️ WHOLE OR NOT AT ALL. Clearing the link fires `trg_patient_sync_merged`,
   * which puts every document of the chart back into
   * `patient_identifier_active_unique`. If another live chart took one
   * meanwhile the index refuses, and BECAUSE BOTH WRITES SHARE THE
   * TRANSACTION the chart is left exactly as it was: merged, with all its
   * documents still out of the index. That is the half of PA-048 that is not
   * about the message.
   */
  async undoMerge(input: {
    sourcePatientId: string;
    mergeId: string;
    reason: string;
    performedById: string;
  }): Promise<UndoMergeOutcome> {
    let undoId: bigint | 'ALREADY_UNDONE';
    try {
      undoId = await this.prisma.$transaction(async (tx) => {
        /**
         * ⚠️ THE SAME LOCK AS THE MERGE, and for the same reason. Two
         * simultaneous undos both read the chart as merged and both find the
         * SAME open merge row. Whoever loses must be told the merge is no
         * longer open — `MERGE_NOT_FOUND`, PA-047 — and not be dropped into
         * the generic unique-violation map, which answers `DUPLICATE_VALUE`
         * about a constraint the desk has never heard of.
         */
        await lockChart(tx, input.sourcePatientId);

        const state = await tx.$queryRaw<{ mergedIntoId: string | null }[]>`
          SELECT merged_into_id AS "mergedIntoId"
            FROM patient
           WHERE id = ${input.sourcePatientId}::uuid
        `;
        if (state[0]?.mergedIntoId == null) return 'ALREADY_UNDONE' as const;

        /**
         * The pair comes from the MERGE row and not from the request.
         *
         * `trg_patient_merge_undo_coherent` refuses an undo naming a different
         * pair, and taking the two ids from the row it undoes is what makes
         * that impossible to get wrong here.
         */
        const merged = await tx.patientMerge.findUniqueOrThrow({
          where: { id: BigInt(input.mergeId) },
          select: {
            sourcePatientId: true,
            targetPatientId: true,
            sourceSnapshot: true,
          },
        });

        /**
         * ⚠️ THE DOCUMENTS COME BACK FIRST, AND THE ORDER IS LOAD-BEARING.
         *
         * While the chart is still merged, a row landing back on it is flagged
         * `patient_merged` by `trg_patient_identifier_set_merged`, so it stays
         * OUT of `patient_identifier_active_unique`. Clearing the link next
         * fires `trg_patient_sync_merged`, which puts every document of the
         * chart back into the index AT ONCE — and that single moment is where
         * PA-048 is decided, over the complete set of rows.
         *
         * Inverted, the returning rows would re-enter the index one operation
         * early, while the chart is still merged: PA-048 would then fire over
         * the WRONG set — the documents that never left — and a genuine
         * conflict on a returning one would surface as a bare constraint
         * violation nobody could read.
         *
         * BY ID, from the merge's own trail. Not «every OFFICIAL document of
         * the survivor that appears in the snapshot»: a document the survivor
         * already held stayed on the absorbed chart, and moving the survivor's
         * own copy to it would be stealing. Ids never guess. A row deleted
         * meanwhile simply does not come back, which is right — there is
         * nothing to return.
         */
        const movedIds = movedIdentifierIdsOf(merged.sourceSnapshot);
        if (movedIds.length > 0) {
          await tx.$executeRaw`
            UPDATE patient_identifier
               SET patient_id = ${input.sourcePatientId}::uuid
             WHERE id = ANY(${movedIds}::uuid[])
          `;
        }

        /**
         * PA-060. And the enrolments the merge created are taken back.
         *
         * ORDER IS NOT LOAD-BEARING HERE, unlike the identifiers above, and
         * saying so is the point: no trigger couples these rows to the link.
         * The absorbed chart's own entries need nothing done to them — they
         * never moved — and clearing `merged_into_id` below is what puts them
         * back in the queue, with nobody having to remember anything (PA-055).
         */
        await undoWaitlistReEnrolment(
          tx,
          reEnrolledWaitlistEntryIdsOf(merged.sourceSnapshot),
        );

        await tx.$executeRaw`
          UPDATE patient
             SET merged_into_id = NULL,
                 merged_at = NULL,
                 updated_at = now()
           WHERE id = ${input.sourcePatientId}::uuid
        `;

        const row = await tx.patientMerge.create({
          data: {
            event: 'UNDO',
            undoesMergeId: BigInt(input.mergeId),
            sourcePatientId: merged.sourcePatientId,
            targetPatientId: merged.targetPatientId,
            performedBy: input.performedById,
            reason: input.reason,
            // No snapshot: `patient_merge_snapshot_matches_event` refuses one
            // here, and it would be invented — there is nothing to undo about
            // an undo.
          },
          select: { id: true },
        });
        return row.id;
      });
    } catch (error) {
      /**
       * PA-047. `patient_merge_undone_once` fired: this merge already has an
       * `UNDO` row pointing at it.
       *
       * THE LOCK ABOVE DOES NOT MAKE THIS UNREACHABLE, which is why it stays.
       * A chart undone and merged AGAIN by somebody else reads as merged
       * through the lock and still cannot be undone by THIS merge id. The
       * constraint is the real arbiter; this only says what it means.
       */
      if (isMergeAlreadyUndone(error)) return { status: 'ALREADY_UNDONE' };

      if (!hitsActiveIdentifierIndex(error)) throw error;

      const conflict = await this.claimedIdentifierOf(input.sourcePatientId);
      // The index fired and yet no live chart holds any of these documents:
      // that is not PA-048, it is a bug, and dressing it as a conflict would
      // hide it behind a message the desk cannot act on.
      if (conflict === null) throw error;

      return { status: 'IDENTIFIER_CLAIMED', ...conflict };
    }

    if (undoId === 'ALREADY_UNDONE') return { status: 'ALREADY_UNDONE' };

    return { status: 'UNDONE', event: await this.mergeEventOf(undoId) };
  }

  /**
   * PA-048. Which document of this chart another LIVE chart holds, and which.
   *
   * The predicate is `patient_identifier_active_unique` written out —
   * `use = 'OFFICIAL'`, not merged, not a `PROVISIONAL` placeholder — because
   * the question is precisely «what would the index refuse». Written twice it
   * would drift; written here next to the undo it is at least read alongside
   * the migration that owns it.
   *
   * ⚠️ IT RETURNS A TYPE AND AN MRN, never the value of the document.
   */
  private async claimedIdentifierOf(
    sourcePatientId: string,
  ): Promise<{ identifierType: string; holderMrn: string } | null> {
    const rows = await this.prisma.$queryRaw<{ type: string; mrn: string }[]>`
      SELECT mine.type::text AS type, holder.mrn AS mrn
        FROM patient_identifier mine
        JOIN patient_identifier taken
          ON taken.type = mine.type
         AND taken.issuing_country = mine.issuing_country
         AND taken.value = mine.value
         AND taken.patient_id <> mine.patient_id
         AND taken.use = 'OFFICIAL'
         AND NOT taken.patient_merged
        JOIN patient holder ON holder.id = taken.patient_id
       WHERE mine.patient_id = ${sourcePatientId}::uuid
         AND mine.use = 'OFFICIAL'
         AND mine.type <> 'PROVISIONAL'
       ORDER BY holder.mrn
       LIMIT 1
    `;

    const row = rows[0];
    return row === undefined
      ? null
      : { identifierType: row.type, holderMrn: row.mrn };
  }

  /**
   * One row of the event log as the API answers it: both MRNs, the instant,
   * and what stayed on the absorbed chart (PA-049).
   */
  private async mergeEventOf(id: bigint): Promise<PatientMergeEvent> {
    const row = await this.prisma.patientMerge.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        event: true,
        performedAt: true,
        sourcePatientId: true,
        targetPatientId: true,
        sourcePatient: { select: { mrn: true } },
        targetPatient: { select: { mrn: true } },
      },
    });

    return {
      mergeId: row.id.toString(),
      event: row.event,
      sourcePatientId: row.sourcePatientId,
      sourceMrn: row.sourcePatient.mrn,
      targetPatientId: row.targetPatientId,
      targetMrn: row.targetPatient.mrn,
      performedAt: row.performedAt,
      linkedRecords: await this.countLinkedRecords(row.sourcePatientId),
    };
  }

  /**
   * PA-049, D-031. How much of the absorbed chart STAYED WHERE IT WAS.
   *
   * Counted on the source chart on purpose: «se lee por el enlace» means these
   * rows keep their `patient_id`, and the only way to show that from outside is
   * to say how many of them are still there. Not a single `UPDATE` is issued by
   * this method or by the merge — re-pointing them is option (a) of PA-049,
   * which D-031 rejected because it makes the merge irreversible in practice.
   *
   * ⚠️ ONE STATEMENT, AND THAT IS WHY IT IS RAW. Which tables hang off a chart
   * is a list that grows — it went from four to eight the day somebody noticed
   * the allergies were missing — and one round trip per table turns a growing
   * list into a growing latency. Scalar subqueries let the planner answer all
   * of them in a single pass, and each one is an index-only count on the
   * `patient_id` index those tables already carry.
   *
   * `::int` AND NOT `count(*)` RAW: `count()` is `bigint`, which the driver
   * hands over as a JavaScript `BigInt` and `JSON.stringify` then refuses. The
   * cast is safe — no chart has two billion appointments — and it keeps the
   * conversion in the one place that knows it is safe.
   *
   * NEVER IN A LISTING. It is called from `mergeEventOf` and nowhere else: one
   * merge, one answer. Eight subqueries per row of a search result would be a
   * different and much worse thing.
   *
   * ⚠️ AND THE LINKED CHILDREN ARE NOT HERE, ON PURPOSE (18-08-2026). A ninth
   * counter for «this chart has a newborn hanging off it» was considered and
   * rejected: what made it look necessary was the baby becoming unreachable
   * after the merge, and PA-009 now resolves `?motherId=` through the scope, so
   * it is reachable from the surviving chart. The eight above answer «how many
   * rows OF THIS CHART stayed where they were», which is what makes
   * `READ_THROUGH_LINK` checkable from outside; a child is not a row of this
   * chart, it is ANOTHER chart naming it. One field answering two different
   * questions is how the first one stops meaning anything.
   */
  private async countLinkedRecords(
    patientId: string,
  ): Promise<LinkedRecordCounts> {
    const rows = await this.prisma.$queryRaw<LinkedRecordCounts[]>`
      SELECT
        (SELECT count(*) FROM agenda_entry
          WHERE patient_id = ${patientId}::uuid)::int AS "appointments",
        (SELECT count(*) FROM encounter
          WHERE patient_id = ${patientId}::uuid)::int AS "encounters",
        (
          (SELECT count(*) FROM medical_certificate
            WHERE patient_id = ${patientId}::uuid)
          + (SELECT count(*) FROM referral
              WHERE patient_id = ${patientId}::uuid)
        )::int AS "documents",
        (SELECT count(*) FROM patient_allergy
          WHERE patient_id = ${patientId}::uuid)::int AS "allergies",
        (SELECT count(*) FROM patient_contact
          WHERE patient_id = ${patientId}::uuid)::int AS "contacts",
        (SELECT count(*) FROM patient_priority_group
          WHERE patient_id = ${patientId}::uuid)::int AS "priorityGroups",
        (SELECT count(*) FROM waitlist_entry
          WHERE patient_id = ${patientId}::uuid)::int AS "waitlistEntries"
    `;

    // A `SELECT` with no `FROM` returns exactly one row; `findUniqueOrThrow`
    // has no equivalent here, so the impossible case is stated rather than
    // coerced into zeros that would read as «nothing hangs off this chart».
    const counts = rows[0];
    if (counts === undefined) {
      throw new Error('linked record counts returned no row');
    }
    return counts;
  }

  private toSummary(row: {
    id: string;
    mrn: string;
    familyName: string;
    secondFamilyName: string | null;
    givenName: string;
    secondGivenName: string | null;
    sex: PatientSummary['sex'];
    birthDate: Date;
    birthDateEstimated: boolean;
    deceasedAt: Date | null;
    ethnicityConceptId: string | null;
    /** Only the `code` is required here; the detail select carries more. */
    ethnicity: { code: string } | null;
    nationalityConceptId: string | null;
    /** PA-059. A gate on the two above, not a fifth required datum. */
    countryOfNationalityCode: string | null;
    residenceParishConceptId: string | null;
    priorityGroups: { startsOn: Date; endsOn: Date | null }[];
    /** PA-055. Las fichas absorbidas, con sus mismos periodos. */
    mergedFrom: { priorityGroups: { startsOn: Date; endsOn: Date | null }[] }[];
    identifiers: {
      type: IdentifierType;
      issuingCountry: string;
      value: string;
    }[];
  }): PatientSummary {
    /**
     * HOY EN ECUADOR, resuelto una vez para las dos cosas que dependen de él.
     *
     * `clinicalDateToday()` pregunta a Ecuador y no al anfitrión: a las 21:00
     * en Guayaquil la fecha UTC ya es la de mañana, y sobre un neonato eso es
     * un día entero de diferencia en `age_days` —que es como el RDACAA lo
     * clasifica— y un día entero de prioridad para el último paciente de la
     * tarde.
     */
    const today = clinicalDateToday();

    /**
     * LOS DOCUMENTOS DEFINITIVOS, y de aquí salen las DOS respuestas.
     *
     * `SUMMARY_SELECT` ya filtra en SQL —y con `take: 1`, porque esto sirve
     * cada fila de un listado—, pero `findById` trae la lista entera para poder
     * devolverla, así que el predicado de dominio se aplica igualmente aquí. Un
     * marcador `PROVISIONAL` no es un documento ni para `primaryIdentifier` ni
     * para el indicador del RDACAA.
     */
    const documents = row.identifiers.filter(isDefinitiveDocument);

    return {
      id: row.id,
      /**
       * PA-041. Resolved HERE, when read, against the Ecuadorian date.
       *
       * No stored flag and no nightly job: a pregnancy whose expected date of
       * delivery has passed stops counting without anybody touching the row.
       * `clinicalDateToday()` asks Ecuador rather than the host — at 21:00 in
       * Guayaquil the UTC date is already tomorrow, and that difference is a
       * whole day of priority for the last patient of the evening.
       *
       * PA-055: OVER THE CHART AND OVER THE ONES IT ABSORBED. A pregnancy
       * recorded on the absorbed chart stopped counting the moment the merge
       * went through, and the waiting list called her like anybody else.
       * `chartScopeRows` puts the two halves back together so no caller writes
       * that union by hand.
       */
      priority: priorityLevelOf(
        {
          birthDate: toClinicalDate(row.birthDate),
          periods: chartScopeRows(row, 'priorityGroups').map(toPeriod),
        },
        today,
      ),
      mrn: row.mrn,
      familyName: row.familyName,
      secondFamilyName: row.secondFamilyName,
      givenName: row.givenName,
      secondGivenName: row.secondGivenName,
      sex: row.sex,
      birthDate: row.birthDate,
      birthDateEstimated: row.birthDateEstimated,
      deceasedAt: row.deceasedAt,
      /**
       * PA-030. Derivada al leer, y contra la fecha de FALLECIMIENTO cuando la
       * hay: la edad de una persona fallecida no sigue creciendo.
       */
      age: patientAgeOn(
        {
          birthDate: toClinicalDate(row.birthDate),
          deceasedAt: row.deceasedAt,
        },
        today,
      ),
      /**
       * PA-032. Qué falta de lo que el RDACAA exige, SIN impedir que la ficha
       * exista (D-028). El documento cuenta como presente sólo si hay uno
       * DEFINITIVO y activo: una ficha provisional no tiene ninguno, que es
       * justo el estado que PA-015 termina.
       *
       * The ethnicity goes in twice — id and code — because since D-037 the
       * nationality is demanded only of the charts the ministry asks it of.
       * Which those are is decided by `isIndigenousEthnicity` and nowhere else:
       * deciding it here would be a second comparison to keep in step with
       * PA-027.
       *
       * And the COUNTRY goes in since PA-059, for the same kind of reason one
       * step further up: on a chart whose country is not Ecuador the ministry
       * asks for neither the ethnicity nor the nationality, so neither can be
       * reported as missing. It is a plain column of this very `select`, so it
       * costs the listing nothing.
       */
      rdacaaMissingFields: rdacaaMissingFields({
        hasDefinitiveDocument: documents.length > 0,
        countryOfNationalityCode: row.countryOfNationalityCode,
        ethnicityConceptId: row.ethnicityConceptId,
        ethnicityCode: row.ethnicity?.code ?? null,
        nationalityConceptId: row.nationalityConceptId,
        residenceParishConceptId: row.residenceParishConceptId,
      }),
      primaryIdentifier: documents[0] ? toIdentifier(documents[0]) : null,
    };
  }
}

/**
 * Cada campo corregible, ya en el TEXTO que `patient_change_history` guarda.
 *
 * Convertirlo aquí y no al comparar es lo que hace que «no cambió» signifique
 * lo mismo en los dos lados: el valor guardado y el que llega pasan por la
 * misma regla de escritura (`correctionTextOf`). Dos reglas distintas
 * reportarían un cambio cada vez que alguien reenvía el valor que ya estaba, y
 * `patient_change_history_value_changed` rechazaría la fila.
 *
 * UNA SOLA FUNCIÓN para los dos que la necesitan: la lectura previa del
 * servicio y la instantánea bloqueada de la transacción. Dos copias
 * discreparían el día que un campo cambie de forma, y el síntoma sería un
 * cambio inventado en cada corrección.
 */
function correctionSnapshotOf(row: {
  familyName: string;
  secondFamilyName: string | null;
  givenName: string;
  secondGivenName: string | null;
  sex: string;
  birthDate: Date;
  birthDateEstimated: boolean;
  deceasedAt: Date | null;
  phone: string | null;
  email: string | null;
  residenceAddressLine: string | null;
  bloodType: string | null;
  ethnicityConceptId: string | null;
  nationalityConceptId: string | null;
  peopleConceptId: string | null;
  sexualOrientationConceptId: string | null;
  residenceParishConceptId: string | null;
  genderIdentityConceptId: string | null;
  countryOfNationalityCode: string | null;
  motherPatientId: string | null;
  employerName: string | null;
  jobTitle: string | null;
}): PatientCorrectionSnapshot {
  return {
    familyName: row.familyName,
    secondFamilyName: row.secondFamilyName,
    givenName: row.givenName,
    secondGivenName: row.secondGivenName,
    sex: row.sex,
    birthDate: toClinicalDate(row.birthDate),
    birthDateEstimated: String(row.birthDateEstimated),
    deceasedAt: row.deceasedAt?.toISOString() ?? null,
    phone: row.phone,
    email: row.email,
    residenceAddressLine: row.residenceAddressLine,
    bloodType: row.bloodType,
    ethnicityConceptId: row.ethnicityConceptId,
    nationalityConceptId: row.nationalityConceptId,
    peopleConceptId: row.peopleConceptId,
    sexualOrientationConceptId: row.sexualOrientationConceptId,
    residenceParishConceptId: row.residenceParishConceptId,
    genderIdentityConceptId: row.genderIdentityConceptId,
    employerName: row.employerName,
    jobTitle: row.jobTitle,
    countryOfNationalityCode: row.countryOfNationalityCode,
    motherPatientId: row.motherPatientId,
  };
}

/** Un concepto guardado, tal como se registró. `null` si no hay referencia. */
function toConceptReference(
  row: { id: string; code: string; display: string } | null,
): CatalogConceptReference | null {
  return row === null
    ? null
    : { id: row.id, code: row.code, display: row.display };
}

/**
 * PA-028. La parroquia, con provincia y cantón DERIVADOS del código.
 *
 * La derivación vive en el dominio (`parishLocationOf`) y no en este `select`:
 * es una regla del DPA del INEC, no un detalle de almacenamiento, y hay dos
 * filas del archivo oficial que la hacen imprescindible.
 *
 * SALE SIN NOMBRES, con los dos `display` en `null`. Ponerlos es una consulta
 * al catálogo y esta función es pura; `namedParishOf` es la que los añade.
 */
function toParishReference(
  row: { id: string; code: string; display: string } | null,
): ParishReference | null {
  if (row === null) return null;
  return {
    id: row.id,
    code: row.code,
    display: row.display,
    ...parishLocationOf(row.code),
    provinceDisplay: null,
    cantonDisplay: null,
  };
}

/**
 * El texto del rastro, de vuelta al valor que la columna espera.
 *
 * ⚠️ UNA SOLA FUENTE PARA LAS DOS ESCRITURAS. La alternativa era pasar por el
 * puerto los valores tipados Y el rastro en texto, dos estructuras paralelas
 * que pueden discrepar — y discrepan el día que alguien añade un campo a una
 * sola. Aquí lo que se guarda en `patient` sale, literalmente, de lo que se
 * guarda en `patient_change_history`.
 */
function columnValueOf(change: PatientFieldChange): unknown {
  const text = change.valueAfter;

  switch (change.field) {
    case 'birthDateEstimated':
      return text === 'true';
    case 'birthDate':
      // Una fecha de calendario a la medianoche UTC que la columna `date`
      // guarda; nunca al huso del proceso.
      return text === null ? null : new Date(`${text}T00:00:00Z`);
    case 'deceasedAt':
      // Ya es el instante de la medianoche en Ecuador: lo resolvió el dominio
      // (`correctionTextOf`), que es donde vive la regla del huso.
      return text === null ? null : new Date(text);
    default:
      return text;
  }
}

/** The `type` cast rests on the PostgreSQL enum behind the column. */
function toIdentifier(row: {
  type: string;
  issuingCountry: string;
  value: string;
}): PatientIdentifier {
  return {
    type: row.type as PatientIdentifier['type'],
    issuingCountry: row.issuingCountry,
    value: row.value,
  };
}

/**
 * PA-054. The charts this one absorbed, as the application reads them.
 *
 * ALWAYS AN OBJECT, and the list is always an array. A chart that absorbed
 * nobody answers `{ total: 0, mrns: [] }` — never `null`, never absent. Making
 * a caller tell three states apart where the domain has two is how two of the
 * three branches end up right by accident and the third breaks the first time
 * somebody merges.
 */
function toAbsorbedCharts(total: number, mrns: string[]): AbsorbedCharts {
  return { total, mrns };
}

/**
 * A stored assessment to the shape the application reads.
 *
 * ONE MAPPING and not one per query: the two paths that return a record used
 * to repeat it, and a field added to only one of them is a response that
 * disagrees with itself depending on which call produced it.
 */
function toPriorityGroupRecord(row: {
  id: string;
  patientId: string;
  groupCode: string;
  startsOn: Date;
  endsOn: Date | null;
  origin: PriorityGroupOrigin;
  evidenceDocument: string | null;
  recordedById: string;
  recordedAt: Date;
  closedById: string | null;
  closedAt: Date | null;
}): PriorityGroupRecord {
  return {
    id: row.id,
    // La ficha en la que la fila ESTÁ, que con PA-055 puede ser una absorbida.
    chartId: row.patientId,
    group: row.groupCode as PriorityGroup,
    startsOn: toClinicalDate(row.startsOn),
    endsOn: row.endsOn === null ? null : toClinicalDate(row.endsOn),
    origin: row.origin,
    evidenceDocument: row.evidenceDocument,
    recordedById: row.recordedById,
    recordedAt: row.recordedAt,
    closedById: row.closedById,
    closedAt: row.closedAt,
  };
}

/**
 * A `date` column to the calendar date it holds.
 *
 * Prisma normalises `@db.Date` to UTC midnight, so slicing the ISO string is
 * the value stored and not a value shifted by anybody's zone. Reading it with
 * local getters is the bug this project already paid for once.
 */
function toClinicalDate(value: Date): ClinicalDate {
  return value.toISOString().slice(0, 10) as ClinicalDate;
}

/** The inverse: a calendar date to the UTC midnight the column expects. */
function fromClinicalDate(date: ClinicalDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** A priority group's period and nothing else: `priorityLevelOf` takes periods, never the group that says why (PA-041). */
function toPeriod(row: { startsOn: Date; endsOn: Date | null }): {
  startsOn: ClinicalDate;
  endsOn: ClinicalDate | null;
} {
  return {
    startsOn: toClinicalDate(row.startsOn),
    endsOn: row.endsOn === null ? null : toClinicalDate(row.endsOn),
  };
}

/**
 * Cualquier forma de escribir un número de historia, a su forma canónica.
 *
 * Devuelve `null` cuando lo tecleado no puede ser uno, para que la consulta
 * omita esa condición en vez de compararla contra una cadena vacía.
 */
function normaliseMrn(query: string): string | null {
  const match = /^\s*(?:hc)?\s*0*(\d{1,10})\s*$/i.exec(query);
  if (!match) return null;
  return formatMrn(Number(match[1]));
}

// ---------------------------------------------------------------------------
// Duplicate resolution: the snapshot and the two rejections that need a name
// ---------------------------------------------------------------------------

/**
 * PA-044. The absorbed chart as it stood, so the merge can be EXPLAINED and
 * UNDONE twelve months later.
 *
 * WRITTEN OUT FIELD BY FIELD, not `...row`. An ORM row drags whatever columns
 * were added since and, worse, whatever columns are added next — this snapshot
 * lands in an append-only table that is never purged, so what goes in has to be
 * a decision rather than a side effect of a migration. Dates leave as calendar
 * dates and instants as ISO 8601, for the same reason the API does it: a birth
 * date stored as an instant moves by a day for everybody west of Greenwich.
 *
 * The identifiers travel because they are the half that the undo has to give
 * back, and the half PA-048 can refuse to.
 */
async function snapshotOf(
  tx: Prisma.TransactionClient,
  patientId: string,
): Promise<Prisma.JsonObject> {
  const row = await tx.patient.findUniqueOrThrow({
    where: { id: patientId },
    select: {
      mrn: true,
      familyName: true,
      secondFamilyName: true,
      givenName: true,
      secondGivenName: true,
      sex: true,
      birthDate: true,
      birthDateEstimated: true,
      deceasedAt: true,
      ethnicityConceptId: true,
      nationalityConceptId: true,
      residenceParishConceptId: true,
      genderIdentityConceptId: true,
      countryOfNationalityCode: true,
      residenceAddressLine: true,
      phone: true,
      email: true,
      bloodType: true,
      isProvisional: true,
      motherPatientId: true,
      identifiers: {
        select: {
          type: true,
          issuingCountry: true,
          value: true,
          use: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  return {
    mrn: row.mrn,
    familyName: row.familyName,
    secondFamilyName: row.secondFamilyName,
    givenName: row.givenName,
    secondGivenName: row.secondGivenName,
    sex: row.sex,
    birthDate: row.birthDate.toISOString().slice(0, 10),
    birthDateEstimated: row.birthDateEstimated,
    deceasedAt: row.deceasedAt?.toISOString() ?? null,
    ethnicityConceptId: row.ethnicityConceptId,
    nationalityConceptId: row.nationalityConceptId,
    residenceParishConceptId: row.residenceParishConceptId,
    genderIdentityConceptId: row.genderIdentityConceptId,
    countryOfNationalityCode: row.countryOfNationalityCode,
    residenceAddressLine: row.residenceAddressLine,
    phone: row.phone,
    email: row.email,
    bloodType: row.bloodType,
    isProvisional: row.isProvisional,
    motherPatientId: row.motherPatientId,
    identifiers: row.identifiers.map((identifier) => ({
      type: identifier.type,
      issuingCountry: identifier.issuingCountry,
      value: identifier.value,
      use: identifier.use,
    })),
  };
}

/**
 * What PostgreSQL said, WITHOUT A SINGLE VALUE OF THE FAILING ROW.
 *
 * ⚠️ READ BEFORE REUSING THIS. PostgreSQL puts the offending row in
 * `cause.detail` — «Failing row contains (…, CEDULA, ECU, 1710034066, …)» is a
 * patient's national identifier — and `detail` is deliberately NOT read here.
 * What is read is the message, which for the rejections below is a sentence
 * this repository's own migration wrote, and it is only ever matched against a
 * regular expression: nothing out of it is returned, logged or stored.
 *
 * BOTH PLACES, because Prisma is inconsistent about where it puts it depending
 * on whether the statement went through the query builder or through raw SQL.
 * Reading one and not the other is how a translation silently stops matching.
 */
/**
 * PA-047. Which identifier rows the merge moved to the survivor, read back
 * from its own trail row.
 *
 * DEFENSIVE ON PURPOSE, and not because the writer is untrusted: `jsonb` has
 * no schema, and merges recorded before this key existed have none. Anything
 * that is not a list of strings means «none moved», which leaves the chart
 * exactly as those older merges left it — documents where they already are.
 * The alternative, throwing, would make those merges impossible to undo, which
 * is the failure this whole batch exists to remove.
 */
function movedIdentifierIdsOf(snapshot: Prisma.JsonValue | null): string[] {
  if (typeof snapshot !== 'object' || snapshot === null) return [];
  if (Array.isArray(snapshot)) return [];

  const moved = snapshot.movedIdentifierIds;
  if (!Array.isArray(moved)) return [];

  return moved.filter((id): id is string => typeof id === 'string');
}

/**
 * Serialises everything that touches this chart's merge state, PA-044/PA-047.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE LOCK IS ITS OWN STATEMENT AND THE READ IS ANOTHER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The obvious shape — one `SELECT … FOR UPDATE` that both locks and returns
 * the state — is WRONG here, and quietly. When the statement has to wait for
 * a concurrent writer, PostgreSQL re-checks the row through EvalPlanQual, and
 * EPQ substitutes the updated tuple only for the LOCKED relation: anything
 * reached through a join is still evaluated against the snapshot the statement
 * started with. So the join to the surviving chart kept answering NULL — «this
 * chart is whole» — on a chart the other transaction had just merged, which is
 * precisely the state this lock exists to detect. Verified against PostgreSQL
 * 18: the joined column read `NULL` while a plain `SELECT` issued straight
 * afterwards, in the same transaction, read the new link.
 *
 * Locking first and reading afterwards has no such hole. Under READ COMMITTED
 * the second statement takes a fresh snapshot, and by then the writer this one
 * waited for has committed, so it sees what actually happened.
 *
 * ON THE SOURCE CHART, which is the row both operations change and therefore
 * the one both must queue on. The target is locked afterwards by
 * `trg_patient_merge_not_chained` — always in that order, source then target,
 * so two merges cannot deadlock against each other.
 */
async function lockChart(
  tx: Prisma.TransactionClient,
  patientId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM patient WHERE id = ${patientId}::uuid FOR UPDATE
  `;
}

/**
 * Every message a rejection carries — the ORM's and the driver's original —
 * joined, so the matchers below find a trigger's sentence or a constraint name
 * whichever layer reported it.
 */
function databaseMessageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';

  const parts: string[] = [];
  const candidate = error as {
    message?: unknown;
    meta?: {
      driverAdapterError?: { cause?: { originalMessage?: unknown } };
    };
  };

  if (typeof candidate.message === 'string') parts.push(candidate.message);
  const original = candidate.meta?.driverAdapterError?.cause?.originalMessage;
  if (typeof original === 'string') parts.push(original);

  return parts.join('\n');
}

/**
 * PA-045, PA-046. Which of `trg_patient_merge_not_chained`'s three refusals
 * happened, or `undefined` when the failure is something else entirely.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE SENTENCES AND THREE ANSWERS, BECAUSE WHAT TO DO IS DIFFERENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The chain has two ends — fusing INTO a chart that is itself merged (A→B when
 * B→C), and fusing a chart that has already absorbed others (B→C when A→B) —
 * and both are `PATIENT_ALREADY_MERGED`: undo the OTHER merge first.
 *
 * The third door is different and used to be lumped in with them: re-pointing
 * an ALREADY MERGED source at a new target. There the chart the desk is
 * holding has moved, and the `SPEC.md` is explicit that a merged SOURCE
 * answers `PATIENT_MERGED` with the MRN of its survivor (PA-045) — «dos
 * códigos porque lo que hay que hacer es distinto: allí se abre la ficha
 * vigente, aquí se deshace la otra fusión primero».
 *
 * ⚠️ NOT A SECOND COPY OF THE RULE. The rule is the trigger; this only decides
 * what the rejection MEANS to whoever is at the desk.
 */
function mergeRefusalOf(
  error: unknown,
): 'target' | 'source-absorbed' | 'source-merged' | undefined {
  const message = databaseMessageOf(error);
  if (/is itself merged into/.test(message)) return 'target';
  if (/already absorbed other charts/.test(message)) return 'source-absorbed';
  if (/is already merged into/.test(message)) return 'source-merged';
  return undefined;
}

/**
 * PA-047. Whether the undo was refused because this merge already has an
 * `UNDO` row pointing at it.
 *
 * THE CONSTRAINT NAME IS THE CONTRACT, exactly as with the identifier index:
 * it is the only thing in the rejection that tells a second undo apart from
 * any other unique violation, and it is why the migration names its
 * constraints descriptively instead of letting Prisma number them.
 *
 * The column is matched too because the two layers word it differently: the
 * driver's own message carries the constraint, and the ORM's carries the
 * field. Either one alone is specific to this constraint; neither appears in
 * any other rejection this repository can produce.
 */
function isMergeAlreadyUndone(error: unknown): boolean {
  return /patient_merge_undone_once|undoes_merge_id|undoesMergeId/.test(
    databaseMessageOf(error),
  );
}

/**
 * PA-013, PA-048. Whether the write was refused by
 * `patient_identifier_active_unique`: another LIVE chart holds this document.
 *
 * THE INDEX NAME IS THE CONTRACT, which is why the migration names its
 * constraints descriptively: it is the only thing in the rejection that tells
 * this apart from any other unique violation, and it travels in the message
 * PostgreSQL raises.
 *
 * ⚠️ ONE READING, TWO MEANINGS, AND EL SIGNIFICADO LO PONE QUIEN LLAMA. On a
 * registration the desk typed the document, so the answer is
 * `PATIENT_IDENTIFIER_TAKEN`; on an undo the caller typed nothing at all, so it
 * is `MERGE_UNDO_CONFLICT` (PA-048). The index cannot tell them apart — only
 * the operation can.
 */
function hitsActiveIdentifierIndex(error: unknown): boolean {
  return /patient_identifier_active_unique/.test(databaseMessageOf(error));
}
