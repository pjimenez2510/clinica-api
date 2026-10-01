import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

// The SAME parameters the application hashes with. A third copy meant that
// raising `memoryCost` — the very scenario `needsRehash` exists to support —
// left the seed producing hashes with the old ones, so the development
// password was silently rehashed on every single login.
import { PASSWORD_HASHING } from '../src/modules/auth/domain/password-hashing.ts';
// El catálogo es la fuente: construir el rol de desarrollo a partir de él
// evita una segunda lista que alguien tendría que recordar actualizar.
//
// ⚠️ `SEEDABLE_PERMISSIONS` Y NO `PERMISSIONS`. La diferencia son los permisos
// marcados `explicitGrantOnly`, que ninguna semilla reparte: ver el porqué en
// el catálogo y en `DEV_SUPERUSER_ROLE` más abajo.
import {
  EXPLICIT_GRANT_ONLY_PERMISSIONS,
  SEEDABLE_PERMISSIONS,
} from '../src/shared/authorisation/permission.catalogue.ts';
import { syncAuthorisation } from './seed-authorisation.mts';
import { seedBilling } from './seed-billing.mts';
import { seedClinicalCatalogues } from './seed-clinical-catalogues.mts';
import { seedCountries } from './seed-countries.mts';
import { seedRdacaa } from './seed-rdacaa.mts';

/**
 * Development seed.
 *
 * Idempotent on purpose: it can be run as many times as needed and always
 * leaves the same known state, including resetting lockout counters and MFA so
 * a half-finished manual test never blocks the next one.
 *
 * These credentials are for local development only. The script refuses to run
 * against a production NODE_ENV.
 */

export const DEV_PASSWORD = 'el caballo come alfalfa';

/** Strips the seed-only `role` field before writing to the user table. */
function userColumns({ role: _role, ...columns }: (typeof USERS)[number]) {
  return columns;
}

/**
 * A DEVELOPMENT-ONLY role holding every permission a seed may hand out.
 *
 * WHY IT IS NOT IN `DEFAULT_ROLES`: those ship with a fresh installation, and
 * a real clinic must never start with an account that can read every chart AND
 * administer users. That separation is the first thing an SPDP audit asks
 * about. This role exists so a developer can walk the whole application
 * without switching accounts six times, and it is created by the DEVELOPMENT
 * seed, which refuses to run against production.
 *
 * Built from `SEEDABLE_PERMISSIONS` rather than a hand-written list: a
 * permission added to the catalogue tomorrow is included automatically, and
 * there is no second list to forget.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EXCEPT LOS MARCADOS `explicitGrantOnly`, Y ÉSA ES LA CORRECCIÓN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Construir el rol a partir del catálogo ENTERO metía aquí `user:reset-mfa` —
 * el permiso al que AU-035 dedica un párrafo explicando por qué no puede
 * llegar a nadie por herencia — sin que nadie lo pidiera, y la única barrera
 * era `NODE_ENV !== 'production'`. Cualquier staging, UAT o demo sembrada con
 * `pnpm db:seed` lo concedía, y esa cuenta puede apropiarse de la identidad de
 * cualquier médico.
 *
 * Un desarrollador que necesite ejercer AU-035 en local lo concede a mano, que
 * es exactamente lo que se le pide a una clínica. El mensaje final lo dice.
 */
const DEV_SUPERUSER_ROLE = {
  code: 'DESARROLLO',
  name: 'Desarrollo (todos los permisos)',
  description:
    'Rol de pruebas con todos los permisos. NO debe existir en produccion.',
} as const;

