import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  chartScopeRows,
  chartScopeSelect,
} from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { SiteScopeFilter } from '../domain/document-kind';
import type {
  AllowedImageMimeType,
  StoredImage,
} from '../domain/document-image';
import type {
  DocumentContext,
  DocumentSourceReader,
  DocumentSubject,
  EstablishmentIdentity,
  PatientIdentity,
  PractitionerIdentity,
  SubjectQuery,
} from '../domain/document-source';

/**
 * The rows behind the four documents, read WITHOUT importing a single other
 * module.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Printing a receta means reading the chart, the attention, the diagnoses, the
 * allergies, the practitioner, the site and the establishment. None of that is
 * obtained by importing `prescription`, `encounter`, `patients`, `staff` or
 * `organization` — no module imports another (CLAUDE.md §3), and
 * `pnpm arch:check` fails on it. Each fact this module needs is DECLARED in
 * `document-source.ts` and answered here, which is the route `agenda` took for
 * AG-027 and `prescription` took for the chart.
 *
 * READING ANOTHER MODULE'S TABLES IS NOT IMPORTING ITS MODULE. The boundary
 * that matters is the one that would let a change in `prescription`'s service
 * break this one; a `SELECT` against a table whose shape is a migration away
 * from both of us is a coupling to the SCHEMA, which is shared by design.
 *
 * ⚠️ EVERY QUERY CARRIES THE SITE SCOPE (DOC-012), and it is applied in the
 * `where` rather than checked afterwards: a filter applied after the read is a
 * filter somebody removes while «optimising», and the row has already left the
 * database.
 */

/** An image WITH its bytes: the renderer embeds them. */
const IMAGE_SELECT = {
  id: true,
  mimeType: true,
  bytes: true,
  byteSize: true,
  sha256: true,
  width: true,
  height: true,
} satisfies Prisma.DocumentImageSelect;

/** The shape `IMAGE_SELECT` produces. */
type ImageRow = Prisma.DocumentImageGetPayload<{ select: typeof IMAGE_SELECT }>;

/**
 * An optional relation to an image, or `null`: a missing logo, seal or
 * signature is legitimate (DOC-059, DOC-060).
 */
function toStoredImage(row: ImageRow | null | undefined): StoredImage | null {
  if (row == null) return null;
  return {
    id: row.id,
    mimeType: row.mimeType as AllowedImageMimeType,
    bytes: Buffer.from(row.bytes),
    byteSize: row.byteSize,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
  };
}

/**
 * Art. 5.b.i, «Apellidos y nombres completos». IN THAT ORDER, and the order is
 * the requirement: an Ecuadorian document lists surnames first, and a document
 * that reverses them is one a pharmacist matches against the wrong person.
 */
