import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { createTestPkcs12 } from '../test/support/test-pkcs12.ts';
import { DEV_PASSWORD } from './seed.mts';

/**
 * DEVELOPMENT ONLY. Leaves Sede Norte able to issue electronic vouchers
 * against the LOCAL DOUBLE of the SRI, so F-06 can be walked by hand —
 * among others, the 45 «secuencial registrado» and its renumbering (D-262).
 *
 *   - The establishment gets a fictitious issuer (the RUC of
 *     `test/integration/setup/sri-fixtures.ts`, never a taxpayer's) only
 *     where it has none; a clinic that typed its own keeps it.
 *   - Sede Norte gets SRI establishment code `001` only if it has none.
 *   - A throwaway certificate, made here, is uploaded through the real route
 *     when none is active: the API has to be running, with
 *     `SRI_CERTIFICATE_MASTER_KEY_FILE` pointing at a throwaway passphrase —
 *     never the author's.
 *
 * Run after `db:seed`, `db:seed:agenda` and `db:seed:organization`, with the
 * API up. Idempotent.
 */
const TEST_ISSUER_RUC = '1790001563001';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const apiUrl = process.env.API_URL ?? `http://localhost:${process.env.PORT}`;
// The author's API and database hold the real certificate (CLAUDE.md), and
// `clinica_sri` is the author's too. The NAME of the database decides, never
// a substring of the URL: the dev password itself contains «clinica_».
const databaseName = new URL(process.env.DATABASE_URL!).pathname.slice(1);
if (
  !/^clinica_[a-z0-9_]+$/.test(databaseName) ||
  databaseName === 'clinica_sri' ||
  /:3000\b/.test(apiUrl) ||
  process.env.SRI_ALLOW_REMOTE !== 'false'
) {
  throw new Error(
    'seed-sri-demo: only a branch database and API, with the local SRI double',
  );
}

try {
  const login = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@clinica.ec', password: DEV_PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const auth = { Authorization: `Bearer ${accessToken}` };

  const site = await prisma.site.findFirstOrThrow({
    where: { mspUnicode: 'DEV-NORTE' },
    select: { id: true, establishmentId: true, sriEstablishmentCode: true },
  });
  // The API must serve THIS database: a branch API pointed at main's would
  // upload the certificate into the author's base.
  const served = await fetch(`${apiUrl}/api/v1/organization/sites/${site.id}`, {
    headers: auth,
  });
  if (!served.ok) {
    throw new Error('seed-sri-demo: the API does not serve this database');
  }
  const establishment = await prisma.establishment.findUniqueOrThrow({
    where: { id: site.establishmentId },
  });
  if (!establishment.ruc) {
    await prisma.establishment.update({
      where: { id: establishment.id },
      data: {
        legalName: 'Clínica de Pruebas S.A.',
        ruc: TEST_ISSUER_RUC,
        headOfficeAddress: 'Av. Amazonas y Naciones Unidas, Quito',
        keepsAccounting: true,
        fiscalProfileDeclaredAt: new Date(),
      },
    });
  }
  if (!site.sriEstablishmentCode) {
    await prisma.site.update({
      where: { id: site.id },
      data: { sriEstablishmentCode: '001' },
    });
  }

  const certificates = (await (
    await fetch(`${apiUrl}/api/v1/sri/certificates`, { headers: auth })
  ).json()) as { active: boolean }[];
  if (!certificates.some((certificate) => certificate.active)) {
    const p12 = createTestPkcs12({
      now: new Date(),
      commonName: 'FIRMANTE DE DESARROLLO',
      ruc: TEST_ISSUER_RUC,
    });
    const upload = await fetch(`${apiUrl}/api/v1/sri/certificates`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pkcs12Base64: p12.pkcs12.toString('base64'),
        password: p12.password,
      }),
    });
    if (!upload.ok) throw new Error(`upload failed: ${upload.status}`);
  }

  console.log(
    'SRI de desarrollo: Sede Norte emite con el RUC de pruebas y un certificado desechable, contra el doble local.',
  );
} finally {
  await prisma.$disconnect();
}
