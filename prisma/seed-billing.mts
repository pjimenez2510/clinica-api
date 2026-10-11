import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Siembra el arranque de FACTURACIÓN y del catálogo de EXÁMENES.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PARA QUÉ HACE FALTA: UNA CLÍNICA RECIÉN INSTALADA NO PUEDE COBRAR NADA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El modelo de dinero de este sistema son cuatro piezas separadas a propósito
 * —`service` sin precio, `price_list` + `price` por pagador y por
 * fecha, `charge_item` que CONGELA el precio del día, y `invoice` inmutable—.
 * Esa separación es lo que impide que subir una tarifa reescriba en silencio
 * las facturas del año pasado. El coste de esa separación es que una base
 * recién migrada no tiene NI UN pagador, NI UNA lista y NI UNA prestación: la
 * pantalla de caja abre vacía y parece rota, igual que le pasaba al selector de
 * parroquia antes del 13-08-2026.
 *
 * Esto es el arranque, no la verdad. Todo lo que hay aquí —pagadores,
 * prestaciones, precios, tarifas de IVA— es EDITABLE desde la aplicación, y
 * por eso la siembra nunca pisa lo que alguien ya cambió: ver «idempotencia»
 * más abajo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ EL IVA NO SE INFIERE. D-A-006, Y HAY QUE LEERLO ANTES DE COBRAR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Las prestaciones de salud son 0% (LRTI art. 56.2), PERO el 0% depende del
 * PRESTADOR y no del servicio: el art. 191 del reglamento lo condiciona a
 * establecimiento autorizado y a profesional con título de tercer nivel
 * registrado. Y EXCLUYE expresamente la cirugía estética y los tratamientos
 * cosmetológicos, que van a tarifa general (15%); la reconstructiva vuelve a
 * 0% sólo si es «a consecuencia de enfermedades o accidentes debidamente
 * comprobados» — un juicio clínico, de una persona, que tiene que quedar
 * auditable en la ficha y no resuelto por una regla del sistema.
 *
 * Por eso cada prestación lleva su `tax_rate_id` como DATO, y por eso este
 * archivo siembra un VALOR POR DEFECTO RAZONABLE Y NADA MÁS:
 *
 *   · prestaciones de salud .......... 0%  (código SRI 0)
 *   · insumos y dispositivos ......... 15% (código SRI 4) — no figuran entre
 *     los bienes con tarifa 0% del art. 55
 *   · estética y cosmetología ........ 15% (código SRI 4) — art. 191
 *
 * **ALGUIEN CON CRITERIO CONTABLE TIENE QUE REVISARLO PRESTACIÓN POR
 * PRESTACIÓN.** Clasificar una prestación tiene consecuencias fiscales y no la
 * decide un agente ni un valor por defecto. Lo que sí decide el sistema es que
 * la tarifa esté a la vista y se pueda cambiar, en vez de estar escondida en
 * una constante del código.
 *
 * Y una advertencia que se repite en la tabla: **los códigos 6 («no objeto») y
 * 7 («exento») NO son sinónimos de 0%.** Los tres producen cero de impuesto y
 * significan tres cosas distintas en el 104 y en el anexo transaccional.
 * Usarlos por comodidad, porque «total es cero», es un error de declaración.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IDEMPOTENCIA: SE PUEDE CORRER MIL VECES, Y NO PISA LO QUE ALGUIEN CAMBIÓ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dos reglas distintas, y la diferencia importa:
 *
 *   · Lo que fija la NORMA —los porcentajes y las vigencias de `tax_rate`— se
 *     actualiza: si el archivo dice 15% desde una fecha, esa es la verdad y no
 *     hay nada que respetar de una edición local.
 *   · Lo que decide la CLÍNICA —pagadores, prestaciones, listas, precios,
 *     analitos, exámenes— se crea si falta y NUNCA se sobreescribe. Una
 *     clínica que renombró «Consulta de medicina general» o que corrigió la
 *     tarifa de una prestación lo hizo a propósito, y un despliegue que se lo
 *     devolviera sería un fallo que parece magia. Es la misma disciplina de
 *     `seed-specialties.mts` y de `seed-authorisation.mts`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ SQL EN CRUDO Y NO EL CLIENTE DE PRISMA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tres de las garantías de estas tablas no se pueden expresar en
 * `schema.prisma` y viven sólo en la migración: la unicidad temporal
 * `UNIQUE (sri_code, valid_period WITHOUT OVERLAPS)` de `tax_rate`, la
 * equivalente de `price`, y la columna generada `valid_period`. Además,
 * `ON CONFLICT` no sabe inferir un constraint respaldado por GiST, así que en
 * esas dos tablas la idempotencia se hace con una comprobación explícita en
 * vez de con un `upsert`. Donde SÍ hay una clave única de verdad —`code` en
 * `payer`, `service`, `analyte_definition` y `service_exam`— se usa
 * `ON CONFLICT ("code")`, que es el upsert que pide el modelo.
 *
 * EL DINERO NUNCA PASA POR UN `number`. Los importes viven como cadena en este
 * archivo, se construyen con `Prisma.Decimal` y se enlazan ya formateados a
 * dos decimales con un `::decimal(12,2)` explícito. Un `0.1 + 0.2` en coma
 * flotante es la factura descuadrada por un centavo que nadie sabe explicar.
 */

// ───────────────────────────────────────────────────────────────────────────
// Fechas de arranque
// ───────────────────────────────────────────────────────────────────────────

/**
 * Desde cuándo rige la tarifa general del 15%, por Decreto Ejecutivo 198.
 *
 * Está en una constante y no repartida por el archivo porque es EL dato que
 * hay que corregir si la fecha de vigencia cambia, y porque parte en dos la
 * línea temporal del 12%: `tax_rate` no admite solape POR CÓDIGO, así que la
 * vigencia del código 2 termina exactamente donde empieza la del código 4.
 */
const GENERAL_RATE_FROM = '2024-04-01';

/**
 * Fecha de inicio de los precios sembrados.
 *
 * Anclada al inicio del año y no a hoy, por el mismo motivo que el catálogo de
 * países: `charge_item` resuelve el precio POR FECHA DE SERVICIO, y una fecha
 * de arranque puesta hoy dejaría sin precio cualquier atención de este año que
 * se facture con retraso.
 */
const PRICE_FROM = '2026-01-01';

/**
 * Fecha lo bastante antigua para las tarifas que ya regían antes de que
 * existiera este sistema. No pretende ser la fecha real de la reforma que las
 * creó: sólo garantiza que la vigencia cubre cualquier fecha de servicio que
 * esta base pueda llegar a ver.
 */
const LONG_AGO = '2000-01-01';

// ───────────────────────────────────────────────────────────────────────────
// 1. `tax_rate` — los códigos reales de la tabla 17 de la Ficha Técnica
// ───────────────────────────────────────────────────────────────────────────

/** One period of one SRI rate code. Norm-fixed, so re-seeding overwrites it. */
interface SeedTaxRate {
  /** `codigoPorcentaje` del comprobante electrónico. */
  sriCode: string;
  name: string;
  /** Cadena, nunca `number`. NULL donde no aplica porcentaje alguno. */
  percentage: string | null;
  validFrom: string;
  validTo: string | null;
}

/**
 * Cada código tiene su PROPIA línea temporal: la unicidad de la tabla es
 * `(sri_code, valid_period WITHOUT OVERLAPS)`, así que el 12% y el 15% pueden
 * convivir en la tabla —y deben— mientras no se solapen entre sí.
 */
