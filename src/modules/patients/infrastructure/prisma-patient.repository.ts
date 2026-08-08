import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { formatMrn } from '../domain/mrn';
import type {
  NewPatient,
  PatientSortField,
  PatientDetail,
  PatientIdentifier,
  PatientPage,
  PatientRepository,
  PatientSearchCriteria,
  PatientSummary,
} from '../domain/patient.repository';

/**
 * Rows in, domain shapes out.
 *
 * Everything Prisma-shaped stops here. The application above never sees a
 * `Prisma.` type, which is what makes the search strategy below replaceable.
 */

/** The columns a list row needs, and no clinical data at all. */
const SUMMARY_SELECT = {
  id: true,
  mrn: true,
  familyName: true,
  secondFamilyName: true,
  givenName: true,
  secondGivenName: true,
  sex: true,
  birthDate: true,
  birthDateEstimated: true,
  deceasedAt: true,
  identifiers: {
    where: { validTo: null },
    select: { type: true, issuingCountry: true, value: true },
    orderBy: { createdAt: 'asc' },
    take: 1,
  },
} satisfies Prisma.PatientSelect;

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

    const documentPrefix = `${query}%`;
    const searchesDocument = /^[A-Za-z0-9-]{4,}$/.test(query);

    const filter =
      query === ''
        ? Prisma.sql`TRUE`
        : Prisma.sql`(
          p.search_name LIKE immutable_unaccent(lower(${pattern}))
          OR p.mrn = upper(${query})
          OR (${searchesDocument} AND EXISTS (
            SELECT 1 FROM patient_identifier pi
            WHERE pi.patient_id = p.id
              AND pi.valid_to IS NULL
              AND pi.value LIKE ${documentPrefix}
          ))
        )`;

    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id
      FROM patient p
      WHERE (${matches}) AND ${filter}
      ORDER BY ${Prisma.raw(orderBy)}
      LIMIT ${criteria.pageSize} OFFSET ${offset}
    `;

    const [{ count }] = await this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT count(*) AS count
      FROM patient p
      WHERE (${matches}) AND ${filter}
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
        isProvisional: true,
        createdAt: true,
        mergedInto: { select: { mrn: true } },
      },
    });
    if (!row) return null;

    return {
      ...this.toSummary({ ...row, identifiers: row.identifiers.slice(0, 1) }),
      identifiers: row.identifiers.map(toIdentifier),
      phone: row.phone,
      email: row.email,
      bloodType: row.bloodType,
      residenceAddressLine: row.residenceAddressLine,
      isProvisional: row.isProvisional,
      mergedIntoMrn: row.mergedInto?.mrn ?? null,
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
          // No document yet means the chart is provisional. It still exists,
          // and it still gets an MRN — a newborn cannot wait for paperwork.
          isProvisional: !patient.identifier,
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
    identifiers: { type: string; issuingCountry: string; value: string }[];
  }): PatientSummary {
    return {
      id: row.id,
      mrn: row.mrn,
      familyName: row.familyName,
      secondFamilyName: row.secondFamilyName,
      givenName: row.givenName,
      secondGivenName: row.secondGivenName,
      sex: row.sex,
      birthDate: row.birthDate,
      birthDateEstimated: row.birthDateEstimated,
      deceasedAt: row.deceasedAt,
      primaryIdentifier: row.identifiers[0]
        ? toIdentifier(row.identifiers[0])
        : null,
    };
  }
}

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
