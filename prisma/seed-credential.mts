import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import {
  CREDENTIAL_INVITATION_TTL_HOURS,
  credentialInvitationExpiry,
} from '../src/modules/auth/domain/credential-invitation.ts';
import { generateCredentialToken } from '../src/modules/auth/domain/credential-token.ts';
import { UNUSABLE_PASSWORD_HASH } from '../src/modules/auth/domain/password-hashing.ts';

/**
 * Development seed for the FIRST CREDENTIAL screen (AU-021, D-013).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT EXISTS WHEN MAILPIT ALREADY SHOWS THE REAL MESSAGE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Creating an account from the administration screen and opening the link in
 * Mailpit (http://localhost:8025) already covers the HAPPY path, and it is the
 * better way to try it. What cannot be reached that way is everything else:
 * `/acceso/credencial` has to say «este enlace ya no sirve» for a link that
 * expired, one that was already used and one that never existed, and there is
 * no button anywhere that produces those. A screen whose failure states nobody
 * has ever seen is a screen that has not been tried.
 *
 * So this leaves FOUR links on the table and prints them, one per state:
 *
 *   1. live — 72 hours ahead, redeemable;
 *   2. expired — issued four days ago;
 *   3. spent — already redeemed;
 *   4. superseded — the one a re-send invalidated (AU-027).
 *
 * The last three must all answer identically (AU-028); seeing that by hand is
 * the point of printing them together.
 *
 * IDEMPOTENT: the accounts are looked up by e-mail and their invitations are
 * deleted and rewritten on every run, so re-running gives fresh links instead
 * of tripping `credential_invitation_one_live_per_user`. It is the one place
 * where deleting these rows is right: they are development fixtures, not a
 * trail.
 *
 * ⚠️ IT PRINTS TOKENS IN CLEAR, which the application deliberately never does.
 * That is only acceptable because it refuses to run outside development — the
 * check below is not decoration.
 */

/** The four states a link can be in, as the screen has to render them. */
type InvitationState = 'live' | 'expired' | 'spent' | 'superseded';

const ACCOUNTS: {
  state: InvitationState;
  email: string;
  firstName: string;
  lastName: string;
  what: string;
}[] = [
  {
    state: 'live',
    email: 'invitacion.viva@clinica.ec',
    firstName: 'Ana',
    lastName: 'Villacís',
    what: 'sirve: pide contraseña y entra',
  },
  {
    state: 'expired',
    email: 'invitacion.caducada@clinica.ec',
    firstName: 'Luis',
    lastName: 'Mora',
    what: `caducado: se emitió hace 4 días y duraba ${CREDENTIAL_INVITATION_TTL_HOURS} h`,
  },
  {
    state: 'spent',
    email: 'invitacion.usada@clinica.ec',
    firstName: 'Carmen',
    lastName: 'Andrade',
    what: 'ya usado: la persona fijó su contraseña',
  },
  {
    state: 'superseded',
    email: 'invitacion.reenviada@clinica.ec',
    firstName: 'Diego',
    lastName: 'Paredes',
    what: 'anulado por un reenvío posterior (AU-027)',
  },
];

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export async function seedCredentialInvitations(
  prisma: PrismaClient,
): Promise<
  { state: InvitationState; email: string; token: string; what: string }[]
> {
  const seeded: { state: InvitationState; email: string; token: string; what: string }[] = []; // prettier-ignore

  for (const account of ACCOUNTS) {
    const user = await prisma.user.upsert({
      where: { email: account.email },
      // The account is NOT given a usable password: AU-021 forbids anybody
      // choosing somebody else's, and «pendiente de credencial» is exactly the
      // state these screens are about.
      create: {
        email: account.email,
        firstName: account.firstName,
        lastName: account.lastName,
        passwordHash: UNUSABLE_PASSWORD_HASH,
      },
      update: {},
      select: { id: true },
    });

    // Fresh links on every run. Development fixtures, not evidence.
    await prisma.credentialInvitation.deleteMany({
      where: { userId: user.id },
    });

    const now = new Date();
    const { token, hash } = generateCredentialToken();

    const issuedAt =
      account.state === 'expired' ? new Date(now.getTime() - 4 * DAY_IN_MS) : now; // prettier-ignore

    await prisma.credentialInvitation.create({
      data: {
        userId: user.id,
        tokenHash: hash,
        createdAt: issuedAt,
        expiresAt: credentialInvitationExpiry(issuedAt),
        // `used_at` is what «ya no está viva» means, for both of its reasons:
        // redeemed, and replaced by a re-send. The screen cannot tell them
        // apart, and that is AU-028.
        usedAt:
          account.state === 'spent' || account.state === 'superseded'
            ? now
            : null,
      },
    });

    // The re-sent one also gets its replacement, so the account is left in the
    // state a real re-send produces: one dead link and one live one.
    if (account.state === 'superseded') {
      const replacement = generateCredentialToken();
      await prisma.credentialInvitation.create({
        data: {
          userId: user.id,
          tokenHash: replacement.hash,
          expiresAt: credentialInvitationExpiry(now),
        },
      });
    }

    seeded.push({
      state: account.state,
      email: account.email,
      token,
      what: account.what,
    });
  }

  return seeded;
}

/** Entry point for `pnpm db:seed:credential`. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This seed is for development only.');
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  const web = process.env.WEB_BASE_URL ?? 'http://localhost:3001';

  try {
    const seeded = await seedCredentialInvitations(prisma);

    console.log('Enlaces de primera credencial (AU-021, AU-026..AU-029):\n');
    for (const item of seeded) {
      console.log(`  ${item.state.padEnd(11)} — ${item.what}`);
      console.log(`  ${web}/acceso/credencial?token=${item.token}\n`);
    }
    console.log(
      'Los tres últimos deben responder EXACTAMENTE lo mismo (AU-028).\n' +
        'Para el camino feliz de verdad: cree una cuenta desde la pantalla de\n' +
        'administración y abra el correo en http://localhost:8025 (Mailpit).',
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only when invoked directly, so anything importing the seeder does not
// connect twice.
if (process.argv[1]?.endsWith('seed-credential.mts')) {
  await main();
}