const TAX_RATES: SeedTaxRate[] = [
  {
    sriCode: '0',
    name: 'IVA 0%',
    percentage: '0.00',
    validFrom: LONG_AGO,
    validTo: null,
  },
  {
    // Precede al 15% y se cierra justo donde aquél empieza. Se conserva porque
    // una factura de antes de esa fecha tiene que seguir diciendo 12%.
    sriCode: '2',
    name: 'IVA 12%',
    percentage: '12.00',
    validFrom: LONG_AGO,
    validTo: GENERAL_RATE_FROM,
  },
  {
    // Histórico real y acotado: la tarifa del 14% rigió durante un año por la
    // Ley Solidaria posterior al terremoto de abril de 2016.
    sriCode: '3',
    name: 'IVA 14%',
    percentage: '14.00',
    validFrom: '2016-06-01',
    validTo: '2017-06-01',
  },
  {
    sriCode: '4',
    name: 'IVA 15%',
    percentage: '15.00',
    validFrom: GENERAL_RATE_FROM,
    validTo: null,
  },
  {
    sriCode: '5',
    name: 'IVA 5%',
    percentage: '5.00',
    validFrom: LONG_AGO,
    validTo: null,
  },
  {
    // ⚠️ NO ES 0%. «No objeto de IVA» significa que la operación queda FUERA
    // del hecho generador del impuesto; el 0% significa que está dentro y
    // grava a cero. En el formulario 104 y en el anexo transaccional van en
    // casillas distintas. `percentage` es NULL porque no hay porcentaje que
    // aplicar, no porque el porcentaje sea cero.
    sriCode: '6',
    name: 'No objeto de impuesto',
    percentage: null,
    validFrom: LONG_AGO,
    validTo: null,
  },
  {
    // ⚠️ TAMPOCO ES 0%. «Exento» es una dispensa legal expresa sobre una
    // operación que sí es objeto del impuesto. Mismo NULL y mismo motivo:
    // ningún porcentaje aplica. Elegir 6 o 7 «porque total sale cero» es un
    // error de declaración, no un atajo.
    sriCode: '7',
    name: 'Exento de IVA',
    percentage: null,
    validFrom: LONG_AGO,
    validTo: null,
  },
  {
    // Existe para las reducciones temporales que el Ejecutivo decreta por
    // feriados. Vigencia abierta a propósito: su aplicación se decide por la
    // fecha de emisión del comprobante, no por un periodo fijo que este
    // archivo pueda conocer de antemano.
    sriCode: '10',
    name: 'IVA 13%',
    percentage: '13.00',
    validFrom: '2023-01-01',
    validTo: null,
  },
];

/** Los dos códigos que este archivo asigna a prestaciones. */
const HEALTH_ZERO = '0';
const GENERAL_RATE = '4';

// ───────────────────────────────────────────────────────────────────────────
// 2. `payer` — quién paga
// ───────────────────────────────────────────────────────────────────────────

/** A starting payer, keyed by `code`; created if missing, never overwritten. */
interface SeedPayer {
  code: string;
  name: string;
  kind:
    'SELF_PAY' | 'PUBLIC_NETWORK' | 'PRIVATE_INSURANCE' | 'COMPANY_AGREEMENT';
  agreementReference: string | null;
}

/**
 * BI-300 (D-229 §2). Whether a new payer is born active: the public network
 * is not —the clinic switches it on when it signs with it—, everything else
 * is. Only on creation; an existing payer keeps the state the clinic gave it.
 */
const bornActive = (payer: SeedPayer): boolean =>
  payer.kind !== 'PUBLIC_NETWORK';

/**
 * Los pagadores son una TABLA y no un enum porque este sistema no corre en una
 * sola clínica: los seguros privados y los convenios de empresa cambian de una
 * instalación a otra, y de un año al siguiente dentro de la misma.
 *
 * ESTA LISTA ES SÓLO EL ARRANQUE Y SE EDITA DESDE LA APLICACIÓN. Se añaden,
 * se desactivan y se renombran pagadores sin tocar el código ni desplegar
 * nada. Los dos últimos son EJEMPLOS deliberados —uno de cada uno de los dos
 * `kind` que no vienen dados por la ley— para que se vea cómo se añade el
 * propio; se desactivan o se renombran, no hace falta borrarlos.
 *
 * `ruc` va NULL en todos: el RUC de una institución se copia del convenio
 * firmado, no se teclea de memoria ni se inventa en una semilla.
 */
const PAYERS: SeedPayer[] = [
  {
    code: 'PARTICULAR',
    name: 'Particular (paga el paciente)',
    kind: 'SELF_PAY',
    agreementReference: null,
  },
  {
    code: 'IESS',
    name: 'IESS — Instituto Ecuatoriano de Seguridad Social',
    kind: 'PUBLIC_NETWORK',
    agreementReference: null,
  },
  {
    code: 'ISSFA',
    name: 'ISSFA — Instituto de Seguridad Social de las Fuerzas Armadas',
    kind: 'PUBLIC_NETWORK',
    agreementReference: null,
  },
  {
    code: 'ISSPOL',
    name: 'ISSPOL — Instituto de Seguridad Social de la Policía Nacional',
    kind: 'PUBLIC_NETWORK',
    agreementReference: null,
  },
  {
    code: 'MSP',
    name: 'MSP — Red Pública Integral de Salud',
    kind: 'PUBLIC_NETWORK',
    agreementReference: null,
  },
  {
    code: 'SEGURO-PRIVADO-EJEMPLO',
    name: 'Seguro privado (ejemplo — sustitúyalo por el suyo)',
    kind: 'PRIVATE_INSURANCE',
    agreementReference: 'EJEMPLO — sin convenio real en archivo',
  },
  {
    code: 'CONVENIO-EMPRESA-EJEMPLO',
    name: 'Convenio de empresa (ejemplo — sustitúyalo por el suyo)',
    kind: 'COMPANY_AGREEMENT',
    agreementReference: 'EJEMPLO — sin convenio real en archivo',
  },
];

/** El pagador cuya lista se exhibe al público y cuyos precios se siembran. */
const SELF_PAY_CODE = 'PARTICULAR';

// ───────────────────────────────────────────────────────────────────────────
// 4. `service` — el catálogo de arranque (ADR-013)
// ───────────────────────────────────────────────────────────────────────────

/**
 * BI-278 (ADR-013). The kind of each starting service: it is what the
 * category used to say, and it decides what structure the row admits.
 */
type ServiceKind =
  'CONSULTATION' | 'PROCEDURE' | 'LAB_EXAM' | 'IMAGING' | 'SUPPLY' | 'OTHER';

/**
 * BI-279. The consultation's base duration by visit, the one the specialty's
 * «Primera vez» and «Control» types had (SP-020, D-007).
 */
const CONSULTATION_MINUTES = { FIRST_VISIT: 30, FOLLOW_UP: 20 } as const;

/** A starting service and its PARTICULAR price; created if missing, never overwritten. */
interface SeedService {
  code: string;
  name: string;
  kind: ServiceKind;
  /** Código SRI de la tarifa por defecto. REVISABLE — ver D-A-006 arriba. */
  taxSriCode: string;
  /**
   * Precio de arranque de la lista PARTICULAR, en USD. Cadena, no `number`.
   * Todo servicio sembrado lo trae (BI-232, D-228): la pantalla no deja crear
   * uno sin él, y la semilla tampoco.
   */
  selfPayAmount: string;
  /**
   * BI-279, BI-287 (ADR-013). Si es una CONSULTA, su especialidad y su visita:
   * la duración sale de `CONSULTATION_MINUTES`. Es lo que la cita reserva y lo
   * que caja propone al pasar la atención a caja. Si la especialidad no está
   * en la base, la consulta no se siembra: no puede existir sin ella
   * (`service_consultation_shape`), y la siembra del catálogo económico no
   * puede fallar entera porque falte una fila del clínico.
   */
  consultation?: {
    specialtyCode: string;
    visitKind: keyof typeof CONSULTATION_MINUTES;
  };
}

/**
 * BI-232. Las especialidades de `seed-specialties.mts` que no tienen consulta
 * entre las de arriba, con su abreviatura para el código, su nombre en
 * minúscula para el servicio y su precio particular («Primera vez», «Control»).
 *
 * LOS PRECIOS SON DE EJEMPLO, en la línea de los de arriba. Antes estas
 * consultas nacían sin precio (D-161); con el precio particular obligatorio al
 * crear (D-228), la semilla tampoco deja una sin él, y la clínica lo corrige
 * en Servicios.
 *
 * El código cabe en los 25 caracteres del SRI (BI-171): `CONS-` + abreviatura
 * + `-SUB`. Se siembran sólo si la especialidad existe, como las cinco de arriba.
 */
