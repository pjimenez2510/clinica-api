import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { formatMrn } from '../src/modules/patients/domain/mrn.ts';

/**
 * Un registro de pacientes lo bastante grande para que se note.
 *
 * POR QUÉ HACE FALTA. Con cinco filas todo funciona: la paginación no aparece,
 * la ordenación parece correcta aunque la dirección no se aplique, y una
 * consulta que ordena la tabla entera en memoria tarda lo mismo que una que usa
 * un índice. Los defectos de un listado sólo se ven cuando hay listado.
 *
 * QUÉ SE CUIDA EN LOS DATOS:
 *
 *  - Apellidos ecuatorianos REALES, con Ñ, tildes y de todo el alfabeto. Son
 *    los que rompen la ordenación por bytes y la búsqueda sin tildes; con
 *    «Perez» y «Ramos» cualquier implementación pasa.
 *  - Cédulas con dígito verificador CALCULADO. La base valida el módulo 10, así
 *    que un número inventado se rechaza — y de paso comprobamos el algoritmo
 *    contra la implementación de PostgreSQL en cada ejecución.
 *  - Edades repartidas de recién nacido a noventa años, porque el formato de
 *    edad cambia por tramos: días, meses y años.
 *  - Una parte SIN documento: recién nacidos y pacientes sin identificar
 *    existen, y son el caso que más se olvida al maquetar una tabla.
 *
 * DETERMINISTA, sin `Math.random()`: dos ejecuciones dan el mismo registro, así
 * que un fallo que se ve en pantalla se puede volver a reproducir.
 */
const APELLIDOS = [
  'Andrade',
  'Álvarez',
  'Arévalo',
  'Bravo',
  'Buitrón',
  'Caiza',
  'Cando',
  'Carrión',
  'Castillo',
  'Chalán',
  'Chimbo',
  'Cóndor',
  'Cueva',
  'Delgado',
  'Encalada',
  'Espinoza',
  'Farinango',
  'Freire',
  'Gallardo',
  'Guamán',
  'Guerrero',
  'Herrera',
  'Hidalgo',
  'Iza',
  'Jácome',
  'Jiménez',
  'Lema',
  'Loor',
  'Lucero',
  'Llumiquinga',
  'Macas',
  'Mendoza',
  'Morocho',
  'Muñoz',
  'Naranjo',
  'Nuñez',
  'Ñacato',
  'Ñaupa',
  'Ochoa',
  'Ordóñez',
  'Ortega',
  'Pacheco',
  'Pallo',
  'Paredes',
  'Pilataxi',
  'Quinatoa',
  'Quishpe',
  'Ramírez',
  'Rivadeneira',
  'Rodríguez',
  'Salazar',
  'Sánchez',
  'Shiguango',
  'Simbaña',
  'Tamayo',
  'Tenesaca',
  'Toapanta',
  'Tucumbi',
  'Ulloa',
  'Vaca',
  'Valencia',
  'Vargas',
  'Velásquez',
  'Villacís',
  'Yépez',
  'Yumbo',
  'Zambrano',
  'Zapata',
  'Zúñiga',
];

const NOMBRES_F = [
  'Ana',
  'Beatriz',
  'Carmen',
  'Daniela',
  'Elena',
  'Fernanda',
  'Gabriela',
  'Isabel',
  'Jessica',
  'Karina',
  'Lucía',
  'María',
  'Nayeli',
  'Paola',
  'Rocío',
  'Sofía',
  'Tatiana',
  'Verónica',
  'Ximena',
  'Yolanda',
];

const NOMBRES_M = [
  'Andrés',
  'Bryan',
  'Carlos',
  'Diego',
  'Édison',
  'Fernando',
  'Gonzalo',
  'Héctor',
  'Iván',
  'Jorge',
  'Klever',
  'Luis',
  'Marco',
  'Nelson',
  'Óscar',
  'Patricio',
  'Rodrigo',
  'Santiago',
  'Vinicio',
  'Wilson',
];

