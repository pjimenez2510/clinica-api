import { composeForm117 } from '../../../shared/domain/form-117/form-117';
import {
  FORM_117_SOURCE_SELECT,
  toForm117Source,
} from '../../../shared/infrastructure/prisma/form-117-source';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { invoiceDocumentNumber } from '../../../shared/billing/document-number';
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
import { DOCUMENT_VERIFICATION_BASE_URL } from '../domain/document-source';
import type { VerificationFacts } from '../domain/document-verification';
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
  emergencyContactPhone: true,
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
    contactPhone: row.emergencyContactPhone,
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
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_VERIFICATION_BASE_URL)
    private readonly verificationBaseUrl: string,
  ) {}

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
        mspUnicode: true,
        ruc: true,
        addressLine: true,
        phone: true,
        establishmentId: true,
        establishment: {
          select: {
            legalName: true,
            tradeName: true,
            contactEmail: true,
            operatingPermit: true,
            ruc: true,
            headOfficeAddress: true,
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
     * and the establishment's IS the NAME (DOC-102): every site has one since
     * OR-032, so there is no falling back to the branch's name.
     *
     * A patient walks into a site, so the address and telephone printed on
     * their receta have to be the ones they can walk back to. The name is the
     * establishment's because that is the legal person the ACESS registered —
     * art. 5.a.iii asks for the establishment, not for the branch.
     */
    const establishment: EstablishmentIdentity = {
      name: site.establishment.legalName,
      tradeName: site.establishment.tradeName,
      email: site.establishment.contactEmail,
      operatingPermit: site.establishment.operatingPermit,
      ruc: site.ruc ?? site.establishment.ruc,
      addressLine: site.addressLine,
      headOfficeAddress: site.establishment.headOfficeAddress,
      phone: site.phone,
      logo: toStoredImage(site.establishment.logoImage),
      keepsAccounting: site.establishment.keepsAccounting,
      specialTaxpayerResolution: site.establishment.specialTaxpayerResolution,
      withholdingAgentResolution: site.establishment.withholdingAgentResolution,
      rimpeRegime: site.establishment.rimpeRegime,
    };

    /**
     * DOC-081, D-095.4. The site line only when there is more than one ACTIVE
     * site: with one, «Sede Matriz» under the clinic's name reads to a patient
     * as a second place. A deactivated site does not count — nobody walks into
     * it.
     */
    const activeSites = await this.prisma.site.count({
      where: { active: true, establishmentId: site.establishmentId },
    });

    return {
      establishment,
      siteName: site.name,
      siteLine:
        activeSites > 1 ? `${site.name} · Unicódigo ${site.mspUnicode}` : null,
      verificationBaseUrl: this.verificationBaseUrl,
    };
  }

  /** DOC-038. The first active site by name, for a template preview. */
  async firstActiveSiteId(): Promise<string | null> {
    const site = await this.prisma.site.findFirst({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true },
    });
    return site?.id ?? null;
  }

  /**
   * DOC-094. A receta, a certificate or an order by its code. Only FILED
   * states of a receta: a draft is not a document anybody can be holding. The
   * establishment's trade name, as the header printed it.
   */
  async findForVerification(code: string): Promise<VerificationFacts | null> {
    // Every code is generated in capitals; a pharmacy may type it in lowercase.
    // Matching the capitals EXACTLY is what lets the unique index answer,
    // instead of three scans per public request.
    const exact = code.toUpperCase();
    const place = {
      select: {
        name: true,
        establishment: { select: { legalName: true, tradeName: true } },
      },
    } as const;
    const signer = { select: { user: { select: { firstName: true, lastName: true } } } } as const; // prettier-ignore

    const prescription = await this.prisma.prescription.findFirst({
      where: {
        verificationCode: exact,
        status: { in: ['ACTIVE', 'COMPLETED', 'CANCELLED'] },
        issuedAt: { not: null },
      },
      select: {
        status: true,
        issuedAt: true,
        prescriber: signer,
        encounter: { select: { site: place } },
      },
    });
    if (prescription?.issuedAt != null) {
      const site = prescription.encounter.site;
      return {
        kind: 'PRESCRIPTION',
        issuedAt: prescription.issuedAt,
        annulled: prescription.status === 'CANCELLED',
        // The receta does not record WHEN it was cancelled.
        annulledAt: null,
        establishmentName: nameOf(site),
        siteName: site.name,
        practitionerName: `${prescription.prescriber.user.lastName} ${prescription.prescriber.user.firstName}`,
      };
    }

    const certificate = await this.prisma.medicalCertificate.findFirst({
      where: { verificationCode: exact },
      select: {
        issuedAt: true,
        revokedAt: true,
        issuedBy: signer,
        encounter: { select: { site: place } },
      },
    });
    if (certificate !== null) {
      const site = certificate.encounter.site;
      return {
        kind: 'MEDICAL_CERTIFICATE',
        issuedAt: certificate.issuedAt,
        annulled: certificate.revokedAt !== null,
        annulledAt: certificate.revokedAt,
        establishmentName: nameOf(site),
        siteName: site.name,
        practitionerName: `${certificate.issuedBy.user.lastName} ${certificate.issuedBy.user.firstName}`,
      };
    }

    // ORD-006, D-095. The order prints its code too, and the laboratory that
    // scans it must get an answer, not «no document has this code».
    const order = await this.prisma.serviceOrder.findFirst({
      where: { verificationCode: exact },
      select: {
        requestedAt: true,
        orderedBy: signer,
        site: place,
        items: { select: { status: true } },
      },
    });
    if (order === null) return null;
    return {
      kind: 'SERVICE_ORDER',
      issuedAt: order.requestedAt,
      // Nothing left to perform: every exam was cancelled. The order does not
      // record WHEN.
      annulled:
        order.items.length > 0 &&
        order.items.every((item) => item.status === 'CANCELLED'),
      annulledAt: null,
      establishmentName: nameOf(order.site),
      siteName: order.site.name,
      practitionerName: `${order.orderedBy.user.lastName} ${order.orderedBy.user.firstName}`,
    };
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
        sequenceNumber: true,
        warningSigns: true,
        nonPharmacologicalAdvice: true,
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
        sequenceNumber: row.sequenceNumber,
        warningSigns: row.warningSigns,
        nonPharmacologicalAdvice: row.nonPharmacologicalAdvice,
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
        verificationCode: true,
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
        items: {
          orderBy: { createdAt: 'asc' },
          select: { testCode: true, testDisplay: true, status: true },
        },
      },
    });
    if (row === null) return null;

    /**
     * DOC-072. The specimen and the patient's preparation of each exam, by its
     * FROZEN code: an exam retired since is still resolved, and one the
     * catalogue no longer has prints a dash rather than an invented specimen.
     */
    const exams = new Map(
      (
        await this.prisma.examDefinition.findMany({
          where: { code: { in: row.items.map((item) => item.testCode) } },
          select: { code: true, specimenType: true, patientPreparation: true },
        })
      ).map((exam) => [exam.code, exam]),
    );

    return {
      kind: 'SERVICE_ORDER',
      data: {
        subjectId: row.id,
        siteId: row.siteId,
        number: row.number,
        verificationCode: row.verificationCode,
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
          code: item.testCode,
          display: item.testDisplay,
          specimen: exams.get(item.testCode)?.specimenType ?? null,
          preparation: exams.get(item.testCode)?.patientPreparation ?? null,
          status: item.status,
        })),
      },
    };
  }

  // ── medical certificate ──────────────────────────────────────────────────

  /**
   * DOC-075, CER-020 to CER-037. The certificate as form 117, scoped by its
   * site. The content is `composeForm117`'s —the same function the
   * certificate's own screen reads— and this adapter only gathers its source.
   */
  private async findCertificate(
    subjectId: string,
    sites: SiteScopeFilter,
  ): Promise<DocumentSubject | null> {
    const row = await this.prisma.medicalCertificate.findFirst({
      where: {
        id: subjectId,
        ...(sites === 'all' ? {} : { siteId: { in: [...sites] } }),
      },
      select: {
        ...FORM_117_SOURCE_SELECT,
        siteId: true,
        // The identity the frame and the seal box print; the 117 itself reads
        // its own copy above.
        issuedBy: {
          select: {
            ...FORM_117_SOURCE_SELECT.issuedBy.select,
            ...PRACTITIONER_SELECT,
            user: {
              select: {
                ...FORM_117_SOURCE_SELECT.issuedBy.select.user.select,
                acessRegistration: true,
              },
            },
          },
        },
      },
    });
    if (row === null) return null;

    return {
      kind: 'MEDICAL_CERTIFICATE',
      data: {
        subjectId: row.id,
        siteId: row.siteId,
        form: composeForm117(toForm117Source(row)),
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
        paymentMethod: true,
        // DOC-076 «Información adicional»: whom the attention was for.
        account: {
          select: {
            patient: {
              select: {
                ...PATIENT_SELECT,
                mrn: true,
                phone: true,
                residenceAddressLine: true,
              },
            },
          },
        },
        subtotalTaxed: true,
        subtotalUntaxed: true,
        discountTotal: true,
        taxTotal: true,
        total: true,
        emissionPoint: {
          select: {
            code: true,
            site: { select: { sriEstablishmentCode: true } },
          },
        },
        // BI-169. THIS invoice's charges, not the account's billed ones: an
        // account invoiced twice would print the first invoice's lines on the
        // second.
        chargeItems: {
          orderBy: { createdAt: 'asc' },
          select: {
            serviceDisplay: true,
            serviceDate: true,
            quantity: true,
            unitAmount: true,
            discountAmount: true,
            taxSriCode: true,
            taxPercentage: true,
            billableService: { select: { code: true, tariffCode: true } },
          },
        },
      },
    });
    if (row === null) return null;

    // The buyer is the patient when the invoice carries the patient's own
    // official identifier: only then are their address and phone the
    // buyer's to print.
    const patient = row.account.patient;
    const buyerIsPatient =
      patient.identifiers[0]?.value === row.buyerIdentification;

    // SRI-019, SRI-070, OR-027. From the key once there is one.
    const documentNumber = invoiceDocumentNumber({
      accessKey: row.accessKey,
      establishmentCode: row.emissionPoint.site.sriEstablishmentCode,
      emissionPointCode: row.emissionPoint.code,
      sequential: row.sequential,
    });

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
        buyerAddress: buyerIsPatient ? patient.residenceAddressLine : null,
        paymentMethod: row.paymentMethod,
        patient: {
          fullName: fullNameOf(patient),
          mrn: patient.mrn,
          phone: buyerIsPatient ? patient.phone : null,
        },
        attendedOn: row.chargeItems.reduce<Date | null>(
          (first, charge) =>
            first === null || charge.serviceDate < first
              ? charge.serviceDate
              : first,
          null,
        ),
        lines: row.chargeItems.map((charge) => {
          const lineTotal = charge.unitAmount
            .mul(charge.quantity)
            .sub(charge.discountAmount);
          return {
            code: charge.billableService.code,
            auxiliaryCode: charge.billableService.tariffCode,
            taxSriCode: charge.taxSriCode,
            taxPercentage: charge.taxPercentage?.toFixed(2) ?? null,
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

/**
 * DOC-080, OR-010. The name the paper carried: trade name, else legal name.
 * Never the site's (DOC-102, OR-032).
 */
function nameOf(site: {
  establishment: { legalName: string; tradeName: string | null };
}): string {
  return site.establishment.tradeName ?? site.establishment.legalName;
}