const OTHER_SPECIALTY_CONSULTATIONS: readonly {
  specialtyCode: string;
  abbreviation: string;
  name: string;
  /** Self-pay price: first visit, follow-up. */
  amounts: readonly [string, string];
}[] = [
  {
    specialtyCode: 'medicina-familiar',
    abbreviation: 'MF',
    name: 'medicina familiar y comunitaria',
    amounts: ['30.00', '20.00'],
  },
  {
    specialtyCode: 'medicina-interna',
    abbreviation: 'MI',
    name: 'medicina interna',
    amounts: ['40.00', '28.00'],
  },
  {
    specialtyCode: 'cirugia-general',
    abbreviation: 'CG',
    name: 'cirugía general',
    amounts: ['45.00', '30.00'],
  },
  {
    specialtyCode: 'cardiologia',
    abbreviation: 'CAR',
    name: 'cardiología',
    amounts: ['50.00', '35.00'],
  },
  {
    specialtyCode: 'psiquiatria',
    abbreviation: 'PSQ',
    name: 'psiquiatría',
    amounts: ['50.00', '35.00'],
  },
  {
    specialtyCode: 'oftalmologia',
    abbreviation: 'OFT',
    name: 'oftalmología',
    amounts: ['45.00', '30.00'],
  },
  {
    specialtyCode: 'otorrinolaringologia',
    abbreviation: 'ORL',
    name: 'otorrinolaringología',
    amounts: ['45.00', '30.00'],
  },
  {
    specialtyCode: 'urologia',
    abbreviation: 'URO',
    name: 'urología',
    amounts: ['45.00', '30.00'],
  },
  {
    specialtyCode: 'neurologia',
    abbreviation: 'NEU',
    name: 'neurología',
    amounts: ['50.00', '35.00'],
  },
  {
    specialtyCode: 'endocrinologia',
    abbreviation: 'END',
    name: 'endocrinología',
    amounts: ['50.00', '35.00'],
  },
  {
    specialtyCode: 'gastroenterologia',
    abbreviation: 'GAS',
    name: 'gastroenterología',
    amounts: ['50.00', '35.00'],
  },
  {
    specialtyCode: 'neumologia',
    abbreviation: 'NML',
    name: 'neumología',
    amounts: ['45.00', '30.00'],
  },
  {
    specialtyCode: 'nefrologia',
    abbreviation: 'NEF',
    name: 'nefrología',
    amounts: ['50.00', '35.00'],
  },
  {
    specialtyCode: 'reumatologia',
    abbreviation: 'REU',
    name: 'reumatología',
    amounts: ['50.00', '35.00'],
  },
  {
    specialtyCode: 'anestesiologia',
    abbreviation: 'ANE',
    name: 'anestesiología',
    amounts: ['40.00', '28.00'],
  },
  {
    specialtyCode: 'medicina-emergencias',
    abbreviation: 'EME',
    name: 'medicina de emergencias y desastres',
    amounts: ['35.00', '25.00'],
  },
  {
    specialtyCode: 'odontologia',
    abbreviation: 'ODO',
    name: 'odontología',
    amounts: ['30.00', '20.00'],
  },
];

const OTHER_CONSULTATIONS: SeedService[] =
  OTHER_SPECIALTY_CONSULTATIONS.flatMap(
    ({ specialtyCode, abbreviation, name, amounts }) => [
      {
        code: `CONS-${abbreviation}-PV`,
        name: `Consulta de ${name} · Primera vez`,
        kind: 'CONSULTATION',
        taxSriCode: HEALTH_ZERO,
        selfPayAmount: amounts[0],
        consultation: { specialtyCode, visitKind: 'FIRST_VISIT' },
      },
      {
        code: `CONS-${abbreviation}-SUB`,
        name: `Consulta de ${name} · Control`,
        kind: 'CONSULTATION',
        taxSriCode: HEALTH_ZERO,
        selfPayAmount: amounts[1],
        consultation: { specialtyCode, visitKind: 'FOLLOW_UP' },
      },
    ],
  );

/**
 * Un catálogo de arranque para una clínica ambulatoria multiespecialidad.
 * Realista, no exhaustivo: es lo que hace que la primera consulta se pueda
 * cobrar el primer día, y a partir de ahí la clínica lo amplía.
 *
 * `msp_code` va NULL en todos. El Tarifario del MSP es NOMENCLATURA y no
 * fija lo que se cobra a un paciente particular —su alcance quedó acotado a
 * las relaciones dentro de la red pública por el A.M. 0046-2017—, y poner
 * códigos inventados sería peor que no poner ninguno: se llenaría de datos que
 * parecen oficiales. Se completan cuando la clínica facture a la red pública.
 */