/**
 * Dígito verificador de la cédula ecuatoriana, módulo 10.
 *
 * Se CALCULA en vez de inventarse: `is_valid_cedula()` en la base rechaza los
 * números que no cuadran, así que un dato falso reventaría el seed — que es
 * justo lo que debe pasar.
 */
function conDigitoVerificador(primeros9: string): string {
  const digitos = [...primeros9].map(Number);
  const total = digitos.reduce((suma, digito, indice) => {
    if (indice % 2 !== 0) return suma + digito;
    const doble = digito * 2;
    return suma + (doble > 9 ? doble - 9 : doble);
  }, 0);
  return primeros9 + String((10 - (total % 10)) % 10);
}

/**
 * Provincias 01–24. La 30 (residentes en el exterior) se usa cada 50.
 *
 * NUEVE dígitos antes del verificador, para un total de diez. La primera
 * versión construía siete y producía cédulas de nueve, que la restricción
 * `patient_identifier_cedula_valid` rechazó en la primera fila. Es el
 * comportamiento correcto de la base y por eso el seed no inventa números: los
 * calcula y falla ruidosamente si no cuadran.
 */
function cedulaPara(indice: number): string {
  const provincia = indice % 50 === 0 ? 30 : (indice % 24) + 1;
  /**
   * EL TERCER DÍGITO VA DE 0 A 5. Seis o más identifica a un RUC —entidades
   * públicas y personas jurídicas—, nunca a la cédula de una persona. La
   * primera versión lo dejaba entre 1 y 9 y la base rechazó 144 de 685.
   */
  const tercero = indice % 6;
  const resto = String(100_000 + ((indice * 7919) % 900_000)); // 6 dígitos
  const primeros9 =
    String(provincia).padStart(2, '0') + String(tercero) + resto;

  const cedula = conDigitoVerificador(primeros9);
  if (cedula.length !== 10) {
    throw new Error(`Cédula generada con longitud ${cedula.length}: ${cedula}`);
  }
  return cedula;
}

/**
 * Fecha de nacimiento repartida por tramos.
 *
 * Uno de cada veinte es un bebé de días o meses, para que se vea que el formato
 * de edad cambia. El resto se reparte hasta los noventa años.
 */
function nacimientoPara(indice: number, hoy: Date): Date {
  const dias =
    indice % 20 === 0
      ? indice % 400 // recién nacidos y lactantes
      : 365 * (1 + (indice % 90)) + (indice % 365);
  return new Date(hoy.getTime() - dias * 86_400_000);
}

const TOTAL = Number(process.env.SEED_PATIENTS ?? 800);

/** What one run did, for the console summary and the integration suite. */
export interface PatientSeedResult {
  created: number;
  /** Seeded charts that had lost their cedula and got it back. */
  repaired: number;
  /** Seeded MRNs already held by a chart that is no longer the seed's. */
  foreign: number;
  /** Not created because another chart holds their cedula. */
  skipped: number;
  /** The MRN the next registration will receive. */
  nextMrn: string;
}

/** What seeded patient `indice` is, the same on every run. */
function pacientePara(indice: number, hoy: Date) {
  const esMujer = indice % 2 === 0;
  const nombres = esMujer ? NOMBRES_F : NOMBRES_M;
  // Uno de cada siete no tiene documento: recién nacidos y sin identificar.
  const sinDocumento = indice % 7 === 0;

  return {
    mrn: formatMrn(indice + 1),
    familyName: APELLIDOS[indice % APELLIDOS.length]!,
    secondFamilyName:
      indice % 3 === 0
        ? undefined
        : APELLIDOS[(indice * 13) % APELLIDOS.length]!,
    givenName: nombres[indice % nombres.length]!,
    secondGivenName:
      indice % 4 === 0 ? undefined : nombres[(indice * 11) % nombres.length]!,
    sex: esMujer ? ('FEMALE' as const) : ('MALE' as const),
    birthDate: nacimientoPara(indice, hoy),
    // La fecha estimada se marca como tal: sin el indicador, una
    // aproximación se reporta al ministerio como un hecho.
    birthDateEstimated: indice % 25 === 0,
    isProvisional: sinDocumento,
    phone:
      indice % 5 === 0
        ? undefined
        : `09${String(80000000 + indice).slice(0, 8)}`,
    cedula: sinDocumento ? null : cedulaPara(indice),
  };
}

