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

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('El seed de pacientes nunca debe correr contra producción');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  const existentes = await prisma.patient.count();
  if (existentes > 0) {
    console.log(
      `Ya hay ${existentes} pacientes. Borrando para volver a sembrar…`,
    );
    await prisma.patientIdentifier.deleteMany({});
    await prisma.patient.deleteMany({});
  }

  // La secuencia se reinicia para que los números de historia empiecen en 1 y
  // sean legibles al revisarlos a mano.
  await prisma.$executeRawUnsafe(
    'ALTER SEQUENCE patient_mrn_seq RESTART WITH 1',
  );

  // Fecha fija: el seed tiene que ser reproducible, y `new Date()` haría que
  // las edades cambiaran entre ejecuciones.
  const hoy = new Date('2026-08-08T00:00:00Z');

  for (let i = 0; i < TOTAL; i += 1) {
    const esMujer = i % 2 === 0;
    const nombres = esMujer ? NOMBRES_F : NOMBRES_M;

    // Uno de cada siete no tiene documento: recién nacidos y sin identificar.
    const sinDocumento = i % 7 === 0;

    await prisma.patient.create({
      data: {
        mrn: formatMrn(i + 1),
        familyName: APELLIDOS[i % APELLIDOS.length]!,
        secondFamilyName:
          i % 3 === 0 ? undefined : APELLIDOS[(i * 13) % APELLIDOS.length]!,
        givenName: nombres[i % nombres.length]!,
        secondGivenName:
          i % 4 === 0 ? undefined : nombres[(i * 11) % nombres.length]!,
        sex: esMujer ? 'FEMALE' : 'MALE',
        birthDate: nacimientoPara(i, hoy),
        // La fecha estimada se marca como tal: sin el indicador, una
        // aproximación se reporta al ministerio como un hecho.
        birthDateEstimated: i % 25 === 0,
        isProvisional: sinDocumento,
        phone:
          i % 5 === 0 ? undefined : `09${String(80000000 + i).slice(0, 8)}`,
        identifiers: sinDocumento
          ? undefined
          : {
              create: {
                type: 'CEDULA',
                issuingCountry: 'ECU',
                value: cedulaPara(i),
              },
            },
      },
    });
  }

  const conDocumento = await prisma.patientIdentifier.count();
  console.log(`Sembrados ${TOTAL} pacientes (${conDocumento} con cédula).`);
  console.log(
    '  Incluye apellidos con Ñ y tildes, y recién nacidos sin documento.',
  );
  await prisma.$disconnect();
}

await main();