const SERVICES: SeedService[] = [
  // ── Consultas ────────────────────────────────────────────────────────────
  // Todas a 0%: prestación de salud, LRTI art. 56.2.
  {
    code: 'CONS-MG-PV',
    name: 'Consulta de medicina general · Primera vez',
    kind: 'CONSULTATION',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '30.00',
    consultation: {
      specialtyCode: 'medicina-general',
      visitKind: 'FIRST_VISIT',
    },
  },
  {
    code: 'CONS-MG-SUB',
    name: 'Consulta de medicina general · Control',
    kind: 'CONSULTATION',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '20.00',
    consultation: { specialtyCode: 'medicina-general', visitKind: 'FOLLOW_UP' },
  },
  {
    code: 'CONS-PED-PV',
    name: 'Consulta de pediatría · Primera vez',
    kind: 'CONSULTATION',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '40.00',
    consultation: { specialtyCode: 'pediatria', visitKind: 'FIRST_VISIT' },
  },
  {
    code: 'CONS-PED-SUB',
    name: 'Consulta de pediatría · Control',
    kind: 'CONSULTATION',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '28.00',
    consultation: { specialtyCode: 'pediatria', visitKind: 'FOLLOW_UP' },
  },
  {
    code: 'CONS-GIN-PV',
    name: 'Consulta de ginecología · Primera vez',
    kind: 'CONSULTATION',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '45.00',
    consultation: {
      specialtyCode: 'ginecologia-obstetricia',
      visitKind: 'FIRST_VISIT',
    },
  },
  {
    code: 'CONS-GIN-SUB',
    name: 'Consulta de ginecología · Control',
    kind: 'CONSULTATION',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '30.00',
    consultation: {
      specialtyCode: 'ginecologia-obstetricia',
      visitKind: 'FOLLOW_UP',
    },
  },
  {
    code: 'CONS-DER-PV',
    name: 'Consulta de dermatología · Primera vez',
    kind: 'CONSULTATION',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '50.00',
    consultation: { specialtyCode: 'dermatologia', visitKind: 'FIRST_VISIT' },
  },
  {
    code: 'CONS-DER-SUB',
    name: 'Consulta de dermatología · Control',
    kind: 'CONSULTATION',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '35.00',
    consultation: { specialtyCode: 'dermatologia', visitKind: 'FOLLOW_UP' },
  },
  {
    code: 'CONS-TRA-PV',
    name: 'Consulta de traumatología · Primera vez',
    kind: 'CONSULTATION',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '50.00',
    consultation: {
      specialtyCode: 'traumatologia-ortopedia',
      visitKind: 'FIRST_VISIT',
    },
  },
  {
    code: 'CONS-TRA-SUB',
    name: 'Consulta de traumatología · Control',
    kind: 'CONSULTATION',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '35.00',
    consultation: {
      specialtyCode: 'traumatologia-ortopedia',
      visitKind: 'FOLLOW_UP',
    },
  },

  // BI-232: la consulta de las demás especialidades del catálogo.
  ...OTHER_CONSULTATIONS,

  // ── Procedimientos ───────────────────────────────────────────────────────
  {
    code: 'PROC-CURACION',
    name: 'Curación simple de herida',
    kind: 'PROCEDURE',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '15.00',
  },
  {
    code: 'PROC-SUTURA',
    name: 'Sutura de herida (hasta 5 cm)',
    kind: 'PROCEDURE',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '45.00',
  },
  {
    code: 'PROC-RETIRO-PUNTOS',
    name: 'Retiro de puntos de sutura',
    kind: 'PROCEDURE',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '10.00',
  },
  {
    code: 'PROC-INFILTRACION',
    name: 'Infiltración articular',
    kind: 'PROCEDURE',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '60.00',
  },
  {
    code: 'PROC-NEBULIZACION',
    name: 'Nebulización',
    kind: 'PROCEDURE',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '12.00',
  },
  {
    code: 'PROC-ECG',
    name: 'Electrocardiograma de 12 derivaciones',
    kind: 'PROCEDURE',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '25.00',
  },
  {
    // ⚠️ 15%, Y NO ES UN DESCUIDO. El art. 191 del reglamento a la LRTI saca
    // expresamente la cirugía estética y los tratamientos cosmetológicos del
    // 0% de las prestaciones de salud: van a tarifa general.
    //
    // La misma sustancia, aplicada por una indicación terapéutica —espasticidad,
    // distonía, migraña crónica— es prestación de salud y vuelve al 0%. Y la
    // cirugía reconstructiva vuelve al 0% sólo si es «a consecuencia de
    // enfermedades o accidentes DEBIDAMENTE COMPROBADOS»: la comprobación es un
    // juicio clínico de una persona, tiene que quedar escrita en la ficha y
    // auditable, y por eso son DOS prestaciones distintas en el catálogo y no
    // una casilla que alguien marca en caja.
    // ≤25: the voucher's `codigoPrincipal` (BI-171). Was
    // PROC-ESTETICA-TOXINA-BOTULINICA, renamed in place below.
    code: 'PROC-ESTETICA-TOXINA-BOT',
    name: 'Aplicación de toxina botulínica con fin estético',
    kind: 'PROCEDURE',
    taxSriCode: GENERAL_RATE,
    selfPayAmount: '250.00',
  },

  // ── Laboratorio ──────────────────────────────────────────────────────────
  {
    code: 'LAB-BH',
    name: 'Biometría hemática completa',
    kind: 'LAB_EXAM',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '8.00',
  },
  {
    code: 'LAB-QUIMICA',
    name: 'Química sanguínea (perfil básico)',
    kind: 'LAB_EXAM',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '18.00',
  },
  {
    code: 'LAB-GLUCOSA-AYUNAS',
    name: 'Glucosa en ayunas',
    kind: 'LAB_EXAM',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '4.00',
  },
  {
    code: 'LAB-EMO',
    name: 'Elemental y microscópico de orina (EMO)',
    kind: 'LAB_EXAM',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '6.00',
  },
  {
    code: 'LAB-COPROPARASITARIO',
    name: 'Coproparasitario',
    kind: 'LAB_EXAM',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '6.00',
  },
  {
    code: 'LAB-TSH',
    name: 'TSH (hormona estimulante de la tiroides)',
    kind: 'LAB_EXAM',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '14.00',
  },
  {
    code: 'LAB-HBA1C',
    name: 'Hemoglobina glicosilada (HbA1c)',
    kind: 'LAB_EXAM',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '16.00',
  },
  {
    code: 'LAB-PERFIL-LIPIDICO',
    name: 'Perfil lipídico',
    kind: 'LAB_EXAM',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '20.00',
  },

  // ── Imagen ───────────────────────────────────────────────────────────────
  {
    code: 'IMG-RX-SIMPLE',
    name: 'Radiografía simple (una proyección)',
    kind: 'IMAGING',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '20.00',
  },
  // ORD-163. La radiografía de tórax es UN examen con su prestación: con la
  // genérica «Radiografía simple» el examen se habría llamado así. El precio es
  // el que cobraba hasta hoy a través de aquélla.
  {
    code: 'IMG-RX-TORAX',
    name: 'Radiografía de tórax (PA y lateral)',
    kind: 'IMAGING',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '20.00',
  },
  {
    code: 'IMG-ECO-ABDOMINAL',
    name: 'Ecografía abdominal',
    kind: 'IMAGING',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '30.00',
  },
  {
    code: 'IMG-ECO-OBSTETRICA',
    name: 'Ecografía obstétrica',
    kind: 'IMAGING',
    taxSriCode: HEALTH_ZERO,
    selfPayAmount: '35.00',
  },

  // ── Insumos ──────────────────────────────────────────────────────────────
  // ⚠️ TODOS A 15%, y ésta es la otra mitad de D-A-006 que se olvida: el 0% del
  // art. 56.2 cubre el SERVICIO de salud, no los bienes que se usan para
  // prestarlo. Un dispositivo o un insumo sólo va a 0% si figura en la lista
  // cerrada de bienes del art. 55, y guantes, gasas o catéteres no figuran.
  // (Los MEDICAMENTOS sí están en el art. 55.6 y por eso NO se siembra ninguno
  // aquí: entrarían a 0% y merecen su propia revisión, no heredar esta línea.)
  {
    code: 'INS-GUANTES-EXAMEN',
    name: 'Par de guantes de examinación',
    kind: 'SUPPLY',
    taxSriCode: GENERAL_RATE,
    selfPayAmount: '0.50',
  },
  {
    code: 'INS-JERINGUILLA-5ML',
    name: 'Jeringuilla descartable 5 ml',
    kind: 'SUPPLY',
    taxSriCode: GENERAL_RATE,
    selfPayAmount: '0.35',
  },
  {
    code: 'INS-GASA-ESTERIL',
    name: 'Gasa estéril (paquete)',
    kind: 'SUPPLY',
    taxSriCode: GENERAL_RATE,
    selfPayAmount: '0.80',
  },
  {
    code: 'INS-VENDA-ELASTICA',
    name: 'Venda elástica 10 cm',
    kind: 'SUPPLY',
    taxSriCode: GENERAL_RATE,
    selfPayAmount: '2.50',
  },
  {
    code: 'INS-CATETER-IV-20',
    name: 'Catéter intravenoso N.º 20',
    kind: 'SUPPLY',
    taxSriCode: GENERAL_RATE,
    selfPayAmount: '1.80',
  },
  {
    code: 'INS-APOSITO-ADHESIVO',
    name: 'Apósito adhesivo estéril',
    kind: 'SUPPLY',
    taxSriCode: GENERAL_RATE,
    selfPayAmount: '0.60',
  },
  {
    code: 'INS-EQUIPO-VENOCLISIS',
    name: 'Equipo de venoclisis',
    kind: 'SUPPLY',
    taxSriCode: GENERAL_RATE,
    selfPayAmount: '1.50',
  },
];

// ───────────────────────────────────────────────────────────────────────────
// 6. Analitos, rangos y exámenes
// ───────────────────────────────────────────────────────────────────────────

/** One reference, critical or absolute range of an analyte, optionally per sex. */
interface SeedRange {
  kind: 'REFERENCE' | 'CRITICAL' | 'ABSOLUTE';
  /** `MALE` / `FEMALE`, los mismos rótulos que el enum `patient_sex`. NULL = todos. */
  sex: 'MALE' | 'FEMALE' | null;
  low: string | null;
  high: string | null;
  text: string | null;
}

/** A starting laboratory analyte, keyed by `code`; created if missing, never overwritten. */
interface SeedAnalyte {
  code: string;
  name: string;
  /**
   * Sólo donde se conoce con CERTEZA. Es opcional a propósito: ninguna norma
   * ecuatoriana exige LOINC —el formulario 010 no tiene columna de código— y
   * el mapeo es trabajo humano experto. Un código puesto «a ojo» es peor que
   * la ausencia: viaja a una interoperación y afirma algo falso.
   */
  loincCode: string | null;
  /** UCUM, para que `mg/dL` signifique una sola cosa. NULL en los codificados. */
  unit: string | null;
  valueType: 'NUMERIC' | 'CODED' | 'TEXT' | 'ORDINAL';
  decimals: number | null;
  allowedValues: string[] | null;
  ranges: SeedRange[];
}

/**
 * `1` es la unidad adimensional de UCUM. La densidad urinaria es un cociente
 * entre densidades y no tiene unidad; escribir `g/mL` sería inventarse una.
 * Hace falta porque `analyte_definition_numeric_carries_a_unit` obliga a que
 * todo analito numérico declare la suya, y esa obligación es correcta.
 */