const USERS = [
  {
    email: 'admin@clinica.ec',
    firstName: 'Pablo',
    lastName: 'Jimenez',
    cedula: '1804822136',
    acessRegistration: null,
    role: DEV_SUPERUSER_ROLE.code,
  },
  {
    email: 'medico@clinica.ec',
    firstName: 'Ana',
    lastName: 'Torres',
    cedula: '1710034065',
    acessRegistration: 'ACESS-1001',
    role: 'MEDICO',
  },
  {
    email: 'recepcion@clinica.ec',
    firstName: 'Luis',
    lastName: 'Paredes',
    cedula: '1713175071',
    acessRegistration: null,
    role: 'RECEPCION',
  },
  {
    // F-06 is walked by the cashier. Without this account the Playwright walk
    // of the flow had to borrow the development superuser, which proves only
    // that someone with every permission can see the bill.
    email: 'caja@clinica.ec',
    firstName: 'Rosa',
    lastName: 'Vera',
    cedula: '1714023577',
    acessRegistration: null,
    role: 'CAJA',
  },
  {
    // F-03 is walked by nursing. Its point is that vital signs, allergies and
    // history can be taken WITHOUT `record:write` (EN-066, EN-164), and only
    // an account holding exactly the ENFERMERIA role can prove that.
    email: 'enfermeria@clinica.ec',
    firstName: 'Carmen',
    lastName: 'Salazar',
    cedula: '1712345683',
    acessRegistration: null,
    role: 'ENFERMERIA',
  },
];

/**
 * Leaves the development database in the known state, on the client it is
 * given.
 *
 * EXPORTED, and that is what let this file finally be covered. The invariant
 * «ninguna semilla concede `user:reset-mfa`» had a test that called only
 * `syncAuthorisation` — never the seed that was actually breaking it — so the
 * thing it claimed to protect was the one path nobody ran.
 */
export async function seedDevelopment(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The development seed must never run against production');
  }

  /**
   * The catch-all development role, refreshed on every run.
   *
   * `syncAuthorisation` deliberately never overwrites an existing role — a
   * clinic that removed a permission meant it. That protection is right for
   * the shipped roles and wrong for this one: a permission added to the
   * catalogue must appear here without anybody remembering, so this seed
   * rewrites its permission set outright.
   */
  /**
   * EL CATÁLOGO PRIMERO. Sin esto el seed sólo funcionaba sobre una base que
   * alguien ya había sembrado antes: contra una recién creada por
   * `prisma migrate reset`, la tabla `permission` está vacía y el rol de
   * desarrollo revienta con una violación de clave foránea
   * (`role_permission_permission_code_fkey`).
   *
   * Es idempotente y no pisa roles existentes, así que llamarlo aquí no
   * duplica lo que hace `pnpm db:seed:auth` — sólo deja de depender de que
   * alguien lo recuerde en el orden correcto.
   */
  await syncAuthorisation(prisma);

  /**
   * LOS PAÍSES, que no son datos de prueba sino una lista de referencia.
   *
   * Va aquí y no en `db:seed:countries` a secas porque sin ellos el alta de un
   * paciente extranjero no puede decir de dónde es su pasaporte: el selector
   * aparece vacío en cada base recién creada y parece una pantalla rota. Es la
   * misma carencia que tenía el combobox de parroquia antes del 13-08-2026.
   *
   * A diferencia del DPA —1401 parroquias que se cargan aparte— son 249 filas
   * y una lectura de un CSV de 4 kB, y la release con su checksum hace que la
   * segunda ejecución no haga nada.
   */
  await seedCountries(prisma);

  /**
   * LOS TRES CATÁLOGOS DEL RDACAA, por el mismo motivo que los países.
   *
   * Etnia, nacionalidad e identidad de género son listas de referencia, no
   * datos de prueba: sin ellas los tres selectores de la ficha salen vacíos
   * —con un 200— en cada base recién creada, y REQ-022 queda incumplido
   * teniendo el código hecho. Son 48 filas de tres CSV pequeños, y la release
   * con su checksum hace que la segunda ejecución no haga nada.
   */
  await seedRdacaa(prisma);

  /**
   * EL ARRANQUE DE FACTURACIÓN Y EL CATÁLOGO DE EXÁMENES.
   *
   * Va aquí, y no sólo en un `db:seed:billing` que alguien tiene que recordar,
   * porque sin pagador y sin lista de precios el sistema no puede recibir a un
   * paciente: `patient_account` exige `payer_id` y `price_list_id` NOT NULL, y
   * quién paga se decide EN LA LLEGADA, no en la caja. Una base recién migrada
   * sin esto no tiene una pantalla vacía, tiene un flujo que no arranca.
   *
   * Es idempotente y no pisa lo que la clínica haya cambiado —sólo actualiza
   * `tax_rate`, que lo fija la norma y no ella—, así que ejecutarlo en cada
   * `pnpm db:seed` no duplica nada.
   */
  await seedBilling(prisma);
  // Después de `seedBilling`, y no antes: el tarifario se DERIVA de
  // `exam_definition`, que aquella siembra crea.
  await seedClinicalCatalogues(prisma);

  const superuser = await prisma.role.upsert({
    where: { code: DEV_SUPERUSER_ROLE.code },
    update: { name: DEV_SUPERUSER_ROLE.name, active: true },
    create: { ...DEV_SUPERUSER_ROLE, active: true },
  });

  await prisma.rolePermission.deleteMany({ where: { roleId: superuser.id } });
  await prisma.rolePermission.createMany({
    data: SEEDABLE_PERMISSIONS.map((permissionCode) => ({
      roleId: superuser.id,
      permissionCode,
    })),
  });

  // Hashed once and reused: Argon2id at these parameters costs ~100 ms per call.
  const passwordHash = await argon2.hash(DEV_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: PASSWORD_HASHING.memoryCost,
    timeCost: PASSWORD_HASHING.timeCost,
    parallelism: PASSWORD_HASHING.parallelism,
  });

  for (const user of USERS) {
    const account = await prisma.user.upsert({
      where: { email: user.email },
      update: {
        passwordHash,
        active: true,
        // Reset anything a previous manual test may have left behind.
        failedAttempts: 0,
        lockedUntil: null,
        mfaEnabledAt: null,
        mfaSecretEncrypted: null,
        // AU-037. A half-started second factor change is exactly the kind of
        // leftover this seed exists to clear, and it was missed when the
        // column arrived: the account came back «sin segundo factor» while a
        // pending secret from yesterday's manual test could still be confirmed.
        mfaPendingSecretEncrypted: null,
        mfaLastStep: null,
      },
      create: { ...userColumns(user), passwordHash },
    });

    // AU-005. The batch belongs to the secret that was just cleared. Left
    // behind, ten codes from a previous run would still open the account — the
    // same half-applied state `resetMfa` refuses to produce, arriving instead
    // through the seed that promises «el mismo estado conocido».
    await prisma.backupCode.deleteMany({ where: { userId: account.id } });
  }

  /**
   * Grants the seeded roles.
   *
   * Without this every account signs in with NOTHING — which is the correct
   * closed-by-default behaviour, and makes the app look broken in development.
   * Global scope (`siteId: null`) because there are no sites seeded yet.
   */
  for (const user of USERS) {
    const [account, role] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: user.email } }),
      prisma.role.findUnique({ where: { code: user.role } }),
    ]);
    if (!role) continue;

    const existing = await prisma.userRoleGrant.findFirst({
      where: { userId: account.id, roleId: role.id, revokedAt: null },
    });
    if (!existing) {
      await prisma.userRoleGrant.create({
        data: { userId: account.id, roleId: role.id, siteId: null },
      });
    }
  }

  // Sessions from previous runs are meaningless once passwords are reset.
  await prisma.refreshToken.deleteMany({});
}