function fullNameOf(patient: {
  familyName: string;
  secondFamilyName: string | null;
  givenName: string;
  secondGivenName: string | null;
}): string {
  return [
    patient.familyName,
    patient.secondFamilyName,
    patient.givenName,
    patient.secondGivenName,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');
}

/**
 * The patient as the documents print them: the name parts and at most one
 * OFFICIAL identifier.
 */
const PATIENT_SELECT = {
  familyName: true,
  secondFamilyName: true,
  givenName: true,
  secondGivenName: true,
  identifiers: {
    where: { use: 'OFFICIAL' as const, patientMerged: false },
    select: { value: true, type: true },
    take: 1,
  },
} satisfies Prisma.PatientSelect;

/**
 * Art. 5.d. The prescriber's name, ACESS registration and MSP code, with the
 * seal and signature images.
 */
const PRACTITIONER_SELECT = {
  mspCode: true,
  user: {
    select: { firstName: true, lastName: true, acessRegistration: true },
  },
  sealImage: { select: IMAGE_SELECT },
  signatureImage: { select: IMAGE_SELECT },
} satisfies Prisma.PractitionerSelect;

/** The shape `PRACTITIONER_SELECT` produces. */
type PractitionerRow = Prisma.PractitionerGetPayload<{
  select: typeof PRACTITIONER_SELECT;
}>;

/**
 * Row to identity. A missing seal or signature stays `null`; nothing is drawn
 * in its place (DOC-060).
 */
function toPractitioner(row: PractitionerRow): PractitionerIdentity {
  return {
    // Art. 5.d.i. Surnames first, like the patient's.
    fullName: `${row.user.lastName} ${row.user.firstName}`,
    acessRegistration: row.user.acessRegistration,
    mspCode: row.mspCode,
    seal: toStoredImage(row.sealImage),
    signature: toStoredImage(row.signatureImage),
  };
}

/** The shape `PATIENT_SELECT` produces. */
type PatientRow = Prisma.PatientGetPayload<{ select: typeof PATIENT_SELECT }>;

/**
 * Row to identity. The identifier is `null` when the chart has no official one.
 */
function toPatient(
  row: PatientRow,
  ageYears: number | null,
  ageMonths: number | null,
): PatientIdentity {
  return {
    fullName: fullNameOf(row),
    identifier: row.identifiers[0]?.value ?? null,
    // Art. 5.b.ii. THE FROZEN AGE OF THE ATTENTION, never derived from the
    // birth date today: correcting a mistyped birth date would otherwise
    // silently rewrite documents already handed to a pharmacy.
    ageYears,
    ageMonths,
  };
}

/**
 * Art. 5.b.iv. Only what the receta prints, plus the flag that decides whether
 * it prints at all.
 */
const ALLERGY_SELECT = {
  select: { substanceText: true, refutedAt: true },
} satisfies Prisma.Patient$allergiesArgs;

/**
 * The shape `ALLERGY_SELECT` produces.
 *
 * Written out because `chartScopeRows` infers its element type from the ROW,
 * and a row selected with several `chartScopeSelect` relations has no single
 * one to infer.
 */
interface StoredAllergy {
  substanceText: string;
  refutedAt: Date | null;
}

/**
 * The CIE10 code and display of each diagnosis of the attention, and its rank
 * for ordering.
 */
const DIAGNOSIS_SELECT = {
  cie10Code: true,
  cie10Display: true,
  rank: true,
} satisfies Prisma.EncounterDiagnosisSelect;

/**
 * The `DocumentSourceReader` adapter: one read method per document kind, each
 * scoped by site in its `where`.
 */
@Injectable()
export class PrismaDocumentSourceReader implements DocumentSourceReader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Dispatches on the kind; the `switch` is exhaustive over `DocumentKind`, so
   * a fifth document does not compile until it is handled here.
   */
  async findSubject(query: SubjectQuery): Promise<DocumentSubject | null> {
    switch (query.kind) {
      case 'PRESCRIPTION':
        return this.findPrescription(query.subjectId, query.sites);
      case 'SERVICE_ORDER':
        return this.findServiceOrder(query.subjectId, query.sites);
      case 'MEDICAL_CERTIFICATE':
        return this.findCertificate(query.subjectId, query.sites);
      case 'INVOICE_RIDE':
        return this.findInvoice(query.subjectId, query.sites);
    }
  }

  /**
   * The establishment identity printed on every document of a site, including
   * the RIDE's fiscal flags (DOC-077). `null` for an unknown site.
   */
  async contextForSite(siteId: string): Promise<DocumentContext | null> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        name: true,
        ruc: true,
        addressLine: true,
        phone: true,
        establishment: {
          select: {
            legalName: true,
            ruc: true,
            keepsAccounting: true,
            specialTaxpayerResolution: true,
            withholdingAgentResolution: true,
            rimpeRegime: true,
            logoImage: { select: IMAGE_SELECT },
          },
        },
      },
    });
    if (site === null) return null;

    /**
     * THE SITE'S OWN DATA WINS OVER THE ESTABLISHMENT'S for address and phone,
     * and the establishment's wins for the NAME.
     *
     * A patient walks into a site, so the address and telephone printed on
     * their receta have to be the ones they can walk back to. The name is the
     * establishment's because that is the legal person the ACESS registered —
     * art. 5.a.iii asks for the establishment, not for the branch.
     */
    const establishment: EstablishmentIdentity = {
      name: site.establishment?.legalName ?? site.name,
      ruc: site.ruc ?? site.establishment?.ruc ?? null,
      addressLine: site.addressLine,
      phone: site.phone,
      logo: toStoredImage(site.establishment?.logoImage),
      keepsAccounting: site.establishment?.keepsAccounting ?? false,
      specialTaxpayerResolution:
        site.establishment?.specialTaxpayerResolution ?? null,
      withholdingAgentResolution:
        site.establishment?.withholdingAgentResolution ?? null,
      rimpeRegime: site.establishment?.rimpeRegime ?? 'NONE',
    };

    return { establishment, siteName: site.name };
  }

  // ── prescription ─────────────────────────────────────────────────────────

  /**
   * DOC-072. Everything the receta prints, in one query, scoped by the
   * attention's site.
   */
  private async findPrescription(
    subjectId: string,
    sites: SiteScopeFilter,
  ): Promise<DocumentSubject | null> {
    const row = await this.prisma.prescription.findFirst({
      where: {
        id: subjectId,
        encounter: sites === 'all' ? {} : { siteId: { in: [...sites] } },
      },
      select: {
        id: true,
        status: true,
        issuedAt: true,
        verificationCode: true,
        encounter: {
          select: {
            siteId: true,
            ageYears: true,
            ageMonths: true,
            patient: {
              select: {
                ...PATIENT_SELECT,
                /**
                 * Art. 5.b.iv — «Antecedentes de alergias».
                 *
                 * ⚠️ `chartScopeSelect` AND NOT A PLAIN `allergies`. A merged
                 * chart keeps its own rows: an allergy recorded before the
                 * merge lives on the ABSORBED chart, and reading only the
                 * survivor's would print «Ninguna conocida» on a receta for a
                 * patient whose penicillin allergy the clinic has on file. It
                 * travels as one statement — `relationJoins` is on — so it
                 * costs nothing over getting it wrong.
                 */
                ...chartScopeSelect('allergies', ALLERGY_SELECT),
              },
            },
            diagnoses: {
              select: DIAGNOSIS_SELECT,
              orderBy: { rank: 'asc' },
            },
            site: { select: { parish: { select: { display: true, parentId: true } } } }, // prettier-ignore
          },
        },
        prescriber: { select: PRACTITIONER_SELECT },
        items: {
          select: {
            genericName: true,
            presentation: true,
            concentration: true,
            routeCode: true,
            quantity: true,
            doseText: true,
            frequencyText: true,
            durationDays: true,
            instructions: true,
            offFormularyJustification: true,
          },
        },
      },
    });
    if (row === null) return null;

    return {
      kind: 'PRESCRIPTION',
      data: {
        subjectId: row.id,
        siteId: row.encounter.siteId,
        status: row.status,
        issuedAt: row.issuedAt,
        // Art. 5.a.ii asks for the CITY. The DPA parish is what the site
        // carries, and its canton is the parish's parent; resolving the parent
        // costs a query, so the parish display is printed when the canton is
        // not loaded. `null` when the site has no parish at all — a gap
        // somebody sees rather than a city somebody invented.
        city: await this.cantonOf(row.encounter.site.parish),
        verificationCode: row.verificationCode,
        patient: toPatient(
          row.encounter.patient,
          row.encounter.ageYears,
          row.encounter.ageMonths,
        ),
        diagnoses: row.encounter.diagnoses.map((diagnosis) => ({
          code: diagnosis.cie10Code,
          display: diagnosis.cie10Display,
        })),
        // Refuted ones are filtered HERE and not in the `where`, because
        // `chartScopeSelect` applies one selection to both halves of the chart:
        // knowing an allergy was ruled out is clinical information, and it is
        // simply not something the receta prints.
        allergies: chartScopeRows<'allergies', StoredAllergy>(
          row.encounter.patient,
          'allergies',
        )
          .filter((allergy) => allergy.refutedAt === null)
          .map((allergy) => allergy.substanceText),
        prescriber: toPractitioner(row.prescriber),
        lines: row.items.map((item) => ({
          genericName: item.genericName,
          presentation: item.presentation,
          concentration: item.concentration,
          routeCode: item.routeCode,
          quantity: item.quantity === null ? null : Number(item.quantity),
          doseText: item.doseText,
          frequencyText: item.frequencyText,
          durationDays: item.durationDays,
          instructions: item.instructions,
          offFormularyJustification: item.offFormularyJustification,
        })),
      },
    };
  }

  /** Art. 5.a.ii. The canton of the site's DPA parish, or the parish itself. */
  private async cantonOf(
    parish: { display: string; parentId: string | null } | null,
  ): Promise<string | null> {
    if (parish === null) return null;
    if (parish.parentId === null) return parish.display;
    const canton = await this.prisma.catalogConcept.findUnique({
      where: { id: parish.parentId },
      select: { display: true },
    });
    return canton?.display ?? parish.display;
  }

  // ── service order ────────────────────────────────────────────────────────

  /**
   * The order, its patient, its diagnoses and its lines, scoped by the order's
   * own site.
   */
  private async findServiceOrder(
    subjectId: string,
    sites: SiteScopeFilter,
  ): Promise<DocumentSubject | null> {
    const row = await this.prisma.serviceOrder.findFirst({
      where: {
        id: subjectId,
        ...(sites === 'all' ? {} : { siteId: { in: [...sites] } }),
      },
      select: {
        id: true,
        siteId: true,
        number: true,
        requestedAt: true,
        category: true,
        priority: true,
        clinicalNoteText: true,
        encounter: {
          select: {
            ageYears: true,
            ageMonths: true,
            patient: { select: PATIENT_SELECT },
            diagnoses: { select: DIAGNOSIS_SELECT, orderBy: { rank: 'asc' } },
          },
        },
        orderedBy: { select: PRACTITIONER_SELECT },
        items: { select: { testDisplay: true, status: true } },
      },
    });
    if (row === null) return null;

    return {
      kind: 'SERVICE_ORDER',
      data: {
        subjectId: row.id,
        siteId: row.siteId,
        number: row.number,
        requestedAt: row.requestedAt,
        category: row.category,
        priority: row.priority,
        clinicalNoteText: row.clinicalNoteText,
        patient: toPatient(
          row.encounter.patient,
          row.encounter.ageYears,
          row.encounter.ageMonths,
        ),
        diagnoses: row.encounter.diagnoses.map((diagnosis) => ({
          code: diagnosis.cie10Code,
          display: diagnosis.cie10Display,
        })),
        orderedBy: toPractitioner(row.orderedBy),
        items: row.items.map((item) => ({
          display: item.testDisplay,
          status: item.status,
        })),
      },
    };
  }

  // ── medical certificate ──────────────────────────────────────────────────

  /** The certificate, scoped by the attention's site. */
  private async findCertificate(
    subjectId: string,
    sites: SiteScopeFilter,
  ): Promise<DocumentSubject | null> {
    const row = await this.prisma.medicalCertificate.findFirst({
      where: {
        id: subjectId,
        encounter: sites === 'all' ? {} : { siteId: { in: [...sites] } },
      },
      select: {
        id: true,
        type: true,
        issuedAt: true,
        restFrom: true,
        restTo: true,
        includeDiagnosis: true,
        body: true,
        verificationCode: true,
        revokedAt: true,
        patient: { select: PATIENT_SELECT },
        encounter: {
          select: {
            siteId: true,
            ageYears: true,
            ageMonths: true,
            diagnoses: { select: DIAGNOSIS_SELECT, orderBy: { rank: 'asc' } },
          },
        },
        issuedBy: { select: PRACTITIONER_SELECT },
      },
    });
    if (row === null) return null;

    return {
      kind: 'MEDICAL_CERTIFICATE',
      data: {
        subjectId: row.id,
        siteId: row.encounter.siteId,
        type: row.type,
        issuedAt: row.issuedAt,
        restFrom: row.restFrom,
        restTo: row.restTo,
        includeDiagnosis: row.includeDiagnosis,
        diagnoses: row.encounter.diagnoses.map((diagnosis) => ({
          code: diagnosis.cie10Code,
          display: diagnosis.cie10Display,
        })),
        body: row.body,
        verificationCode: row.verificationCode,
        revokedAt: row.revokedAt,
        patient: toPatient(
          row.patient,
          row.encounter.ageYears,
          row.encounter.ageMonths,
        ),
        issuedBy: toPractitioner(row.issuedBy),
      },
    };
  }

  // ── invoice (RIDE) ───────────────────────────────────────────────────────

  /**
   * DOC-076. The RIDE's data, scoped by the invoice's site. The lines are the
   * account's `BILLED` charges with their frozen values; the totals are the
   * invoice's stored ones, as strings.
   */
  private async findInvoice(
    subjectId: string,
    sites: SiteScopeFilter,
  ): Promise<DocumentSubject | null> {
    const row = await this.prisma.invoice.findFirst({
      where: {
        id: subjectId,
        ...(sites === 'all' ? {} : { siteId: { in: [...sites] } }),
      },
      select: {
        id: true,
        siteId: true,
        sequential: true,
        accessKey: true,
        status: true,
        issuedAt: true,
        authorisedAt: true,
        buyerIdentificationType: true,
        buyerIdentification: true,
        buyerName: true,
        buyerEmail: true,
        subtotalTaxed: true,
        subtotalUntaxed: true,
        discountTotal: true,
        taxTotal: true,
        total: true,
        emissionPoint: {
          select: { code: true, site: { select: { mspUnicode: true } } },
        },
        account: {
          select: {
            chargeItems: {
              where: { status: 'BILLED' },
              select: {
                serviceDisplay: true,
                quantity: true,
                unitAmount: true,
                discountAmount: true,
                billableService: { select: { code: true } },
              },
            },
          },
        },
      },
    });
    if (row === null) return null;

    /**
     * `001-001-000000001`. The first block is the ESTABLISHMENT code the SRI
     * assigned, and this system does not hold it: `msp_unicode` is the MSP's
     * code, which is a different register.
     *
     * > **Falta esquema.** There is no `sri_establishment_code` column on
     * > `site`. `001` is printed while there is none, and it is the only
     * > invented value in this whole module — stated here so it is found rather
     * > than trusted. It is a datum of the installation, like the fiscal flags,
     * > and it belongs beside them.
     */
    const documentNumber = `001-${row.emissionPoint.code}-${row.sequential}`;

    const money = (value: Prisma.Decimal): string => value.toFixed(2);

    return {
      kind: 'INVOICE_RIDE',
      data: {
        subjectId: row.id,
        siteId: row.siteId,
        documentNumber,
        accessKey: row.accessKey,
        status: row.status,
        issuedAt: row.issuedAt,
        authorisedAt: row.authorisedAt,
        buyerIdentificationType: row.buyerIdentificationType,
        buyerIdentification: row.buyerIdentification,
        buyerName: row.buyerName,
        buyerEmail: row.buyerEmail,
        lines: row.account.chargeItems.map((charge) => {
          const lineTotal = charge.unitAmount
            .mul(charge.quantity)
            .sub(charge.discountAmount);
          return {
            code: charge.billableService.code,
            // The FROZEN display, not the current catalogue name: the invoice
            // has to keep saying what was sold.
            description: charge.serviceDisplay,
            quantity: charge.quantity.toFixed(2),
            unitPrice: money(charge.unitAmount),
            discount: money(charge.discountAmount),
            total: money(lineTotal),
          };
        }),
        subtotalTaxed: money(row.subtotalTaxed),
        subtotalUntaxed: money(row.subtotalUntaxed),
        discountTotal: money(row.discountTotal),
        taxTotal: money(row.taxTotal),
        total: money(row.total),
      },
    };
  }
}