const UCUM_UNITY = '1';

/** «Por campo de gran aumento», la unidad del sedimento urinario en UCUM. */
const UCUM_PER_HPF = '/[HPF]';

const ANALYTES: SeedAnalyte[] = [
  // ── Biometría hemática ───────────────────────────────────────────────────
  {
    // La hemoglobina y el hematocrito son EL caso que justifica que el rango
    // sea una tabla y no dos columnas en el analito: el intervalo de
    // referencia difiere por sexo, y calcular `abnormal_flag` con un rango
    // único marcaría como anémico a medio padrón.
    code: 'HB',
    name: 'Hemoglobina',
    loincCode: '718-7',
    unit: 'g/dL',
    valueType: 'NUMERIC',
    decimals: 1,
    allowedValues: null,
    ranges: [
      { kind: 'REFERENCE', sex: 'MALE', low: '13.0', high: '17.0', text: null },
      {
        kind: 'REFERENCE',
        sex: 'FEMALE',
        low: '12.0',
        high: '15.5',
        text: null,
      },
    ],
  },
  {
    code: 'HCT',
    name: 'Hematocrito',
    loincCode: null,
    unit: '%',
    valueType: 'NUMERIC',
    decimals: 1,
    allowedValues: null,
    ranges: [
      { kind: 'REFERENCE', sex: 'MALE', low: '40.0', high: '52.0', text: null },
      {
        kind: 'REFERENCE',
        sex: 'FEMALE',
        low: '36.0',
        high: '47.0',
        text: null,
      },
    ],
  },
  {
    code: 'WBC',
    name: 'Leucocitos',
    loincCode: null,
    unit: '10*3/uL',
    valueType: 'NUMERIC',
    decimals: 2,
    allowedValues: null,
    ranges: [
      { kind: 'REFERENCE', sex: null, low: '4.50', high: '11.00', text: null },
    ],
  },
  {
    code: 'PLT',
    name: 'Plaquetas',
    loincCode: null,
    unit: '10*3/uL',
    valueType: 'NUMERIC',
    decimals: 0,
    allowedValues: null,
    ranges: [
      { kind: 'REFERENCE', sex: null, low: '150', high: '450', text: null },
    ],
  },
  {
    code: 'NEUT-PCT',
    name: 'Neutrófilos',
    loincCode: null,
    unit: '%',
    valueType: 'NUMERIC',
    decimals: 1,
    allowedValues: null,
    ranges: [
      { kind: 'REFERENCE', sex: null, low: '40.0', high: '70.0', text: null },
    ],
  },
  {
    code: 'LYMPH-PCT',
    name: 'Linfocitos',
    loincCode: null,
    unit: '%',
    valueType: 'NUMERIC',
    decimals: 1,
    allowedValues: null,
    ranges: [
      { kind: 'REFERENCE', sex: null, low: '20.0', high: '45.0', text: null },
    ],
  },

  // ── Glucosa ──────────────────────────────────────────────────────────────
  {
    code: 'GLU',
    name: 'Glucosa en ayunas',
    loincCode: '2345-7',
    unit: 'mg/dL',
    valueType: 'NUMERIC',
    decimals: 0,
    allowedValues: null,
    ranges: [
      { kind: 'REFERENCE', sex: null, low: '70', high: '100', text: null },
      {
        // El rango CRÍTICO no es un rango de referencia más estrecho: es el
        // umbral a partir del cual el resultado se avisa al médico tratante
        // ANTES de imprimir nada. Por eso es una fila con su propio `range_kind`
        // y no una columna extra: el mismo analito puede tener referencia por
        // sexo y un solo crítico para todos.
        kind: 'CRITICAL',
        sex: null,
        low: '40',
        high: '400',
        text: 'Fuera de estos límites: aviso inmediato al médico tratante y constancia de la notificación.',
      },
    ],
  },

  // ── EMO ──────────────────────────────────────────────────────────────────
  // La mezcla de numéricos y CODIFICADOS es la razón de que `value_type` exista:
  // «Nitritos: positivo» no admite ni unidad ni rango numérico, y forzarlo a un
  // número obligaría a inventar una codificación 0/1 que nadie sabría leer en
  // el informe impreso.
  {
    code: 'EMO-ASPECTO',
    name: 'Aspecto',
    loincCode: null,
    unit: null,
    valueType: 'CODED',
    decimals: null,
    allowedValues: ['Claro', 'Ligeramente turbio', 'Turbio'],
    ranges: [
      { kind: 'REFERENCE', sex: null, low: null, high: null, text: 'Claro' },
    ],
  },
  {
    code: 'EMO-COLOR',
    name: 'Color',
    loincCode: null,
    unit: null,
    valueType: 'CODED',
    decimals: null,
    allowedValues: ['Amarillo claro', 'Amarillo', 'Ámbar', 'Rojizo'],
    ranges: [
      {
        kind: 'REFERENCE',
        sex: null,
        low: null,
        high: null,
        text: 'Amarillo claro',
      },
    ],
  },
  {
    code: 'EMO-DENSIDAD',
    name: 'Densidad',
    loincCode: null,
    unit: UCUM_UNITY,
    valueType: 'NUMERIC',
    decimals: 3,
    allowedValues: null,
    ranges: [
      { kind: 'REFERENCE', sex: null, low: '1.005', high: '1.030', text: null },
    ],
  },
  {
    code: 'EMO-PH',
    name: 'pH',
    loincCode: null,
    unit: '[pH]',
    valueType: 'NUMERIC',
    decimals: 1,
    allowedValues: null,
    ranges: [
      { kind: 'REFERENCE', sex: null, low: '4.5', high: '8.0', text: null },
    ],
  },
  {
    code: 'EMO-PROTEINAS',
    name: 'Proteínas',
    loincCode: null,
    unit: null,
    valueType: 'CODED',
    decimals: null,
    allowedValues: ['Negativo', 'Trazas', '+', '++', '+++'],
    ranges: [
      { kind: 'REFERENCE', sex: null, low: null, high: null, text: 'Negativo' },
    ],
  },
  {
    code: 'EMO-GLUCOSA',
    name: 'Glucosa en orina',
    loincCode: null,
    unit: null,
    valueType: 'CODED',
    decimals: null,
    allowedValues: ['Negativo', 'Trazas', '+', '++', '+++'],
    ranges: [
      { kind: 'REFERENCE', sex: null, low: null, high: null, text: 'Negativo' },
    ],
  },
  {
    code: 'EMO-NITRITOS',
    name: 'Nitritos',
    loincCode: null,
    unit: null,
    valueType: 'CODED',
    decimals: null,
    allowedValues: ['Negativo', 'Positivo'],
    ranges: [
      { kind: 'REFERENCE', sex: null, low: null, high: null, text: 'Negativo' },
    ],
  },
  {
    code: 'EMO-LEUCOCITOS-CAMPO',
    name: 'Leucocitos por campo',
    loincCode: null,
    unit: UCUM_PER_HPF,
    valueType: 'NUMERIC',
    decimals: 0,
    allowedValues: null,
    ranges: [{ kind: 'REFERENCE', sex: null, low: '0', high: '5', text: null }],
  },
  {
    code: 'EMO-HEMATIES-CAMPO',
    name: 'Hematíes por campo',
    loincCode: null,
    unit: UCUM_PER_HPF,
    valueType: 'NUMERIC',
    decimals: 0,
    allowedValues: null,
    ranges: [{ kind: 'REFERENCE', sex: null, low: '0', high: '2', text: null }],
  },
  {
    code: 'EMO-CELULAS-EPITELIALES',
    name: 'Células epiteliales',
    loincCode: null,
    unit: null,
    valueType: 'CODED',
    decimals: null,
    allowedValues: ['Escasas', 'Regulares', 'Abundantes'],
    ranges: [
      { kind: 'REFERENCE', sex: null, low: null, high: null, text: 'Escasas' },
    ],
  },
  {
    code: 'EMO-BACTERIAS',
    name: 'Bacterias',
    loincCode: null,
    unit: null,
    valueType: 'CODED',
    decimals: null,
    allowedValues: ['Ausentes', 'Escasas', 'Regulares', 'Abundantes'],
    ranges: [
      { kind: 'REFERENCE', sex: null, low: null, high: null, text: 'Ausentes' },
    ],
  },
  // ── Imagen y procedimiento ───────────────────────────────────────────────
  {
    // Lo que vuelve de una radiografía, una ecografía o un electrocardiograma
    // es un informe escrito. Sin una determinación que lo reciba, la línea no
    // se completa nunca (ORD-039) y la orden se queda en la cola de
    // pendientes para siempre: revisión de `fix/atencion-examenes`.
    code: 'INFORME',
    name: 'Informe',
    loincCode: null,
    unit: null,
    valueType: 'TEXT',
    decimals: null,
    allowedValues: null,
    ranges: [],
  },
];