/**
 * Entry point of `pnpm db:seed`. Prints the shared development password and
 * the permissions the superuser role deliberately lacks; `seedDevelopment`
 * itself refuses a production `NODE_ENV`.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    await seedDevelopment(prisma);
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `Seeded ${USERS.length} users. Password for all of them: ${DEV_PASSWORD}`,
  );
  console.log(
    `  admin@clinica.ec holds ${SEEDABLE_PERMISSIONS.length} permissions through the ${DEV_SUPERUSER_ROLE.code} role.`,
  );
  // Se dice SIEMPRE, y se dice aquí: un permiso que no está no se echa de
  // menos hasta que una pantalla responde 403 y el desarrollador concluye que
  // está rota. Y quien lo conceda a mano lo hace sabiendo qué entrega, que es
  // exactamente lo que AU-035 le pide a una clínica.
  console.log(
    `  Excluidos a propósito (concédalos a mano si los necesita): ${EXPLICIT_GRANT_ONLY_PERMISSIONS.join(', ')}.`,
  );
}

// Sólo cuando se invoca directamente, para que importar `seedDevelopment` desde
// una prueba no siembre la base al cargar el módulo. `seed-authorisation.mts`
// no termina en `seed.mts`, así que `pnpm db:seed:auth` no entra por aquí.
if (process.argv[1]?.endsWith('seed.mts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
