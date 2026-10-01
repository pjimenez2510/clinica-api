import type { PrismaClient } from '@prisma/client';

import { composeAccessKey } from '../../../src/modules/sri/domain/access-key';
import { clinicalDateOf } from '../../../src/shared/domain/clinic-time';

/** The development RUC of `seed-organization.mts`: fictitious, never a taxpayer's. */
export const TEST_ISSUER_RUC = '1790001563001';

let sequence = 0;

/**
 * An electronic voucher for an issued invoice, written by raw SQL so the
 * database guarantees can be exercised underneath every layer.
 *
 * The key is composed with the real algorithm from the invoice's own data, so
 * it satisfies `electronic_voucher_key_matches_its_parts` for the right reason.
 * The numeric code is a counter, never `Math.random`: a failing test has to be
 * reproducible.
 */
export async function insertVoucher(
  prisma: PrismaClient,
  invoiceId: string,
  options: { status?: string; signed?: boolean } = {},
): Promise<{ id: string; accessKey: string }> {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { emissionPoint: true },
  });
  sequence += 1;
  const numericCode = String(sequence).padStart(8, '0');
  const accessKey = composeAccessKey({
    issuedOn: clinicalDateOf(invoice.issuedAt ?? invoice.createdAt),
    documentType: '01',
    ruc: TEST_ISSUER_RUC,
    environment: '1',
    establishmentCode: '001',
    emissionPointCode: invoice.emissionPoint.code,
    sequential: invoice.sequential,
    numericCode,
  });

  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "electronic_voucher"
      ("invoice_id", "site_id", "access_key", "numeric_code", "environment",
       "schema_version", "status", "unsigned_xml")
    VALUES (${invoiceId}::uuid, ${invoice.siteId}::uuid, ${accessKey},
            ${numericCode}, '1', '1.1.0', 'PREPARED', '<factura id="comprobante"/>')
    RETURNING "id"`;

  if (options.signed || (options.status && options.status !== 'PREPARED')) {
    const certificate = await anyCertificate(prisma, invoice.issuedById);
    await prisma.$executeRaw`
      UPDATE "electronic_voucher"
         SET "status" = 'SIGNED',
             "signed_xml" = '<factura id="comprobante"><ds:Signature/></factura>',
             "signing_certificate_id" = ${certificate}::uuid,
             "signed_at" = CURRENT_TIMESTAMP
       WHERE "id" = ${row!.id}::uuid`;
  }

  return { id: row!.id, accessKey };
}

/** Moves the voucher and its invoice to AUTHORISED, as the SRI's answer would. */
export async function authoriseVoucher(
  prisma: PrismaClient,
  invoiceId: string,
): Promise<string> {
  const voucher = await insertVoucher(prisma, invoiceId, { signed: true });
  await prisma.$executeRaw`
    UPDATE "electronic_voucher"
       SET "status" = 'AUTHORISED',
           "authorisation_number" = ${voucher.accessKey},
           "authorised_at" = CURRENT_TIMESTAMP,
           "authorised_xml" = '<autorizacion/>'
     WHERE "id" = ${voucher.id}::uuid`;
  await prisma.$executeRaw`
    UPDATE "invoice"
       SET "status" = 'AUTHORISED',
           "access_key" = ${voucher.accessKey},
           "authorised_at" = CURRENT_TIMESTAMP,
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "id" = ${invoiceId}::uuid`;
  return voucher.accessKey;
}

/**
 * A certificate row whose envelopes have the shape the table demands. The
 * bytes are filler: nothing here decrypts them.
 */
async function anyCertificate(
  prisma: PrismaClient,
  uploadedById: string,
): Promise<string> {
  const existing = await prisma.signingCertificate.findFirst({
    where: { active: true },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.signingCertificate.create({
    data: {
      subject: 'CN=Firmante de prueba',
      issuer: 'CN=Entidad de prueba',
      serialNumber: '01',
      notBefore: new Date(Date.UTC(2000, 0, 1)), // fecha-fija: vigencia sintética amplia
      notAfter: new Date(Date.UTC(2100, 0, 1)), // fecha-fija: vigencia sintética amplia
      encryptedPkcs12: Buffer.alloc(64, 1),
      encryptedPassword: Buffer.alloc(64, 2),
      kdfSalt: Buffer.alloc(16, 3),
      uploadedById,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * OR-027, OR-028. A site with everything a voucher needs from the issuer: its
 * SRI establishment code and an establishment with RUC, legal name and head
 * office. Fictitious, like the development seed.
 */
export async function giveSiteAnIssuer(
  prisma: PrismaClient,
  siteId: string,
  code = '001',
): Promise<void> {
  sequence += 1;
  const establishment = await prisma.establishment.create({
    data: {
      mspUnicode: `EST-SRI-${String(sequence).padStart(5, '0')}`,
      typology: 'Centro de Salud Tipo A',
      legalName: 'Clínica de Pruebas & Asociados S.A.',
      ruc: TEST_ISSUER_RUC,
      headOfficeAddress: 'Av. Amazonas y Naciones Unidas, Quito',
    },
  });
  await prisma.site.update({
    where: { id: siteId },
    data: {
      establishmentId: establishment.id,
      sriEstablishmentCode: code,
      addressLine: 'Av. de los Granados y 6 de Diciembre, Quito',
    },
  });
}