/**
 * A starting ordered service (BI-284): its order extension —010A section,
 * specimen, preparation, fast, turnaround— and its analytes in print order.
 */
interface SeedExam {
  /** Código del SERVICIO que se pide (ADR-013: el examen es el servicio). */
  serviceCode: string;
  /**
   * NO es un dato: el nombre es el del servicio. Sólo documenta la semilla y
   * la comprueba —el servicio tiene que llamarse así—.
   */
  name: string;
  /** Sección del formulario 010A del MSP, para poder imprimir una orden conforme. */
  form010Section: string;
  specimenType: string;
  patientPreparation: string;
  /** ORD-129 (D-137). Las horas mínimas de ayuno, o `null` si no lo pide. */
  fastingHours: number | null;
  turnaroundHours: number;
  /**
   * BI-285 (D-218). Su código en el Tarifario de Prestaciones del SNS 2014:
   * opcional, sale en el RIDE, y no es condición para pedirlo. Se escribe en
   * el servicio sólo si no tiene ya uno.
   */
  mspCode: string;
  /** En orden de impresión. */
  analyteCodes: string[];
}

/**
 * Tres exámenes completos, y completos a propósito: lo que demuestran es la
 * cardinalidad 1:N entre lo ORDENABLE y lo RESULTABLE. «Biometría hemática» es
 * UNA línea en la orden y UNA línea en la factura, y devuelve seis valores con
 * su unidad, su rango y su bandera. Sin esta relación un resultado no tiene
 * contra qué validarse y el informe no puede imprimir la columna «VALOR DE
 * REFERENCIA» que exige el formulario 010B.
 *
 * `performed_externally` se queda en el `true` por defecto (D-A-012): que el
 * laboratorio sea externo es el caso realista de una clínica ambulatoria. El
 * nombre del laboratorio de referencia lo pone la clínica; inventarlo aquí
 * sería poner un dato falso con apariencia de configuración.
 */
const EXAMS: SeedExam[] = [
  {
    name: 'Biometría hemática completa',
    form010Section: 'HEMATOLOGÍA',
    specimenType: 'Sangre total con EDTA',
    patientPreparation: 'No requiere ayuno.',
    turnaroundHours: 4,
    fastingHours: null,
    serviceCode: 'LAB-BH',
    mspCode: '340077',
    analyteCodes: ['HB', 'HCT', 'WBC', 'PLT', 'NEUT-PCT', 'LYMPH-PCT'],
  },
  {
    name: 'Glucosa en ayunas',
    form010Section: 'BIOQUÍMICA',
    specimenType: 'Suero',
    patientPreparation:
      'Ayuno de 8 a 12 horas. Puede beber agua. No suspenda su medicación sin indicación médica.',
    turnaroundHours: 4,
    fastingHours: 8,
    serviceCode: 'LAB-GLUCOSA-AYUNAS',
    mspCode: '360009',
    analyteCodes: ['GLU'],
  },
  {
    name: 'Elemental y microscópico de orina (EMO)',
    form010Section: 'ORINA',
    specimenType: 'Orina, primera micción de la mañana, chorro medio',
    patientPreparation:
      'Aseo genital previo. Recoja el chorro medio en frasco estéril y entréguelo dentro de las 2 horas siguientes.',
    turnaroundHours: 4,
    fastingHours: null,
    serviceCode: 'LAB-EMO',
    mspCode: '380012',
    analyteCodes: [
      'EMO-COLOR',
      'EMO-ASPECTO',
      'EMO-DENSIDAD',
      'EMO-PH',
      'EMO-PROTEINAS',
      'EMO-GLUCOSA',
      'EMO-NITRITOS',
      'EMO-LEUCOCITOS-CAMPO',
      'EMO-HEMATIES-CAMPO',
      'EMO-CELULAS-EPITELIALES',
      'EMO-BACTERIAS',
    ],
  },
  // ORD-101. Dos de imagen y uno de procedimiento, para que el filtro por tipo
  // de la pestaña de órdenes tenga algo que filtrar. Devuelven un informe
  // escrito, la determinación `INFORME`.
  {
    name: 'Radiografía de tórax (PA y lateral)',
    form010Section: 'RAYOS X',
    specimenType: '',
    patientPreparation: 'Retire objetos metálicos del tórax.',
    turnaroundHours: 24,
    fastingHours: null,
    serviceCode: 'IMG-RX-TORAX',
    mspCode: '71020',
    analyteCodes: ['INFORME'],
  },
  {
    name: 'Ecografía abdominal',
    form010Section: 'ECOGRAFÍA',
    specimenType: '',
    patientPreparation:
      'Ayuno de 6 horas. Vejiga llena: beba 1 litro de agua una hora antes.',
    turnaroundHours: 24,
    fastingHours: 6,
    serviceCode: 'IMG-ECO-ABDOMINAL',
    mspCode: '76700',
    analyteCodes: ['INFORME'],
  },
  {
    name: 'Electrocardiograma de 12 derivaciones',
    form010Section: 'CARDIOLOGÍA',
    specimenType: '',
    patientPreparation: 'No requiere preparación.',
    turnaroundHours: 2,
    fastingHours: null,
    serviceCode: 'PROC-ECG',
    mspCode: '550123',
    analyteCodes: ['INFORME'],
  },
];

// ───────────────────────────────────────────────────────────────────────────
// Escritura
// ───────────────────────────────────────────────────────────────────────────

/** Every writer below runs inside the one transaction `seedBilling` opens. */
type Client = Prisma.TransactionClient;

/** Importe formateado a dos decimales SIN pasar nunca por coma flotante. */
function money(amount: string): string {
  return new Prisma.Decimal(amount).toFixed(2);
}

/**
 * `tax_rate`: se ACTUALIZA, porque lo fija la norma y no la clínica.
 *
 * Sin `ON CONFLICT`: la unicidad de esta tabla es
 * `(sri_code, valid_period WITHOUT OVERLAPS)`, un constraint temporal
 * respaldado por GiST, y `ON CONFLICT` no sabe inferirlo. La comprobación por
 * `(sri_code, valid_from)` es equivalente para el conjunto que sembramos.
 */
async function ensureTaxRate(tx: Client, rate: SeedTaxRate): Promise<string> {
  // MATCHED BY `sri_code` ALONE, and `valid_from` is part of what gets
  // updated. Keying on `(sri_code, valid_from)` looked equivalent — this seed
  // declares exactly one row per code — but it is not, and the difference bit:
  // correcting a date in this file then finds nothing, tries to INSERT, and
  // collides with the row it meant to correct («conflicting key value violates
  // exclusion constraint "tax_rate_code_temporal_unique"»).
  //
  // That is the whole point of seeding by update rather than by insert: the
  // file is the declared truth and the table converges on it, including when
  // the truth was wrong yesterday. It was — the 15% has run since April 2024,
  // not 2026.
  const found = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "tax_rate" WHERE "sri_code" = ${rate.sriCode}`;

  const existing = found[0];
  if (existing) {
    await tx.$executeRaw`
      UPDATE "tax_rate"
         SET "name"       = ${rate.name},
             "percentage" = ${rate.percentage}::decimal(5, 2),
             "valid_from" = ${rate.validFrom}::date,
             "valid_to"   = ${rate.validTo}::date,
             "updated_at" = CURRENT_TIMESTAMP
       WHERE "id" = ${existing.id}::uuid`;
    return existing.id;
  }

  const created = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "tax_rate" ("sri_code", "name", "percentage", "valid_from", "valid_to", "updated_at")
    VALUES (${rate.sriCode}, ${rate.name}, ${rate.percentage}::decimal(5, 2),
            ${rate.validFrom}::date, ${rate.validTo}::date, CURRENT_TIMESTAMP)
    RETURNING "id"`;

  return created[0]!.id;
}