/**
 * Seeds `total` (default `SEED_PATIENTS`, 800) fictitious charts. Repeatable by ADDING WHAT IS
 * MISSING, never by deleting: patient `i` is always `HC` + (i + 1), so a run
 * creates the seeded charts whose MRN is still free and leaves every existing
 * one alone — edited from the screen, booked in the agenda or billed.
 *
 * WHY IT NO LONGER REPLACES. It used to delete every identifier and every
 * patient and start again. Once other seeds and the screens hang rows from
 * those patients (`agenda_entry`, encounters…), the patient delete is refused
 * by the RESTRICT foreign keys — AFTER the identifier delete had already gone
 * through, outside any transaction: the 10-10-2026 run on the author's base
 * left every chart without its cedula. A development seed must not destroy
 * what other screens use, so it no longer deletes anything.
 *
 * THE REPAIR. A seeded chart that is still the seed's (same MRN and names)
 * but lost its cedula gets it back, provided nobody else holds that number.
 * That is what puts a base damaged by the old seed right.
 */
export async function seedPatients(
  prisma: PrismaClient,
  total = TOTAL,
): Promise<PatientSeedResult> {
  // `Array.from({ length: NaN })` is an empty array: a typo in SEED_PATIENTS
  // would otherwise seed nothing and say nothing.
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`SEED_PATIENTS must be a non-negative integer: ${total}`);
  }

  // Fecha fija: el seed tiene que ser reproducible, y `new Date()` haría que
  // las edades cambiaran entre ejecuciones.
  const hoy = new Date('2026-08-08T00:00:00Z');
  const sembrados = Array.from({ length: total }, (_, i) =>
    pacientePara(i, hoy),
  );

  const existentes = new Map(
    (
      await prisma.patient.findMany({
        where: { mrn: { in: sembrados.map((p) => p.mrn) } },
        select: {
          id: true,
          mrn: true,
          familyName: true,
          givenName: true,
          birthDate: true,
          isProvisional: true,
          _count: { select: { identifiers: true } },
        },
      })
    ).map((p) => [p.mrn, p]),
  );
  const cedulasOcupadas = new Set(
    (
      await prisma.patientIdentifier.findMany({
        where: {
          type: 'CEDULA',
          issuingCountry: 'ECU',
          value: { in: sembrados.flatMap((p) => p.cedula ?? []) },
        },
        select: { value: true },
      })
    ).map((i) => i.value),
  );

  // Not updated inside the loop on purpose: `cedulaPara` gives every index a
  // different number while `total` stays under 900 000 (7919 is coprime with
  // it), so no two seeded charts can claim the same cedula in one run.
  let creados = 0;
  let reparados = 0;
  let ajenos = 0;
  let omitidos = 0;
  for (const { cedula, ...paciente } of sembrados) {
    const existente = existentes.get(paciente.mrn);
    const cedulaLibre = cedula !== null && !cedulasOcupadas.has(cedula);

    if (existente) {
      // Still the seed's chart, untouched where it matters: a chart moved to
      // provisional from the screen lost its document on purpose.
      const esElSembrado =
        existente.familyName === paciente.familyName &&
        existente.givenName === paciente.givenName &&
        existente.birthDate.getTime() === paciente.birthDate.getTime() &&
        existente.isProvisional === paciente.isProvisional;
      if (!esElSembrado) ajenos += 1;
      else if (cedulaLibre && existente._count.identifiers === 0) {
        await prisma.patientIdentifier.create({
          data: {
            patientId: existente.id,
            type: 'CEDULA',
            issuingCountry: 'ECU',
            value: cedula,
          },
        });
        reparados += 1;
      }
      continue;
    }

    // Somebody registered that cedula under another chart: creating the
    // seeded one without it would be a different patient, so it is left out.
    if (cedula !== null && !cedulaLibre) {
      omitidos += 1;
      continue;
    }

    await prisma.patient.create({
      data: {
        ...paciente,
        identifiers: cedula
          ? {
              create: { type: 'CEDULA', issuingCountry: 'ECU', value: cedula },
            }
          : undefined,
      },
    });
    creados += 1;
  }

  /**
   * LA SECUENCIA QUEDA POR DELANTE DE TODA HISTORIA, sembrada o no.
   *
   * Los números sembrados no salen de `nextval`: son fijos para que la base
   * se lea igual en cada corrida. Por eso, al terminar, la secuencia se lleva
   * al mayor número que exista —nunca hacia atrás, que reemitiría el de un
   * paciente registrado en pantalla—. Sin esto el primer paciente registrado
   * DE VERDAD recibiría un número ya usado y chocaría contra el índice único:
   * un fallo que sólo aparece después de sembrar, y en el mostrador.
   */
  await prisma.$executeRaw`
    SELECT setval('patient_mrn_seq', mayor)
      FROM (
        SELECT GREATEST(
                 (SELECT max(substring(mrn FROM 3)::bigint) FROM patient WHERE mrn ~ '^HC[0-9]{10}$'),
                 (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM patient_mrn_seq)
               ) AS mayor
      ) AS t
     WHERE mayor >= 1`;

  /**
   * Se comprueba en vez de darlo por hecho: es la garantía que faltaba, y su
   * ausencia no se notaba hasta que alguien registraba un paciente.
   */
  const filas = await prisma.$queryRawUnsafe<{ siguiente: bigint }[]>(
    'SELECT last_value + (CASE WHEN is_called THEN 1 ELSE 0 END) AS siguiente FROM patient_mrn_seq',
  );
  // Desestructurar directamente daría `possibly undefined` con `noUncheckedIndexedAccess`,
  // y silenciarlo con `!` en una comprobación de integridad sería contradictorio.
  const siguiente = filas[0]?.siguiente;
  if (siguiente === undefined) {
    throw new Error('No se pudo leer el estado de patient_mrn_seq');
  }

  const proximoMrn = formatMrn(Number(siguiente));
  const yaExiste = await prisma.patient.findUnique({
    where: { mrn: proximoMrn },
    select: { id: true },
  });
  if (yaExiste) {
    throw new Error(
      `La secuencia daría ${proximoMrn}, que ya existe. El seed dejó la base en un estado que rompe el próximo registro.`,
    );
  }

  return {
    created: creados,
    repaired: reparados,
    foreign: ajenos,
    skipped: omitidos,
    nextMrn: proximoMrn,
  };
}

/** Entry point of `pnpm db:seed:patients`. Demo data: refuses production. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('El seed de pacientes nunca debe correr contra producción');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const r = await seedPatients(prisma);
    const conDocumento = await prisma.patientIdentifier.count();
    console.log(
      `Pacientes: ${r.created} creados, ${r.repaired} con su cédula repuesta, ` +
        `${TOTAL - r.created - r.skipped - r.foreign} sembrados ya presentes` +
        (r.foreign > 0
          ? `, ${r.foreign} números ocupados por otra historia`
          : '') +
        (r.skipped > 0
          ? `, ${r.skipped} omitidos (su cédula la tiene otra historia)`
          : '') +
        `. ${conDocumento} cédulas en la base.`,
    );
    console.log(
      '  Incluye apellidos con Ñ y tildes, y recién nacidos sin documento.',
    );
    console.log(
      `  La próxima historia que emita el sistema será ${r.nextMrn}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only when invoked directly, so the integration suite can import
// `seedPatients` without connecting twice.
if (process.argv[1]?.endsWith('seed-patients.mts')) {
  await main();
}