/**
 * `payer`: se crea si falta y NO se pisa si existe.
 *
 * El `DO UPDATE` que no cambia nada es deliberado y no un descuido: es lo que
 * hace que `RETURNING` devuelva el `id` también cuando la fila ya estaba. Con
 * `DO NOTHING` no devolvería nada y haría falta una segunda consulta.
 */
async function ensurePayer(tx: Client, payer: SeedPayer): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "payer" ("code", "name", "kind", "agreement_reference", "active", "updated_at")
    VALUES (${payer.code}, ${payer.name}, ${payer.kind}, ${payer.agreementReference}, ${bornActive(payer)}, CURRENT_TIMESTAMP)
    ON CONFLICT ("code") DO UPDATE SET "updated_at" = "payer"."updated_at"
    RETURNING "id"`;

  return rows[0]!.id;
}

/**
 * Una lista de precios por pagador, para todas las sedes (`site_id` NULL).
 *
 * `price_list` no tiene código único —la identidad de una lista es su pagador y
 * su sede— así que la idempotencia se apoya en eso y no en `ON CONFLICT`.
 */
async function ensurePriceList(
  tx: Client,
  payerId: string,
  name: string,
  publiclyListed: boolean,
): Promise<string> {
  await tx.$executeRaw`
    INSERT INTO "price_list" ("name", "payer_id", "publicly_listed", "updated_at")
    SELECT ${name}, ${payerId}::uuid, ${publiclyListed}, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (
       SELECT 1 FROM "price_list"
        WHERE "payer_id" = ${payerId}::uuid AND "site_id" IS NULL)`;

  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "price_list"
     WHERE "payer_id" = ${payerId}::uuid AND "site_id" IS NULL
     ORDER BY "created_at"
     LIMIT 1`;

  return rows[0]!.id;
}

/**
 * The service by `code`, created if missing. The `ON CONFLICT` update rewrites
 * `updated_at` with itself: a no-op that still makes `RETURNING` hand back
 * the existing id, which `DO NOTHING` would not.
 */
async function ensureService(
  tx: Client,
  service: SeedService,
  taxRateId: string,
): Promise<string | null> {
  const consultation = service.consultation;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "service"
      ("code", "name", "kind", "specialty_id", "duration_minutes", "visit_kind",
       "tax_rate_id", "updated_at")
    SELECT ${service.code}, ${service.name}, ${service.kind},
           "specialty"."id",
           ${consultation ? CONSULTATION_MINUTES[consultation.visitKind] : null}::smallint,
           ${consultation?.visitKind ?? null},
           ${taxRateId}::uuid, CURRENT_TIMESTAMP
      FROM (SELECT 1) AS "one"
      LEFT JOIN "specialty"
        ON lower("specialty"."code") = lower(${consultation?.specialtyCode ?? ''})
     WHERE ${consultation === undefined} OR "specialty"."id" IS NOT NULL
    ON CONFLICT ("code") DO UPDATE SET "updated_at" = "service"."updated_at"
    RETURNING "id"`;

  return rows[0]?.id ?? null;
}

/**
 * Un precio de arranque, y sólo si esa prestación NO tiene ya precio en esa
 * lista.
 *
 * La guarda mira la prestación entera y no la vigencia concreta a propósito: si
 * la clínica ya repreció, existe una fila más nueva y añadir la nuestra sería,
 * en el mejor caso, ruido histórico, y en el peor un choque contra
 * `price_temporal_unique`.
 */
async function ensurePrice(
  tx: Client,
  priceListId: string,
  serviceId: string,
  amount: string,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "price" ("price_list_id", "service_id", "amount", "valid_from", "updated_at")
    SELECT ${priceListId}::uuid, ${serviceId}::uuid, ${money(amount)}::decimal(12, 2),
           ${PRICE_FROM}::date, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (
       SELECT 1 FROM "price"
        WHERE "price_list_id" = ${priceListId}::uuid
          AND "service_id" = ${serviceId}::uuid)`;
}

/** The analyte by `code`, created if missing; same no-op `ON CONFLICT` as `ensureService`. */
async function ensureAnalyte(
  tx: Client,
  analyte: SeedAnalyte,
): Promise<string> {
  const allowed =
    analyte.allowedValues === null
      ? null
      : JSON.stringify(analyte.allowedValues);

  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "analyte_definition"
      ("code", "name", "loinc_code", "unit", "value_type", "decimals", "allowed_values", "updated_at")
    VALUES (${analyte.code}, ${analyte.name}, ${analyte.loincCode}, ${analyte.unit},
            ${analyte.valueType}, ${analyte.decimals}, ${allowed}::jsonb, CURRENT_TIMESTAMP)
    ON CONFLICT ("code") DO UPDATE SET "updated_at" = "analyte_definition"."updated_at"
    RETURNING "id"`;

  return rows[0]!.id;
}

/**
 * Un rango por analito, tipo y sexo. `IS NOT DISTINCT FROM` porque NULL —«todos»— es un valor.
 * Mira también las filas cerradas (ORD-113): si la clínica cerró un rango sembrado, sembrar
 * otra vez no lo reabre.
 */
async function ensureRange(
  tx: Client,
  analyteId: string,
  range: SeedRange,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "analyte_reference_range"
      ("analyte_definition_id", "sex", "range_kind", "low", "high", "text", "valid_from", "updated_at")
    SELECT ${analyteId}::uuid, ${range.sex}, ${range.kind},
           ${range.low}::decimal(14, 4), ${range.high}::decimal(14, 4), ${range.text},
           ${new Date()}, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (
       SELECT 1 FROM "analyte_reference_range"
        WHERE "analyte_definition_id" = ${analyteId}::uuid
          AND "range_kind" = ${range.kind}
          AND "sex" IS NOT DISTINCT FROM ${range.sex})`;
}

/**
 * BI-284. La extensión de orden del servicio, creada si falta; la que ya
 * existe no se toca. El código MSP se le pone sólo si no tiene uno —si la
 * clínica lo cambió, se respeta—. Sembrar no es corregir a nadie.
 */
async function ensureExam(
  tx: Client,
  exam: SeedExam,
  serviceId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "service"
       SET "msp_code" = ${exam.mspCode}, "updated_at" = CURRENT_TIMESTAMP
     WHERE "id" = ${serviceId}::uuid AND "msp_code" IS NULL`;

  await tx.$executeRaw`
    INSERT INTO "service_exam"
      ("service_id", "form_010_section", "specimen_type", "patient_preparation",
       "requires_fasting", "fasting_hours", "turnaround_hours", "updated_at")
    VALUES (${serviceId}::uuid, ${exam.form010Section}, NULLIF(${exam.specimenType}, ''),
            ${exam.patientPreparation}, ${exam.fastingHours !== null},
            ${exam.fastingHours}::smallint, ${exam.turnaroundHours}, CURRENT_TIMESTAMP)
    ON CONFLICT ("service_id") DO NOTHING`;
}

/** Links an analyte to an ordered service at its print position; an existing link is left as it is. */
async function ensureExamAnalyte(
  tx: Client,
  serviceId: string,
  analyteId: string,
  position: number,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "service_exam_analyte" ("service_id", "analyte_definition_id", "position")
    VALUES (${serviceId}::uuid, ${analyteId}::uuid, ${position})
    ON CONFLICT ("service_id", "analyte_definition_id") DO NOTHING`;
}

/**
 * Deja el arranque de facturación y de laboratorio en la base, sobre el
 * cliente que se le dé.
 *
 * EXPORTADA para que `seed.mts` la llame: sin pagador ni lista de precios, la
 * llegada de un paciente no puede decir quién paga —`patient_account` exige
 * `payer_id` y `price_list_id` NOT NULL— y la caja no tiene nada que cobrar.
 * Eso no parece «falta una siembra», parece una aplicación rota.
 */
/** BI-171. Codes the seed once had longer than the SRI's 25. */
const RENAMED_SERVICE_CODES: readonly (readonly [string, string])[] = [
  ['PROC-ESTETICA-TOXINA-BOTULINICA', 'PROC-ESTETICA-TOXINA-BOT'],
];

export async function seedBilling(prisma: PrismaClient): Promise<void> {
  // Filas GARANTIZADAS, no filas insertadas: en la segunda ejecución los
  // números son los mismos y eso es exactamente lo que se quiere poder leer.
  const counts = {
    taxRates: 0,
    payers: 0,
    priceLists: 0,
    services: 0,
    prices: 0,
    analytes: 0,
    ranges: 0,
    exams: 0,
    examAnalytes: 0,
  };

  await prisma.$transaction(
    async (tx) => {
      // 1. Impuestos. Primero, porque toda prestación apunta a uno.
      const taxRateIdByCode = new Map<string, string>();
      for (const rate of TAX_RATES) {
        taxRateIdByCode.set(rate.sriCode, await ensureTaxRate(tx, rate));
        counts.taxRates += 1;
      }

      // BI-171. Un código de antes del tope de 25 del SRI se renombra en su
      // sitio, no se duplica: la fila, sus precios y sus cargos siguen siendo
      // los mismos. Solo si el nuevo no existe todavía.
      for (const [old, renamed] of RENAMED_SERVICE_CODES) {
        await tx.$executeRaw`
          UPDATE "service" SET "code" = ${renamed}
           WHERE "code" = ${old}
             AND NOT EXISTS (SELECT 1 FROM "service" WHERE "code" = ${renamed})`;
      }

      // ADR-013. Las consultas sembradas antes se llamaban «…, primera vez» y
      // «…, subsecuente»: se renombran en su sitio a «… · Primera vez» y
      // «… · Control» (la fila, sus precios y sus cargos son los mismos). Sólo
      // si conservan el nombre de la semilla: uno que la clínica cambió es suyo.
      for (const service of SERVICES) {
        if (!service.consultation) continue;
        const former = service.name
          .replace(' · Primera vez', ', primera vez')
          .replace(' · Control', ', subsecuente');
        await tx.$executeRaw`
          UPDATE "service" SET "name" = ${service.name}, "updated_at" = CURRENT_TIMESTAMP
           WHERE "code" = ${service.code} AND "name" = ${former}`;
      }

      // 2 y 3. Pagadores y su lista de precios.
      const payerIdByCode = new Map<string, string>();
      const priceListIdByPayerCode = new Map<string, string>();
      for (const payer of PAYERS) {
        const payerId = await ensurePayer(tx, payer);
        payerIdByCode.set(payer.code, payerId);
        counts.payers += 1;

        // LOS art. 184 obliga a «exhibir en sitios visibles para el público las
        // tarifas que se cobran». La lista del paciente particular es la que
        // esa pantalla lee, así que nace marcada como pública; las de convenio
        // no lo son, porque lo pactado con un tercero no es tarifa al público.
        const isSelfPay = payer.code === SELF_PAY_CODE;
        priceListIdByPayerCode.set(
          payer.code,
          await ensurePriceList(
            tx,
            payerId,
            `Tarifario ${payer.name}`,
            isSelfPay,
          ),
        );
        counts.priceLists += 1;
      }

      // 4 y 5. Catálogo y precios de la lista particular.
      const selfPayListId = priceListIdByPayerCode.get(SELF_PAY_CODE)!;
      const serviceIdByCode = new Map<string, string>();
      for (const service of SERVICES) {
        const taxRateId = taxRateIdByCode.get(service.taxSriCode);
        if (!taxRateId) {
          throw new Error(
            `La prestación ${service.code} pide la tarifa SRI ${service.taxSriCode}, que no se sembró`,
          );
        }

        const serviceId = await ensureService(tx, service, taxRateId);
        // BI-279. Una consulta sin su especialidad en la base no se siembra.
        if (serviceId === null) continue;
        serviceIdByCode.set(service.code, serviceId);
        counts.services += 1;

        // BI-232. Sin precio de arranque, sin precio: lo fija la clínica.
        if (service.selfPayAmount !== undefined) {
          await ensurePrice(
            tx,
            selfPayListId,
            serviceId,
            service.selfPayAmount,
          );
          counts.prices += 1;
        }
      }

      // 6. Analitos, rangos, exámenes y su composición.
      const analyteIdByCode = new Map<string, string>();
      for (const analyte of ANALYTES) {
        const analyteId = await ensureAnalyte(tx, analyte);
        analyteIdByCode.set(analyte.code, analyteId);
        counts.analytes += 1;

        for (const range of analyte.ranges) {
          await ensureRange(tx, analyteId, range);
          counts.ranges += 1;
        }
      }

      for (const exam of EXAMS) {
        const serviceId = serviceIdByCode.get(exam.serviceCode);
        if (!serviceId) {
          throw new Error(
            `El examen ${exam.serviceCode} no está en el catálogo de servicios`,
          );
        }

        // ADR-013. The exam IS its service: a seed that drifted would give it
        // another name than the one written here.
        const seeded = SERVICES.find((each) => each.code === exam.serviceCode);
        if (seeded?.name !== exam.name) {
          throw new Error(
            `El examen ${exam.serviceCode} se llama «${exam.name}» y su servicio «${seeded?.name}»`,
          );
        }

        await ensureExam(tx, exam, serviceId);
        counts.exams += 1;

        let position = 1;
        for (const analyteCode of exam.analyteCodes) {
          const analyteId = analyteIdByCode.get(analyteCode);
          if (!analyteId) {
            throw new Error(
              `El examen ${exam.serviceCode} incluye el analito ${analyteCode}, que no se sembró`,
            );
          }
          await ensureExamAnalyte(tx, serviceId, analyteId, position);
          position += 1;
          counts.examAnalytes += 1;
        }
      }
    },
    // Son ~200 sentencias pequeñas; los 5 s por defecto se quedan cortos en un
    // portátil cargado y la siembra abortaría a medias.
    { timeout: 120_000, maxWait: 30_000 },
  );

  console.log(
    'Facturación y catálogo de exámenes sembrados:\n' +
      `  tax_rate                 ${counts.taxRates}   (códigos del SRI; 6 y 7 NO son 0%)\n` +
      `  payer                    ${counts.payers}   (editables desde la aplicación)\n` +
      `  price_list               ${counts.priceLists}   (la de ${SELF_PAY_CODE} es pública, LOS art. 184)\n` +
      `  service                  ${counts.services}\n` +
      `  price                    ${counts.prices}   (lista de ${SELF_PAY_CODE}, desde ${PRICE_FROM})\n` +
      `  analyte_definition       ${counts.analytes}\n` +
      `  analyte_reference_range  ${counts.ranges}\n` +
      `  service_exam             ${counts.exams}\n` +
      `  service_exam_analyte     ${counts.examAnalytes}`,
  );

  // Se dice SIEMPRE, y se dice aquí, por el mismo motivo que el seed de
  // desarrollo anuncia los permisos que no reparte: una tarifa por defecto que
  // nadie revisa se convierte en una declaración mal hecha, y para entonces ya
  // hay facturas autorizadas que no se pueden corregir (D-A-007).
  console.log(
    '  ⚠️ Las tarifas de IVA son un VALOR POR DEFECTO, no una clasificación fiscal.\n' +
      '     Salud 0% (LRTI art. 56.2) · insumos y estética 15% (art. 55 y art. 191 RLRTI).\n' +
      '     Revíselas prestación por prestación con criterio contable antes de facturar.',
  );
}

/** Entry point when run on its own; `seed.mts` calls `seedBilling` with its own client. */
async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    await seedBilling(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// Sólo cuando se invoca directamente, para que importar `seedBilling` desde
// `seed.mts` o desde una prueba no siembre la base al cargar el módulo.
if (process.argv[1]?.endsWith('seed-billing.mts')) {
  await main();
}
