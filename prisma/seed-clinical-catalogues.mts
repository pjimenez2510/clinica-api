import { createHash } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * CNMB y tarifario de prestaciones, EN VERSIÓN DE DESARROLLO.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LEA ESTO ANTES DE USARLO PARA ALGO QUE NO SEA PROBAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **ESTO NO ES EL CNMB.** El Cuadro Nacional de Medicamentos Básicos vigente
 * es la **11.ª revisión, con 494 principios activos**, y la **12.ª —512— se
 * aprobó el 5 de agosto de 2026** y entra al publicarse en Registro Oficial.
 * Lo que hay aquí son **treinta y tantos principios activos reales** de los más
 * usados en consulta externa, cargados para que el módulo de receta se pueda
 * ejercitar. La carga real es un trabajo de datos, no de código, y está en el
 * ROADMAP.
 *
 * ⚠️ **Y ESTO NO ES EL TARIFARIO.** Son los conceptos mínimos para que una
 * orden de examen se pueda emitir, derivados de `exam_definition`. El Tarifario
 * de Prestaciones del SNS es un PDF de 2014 sin formato estructurado, y además
 * —esto importa— **no fija lo que la clínica cobra a un paciente particular**:
 * su ámbito se redujo en 2017 al relacionamiento dentro de la red pública. Aquí
 * sirve sólo como NOMENCLATURA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE ESTE ARCHIVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque sin él los dos módulos son inoperables y alguien acaba metiendo filas
 * a mano en la base para poder probar — que fue exactamente lo que pasó. Datos
 * escritos a mano no se reproducen, no se revisan y no se borran: aparecen un
 * año después con un código inventado dentro de una receta impresa.
 *
 * La versión lleva `DEV` en el nombre a propósito, para que ninguna instalación
 * confunda esto con la lista del ministerio.
 */

/**
 * PR-104. Una presentación del cuadro: forma farmacéutica (código del
 * vocabulario de la receta) y concentración. Las de aquí son de desarrollo y
 * no las del CNMB: sirven para que la regla se vea.
 */
type Presentation = { form: string; concentration: string };
const p = (form: string, concentration: string): Presentation => ({
  form,
  concentration,
});

/** Principios activos por su Denominación Común Internacional. */
const CNMB_DEV: readonly {
  code: string;
  display: string;
  presentations: readonly Presentation[];
  /**
   * PR-070. Estupefaciente o psicotrópico: se receta en el recetario especial
   * de la ACESS y este sistema no compone esa receta. Cuáles lo son lo dirá el
   * CNMB real (D-084); aquí sólo hay uno para que la regla se vea.
   */
  controlled?: true;
}[] = [
  { code: 'PARACETAMOL', display: 'Paracetamol', presentations: [p('TABLET', '500 mg'), p('SYRUP', '120 mg/5 ml'), p('ORAL_DROPS', '100 mg/ml')] }, // prettier-ignore
  { code: 'IBUPROFENO', display: 'Ibuprofeno', presentations: [p('TABLET', '400 mg'), p('ORAL_SUSPENSION', '100 mg/5 ml')] }, // prettier-ignore
  { code: 'AMOXICILINA', display: 'Amoxicilina', presentations: [p('CAPSULE', '500 mg'), p('POWDER_FOR_ORAL_SUSPENSION', '250 mg/5 ml')] }, // prettier-ignore
  { code: 'AMOXICILINA-CLAVULANICO', display: 'Amoxicilina + ácido clavulánico', presentations: [p('TABLET', '500 mg + 125 mg'), p('POWDER_FOR_ORAL_SUSPENSION', '250 mg + 62,5 mg/5 ml')] }, // prettier-ignore
  { code: 'AZITROMICINA', display: 'Azitromicina', presentations: [p('TABLET', '500 mg'), p('POWDER_FOR_ORAL_SUSPENSION', '200 mg/5 ml')] }, // prettier-ignore
  { code: 'CEFALEXINA', display: 'Cefalexina', presentations: [p('CAPSULE', '500 mg'), p('POWDER_FOR_ORAL_SUSPENSION', '250 mg/5 ml')] }, // prettier-ignore
  { code: 'CIPROFLOXACINO', display: 'Ciprofloxacino', presentations: [p('TABLET', '500 mg')] }, // prettier-ignore
  { code: 'TRIMETOPRIMA-SULFAMETOXAZOL', display: 'Trimetoprima + sulfametoxazol', presentations: [p('TABLET', '160 mg + 800 mg'), p('ORAL_SUSPENSION', '40 mg + 200 mg/5 ml')] }, // prettier-ignore
  { code: 'METRONIDAZOL', display: 'Metronidazol', presentations: [p('TABLET', '500 mg'), p('ORAL_SUSPENSION', '250 mg/5 ml')] }, // prettier-ignore
  { code: 'NITROFURANTOINA', display: 'Nitrofurantoína', presentations: [p('CAPSULE', '100 mg')] }, // prettier-ignore
  { code: 'LORATADINA', display: 'Loratadina', presentations: [p('TABLET', '10 mg'), p('SYRUP', '5 mg/5 ml')] }, // prettier-ignore
  { code: 'CETIRIZINA', display: 'Cetirizina', presentations: [p('TABLET', '10 mg'), p('ORAL_DROPS', '10 mg/ml')] }, // prettier-ignore
  { code: 'SALBUTAMOL', display: 'Salbutamol', presentations: [p('INHALER', '100 mcg/dosis'), p('NEBULISER_SOLUTION', '5 mg/ml')] }, // prettier-ignore
  { code: 'PREDNISONA', display: 'Prednisona', presentations: [p('TABLET', '5 mg'), p('TABLET', '20 mg')] }, // prettier-ignore
  { code: 'DEXAMETASONA', display: 'Dexametasona', presentations: [p('INJECTABLE_SOLUTION', '4 mg/ml'), p('TABLET', '4 mg')] }, // prettier-ignore
  { code: 'OMEPRAZOL', display: 'Omeprazol', presentations: [p('CAPSULE', '20 mg')] }, // prettier-ignore
  { code: 'RANITIDINA', display: 'Ranitidina', presentations: [p('TABLET', '150 mg')] }, // prettier-ignore
  { code: 'METOCLOPRAMIDA', display: 'Metoclopramida', presentations: [p('TABLET', '10 mg'), p('INJECTABLE_SOLUTION', '5 mg/ml')] }, // prettier-ignore
  { code: 'SALES-REHIDRATACION', display: 'Sales de rehidratación oral', presentations: [p('GRANULES', '20,5 g')] }, // prettier-ignore
  { code: 'ALBENDAZOL', display: 'Albendazol', presentations: [p('TABLET', '400 mg'), p('ORAL_SUSPENSION', '400 mg/20 ml')] }, // prettier-ignore
  { code: 'ENALAPRIL', display: 'Enalapril', presentations: [p('TABLET', '10 mg'), p('TABLET', '20 mg')] }, // prettier-ignore
  { code: 'LOSARTAN', display: 'Losartán', presentations: [p('TABLET', '50 mg'), p('TABLET', '100 mg')] }, // prettier-ignore
  { code: 'AMLODIPINO', display: 'Amlodipino', presentations: [p('TABLET', '5 mg'), p('TABLET', '10 mg')] }, // prettier-ignore
  { code: 'HIDROCLOROTIAZIDA', display: 'Hidroclorotiazida', presentations: [p('TABLET', '25 mg')] }, // prettier-ignore
  { code: 'ATORVASTATINA', display: 'Atorvastatina', presentations: [p('TABLET', '20 mg')] }, // prettier-ignore
  { code: 'METFORMINA', display: 'Metformina', presentations: [p('TABLET', '500 mg'), p('TABLET', '850 mg')] }, // prettier-ignore
  { code: 'GLIBENCLAMIDA', display: 'Glibenclamida', presentations: [p('TABLET', '5 mg')] }, // prettier-ignore
  { code: 'INSULINA-NPH', display: 'Insulina humana NPH', presentations: [p('INJECTABLE_SOLUTION', '100 UI/ml')] }, // prettier-ignore
  { code: 'LEVOTIROXINA', display: 'Levotiroxina sódica', presentations: [p('TABLET', '50 mcg'), p('TABLET', '100 mcg')] }, // prettier-ignore
  { code: 'ACIDO-FOLICO', display: 'Ácido fólico', presentations: [p('TABLET', '1 mg')] }, // prettier-ignore
  { code: 'SULFATO-FERROSO', display: 'Sulfato ferroso', presentations: [p('TABLET', '200 mg'), p('SYRUP', '125 mg/5 ml')] }, // prettier-ignore
  { code: 'CARBONATO-CALCIO', display: 'Carbonato de calcio', presentations: [p('TABLET', '500 mg')] }, // prettier-ignore
  { code: 'ACIDO-ACETILSALICILICO', display: 'Ácido acetilsalicílico', presentations: [p('TABLET', '100 mg')] }, // prettier-ignore
  { code: 'DICLOFENACO', display: 'Diclofenaco sódico', presentations: [p('TABLET', '50 mg'), p('INJECTABLE_SOLUTION', '75 mg/3 ml')] }, // prettier-ignore
  { code: 'TRAMADOL', display: 'Tramadol', presentations: [p('CAPSULE', '50 mg'), p('INJECTABLE_SOLUTION', '50 mg/ml')] }, // prettier-ignore
  { code: 'MORFINA', display: 'Morfina', presentations: [p('INJECTABLE_SOLUTION', '10 mg/ml'), p('TABLET', '10 mg')], controlled: true }, // prettier-ignore
];

const CNMB_VERSION = 'DEV-2026-08';
const TARIFF_VERSION = 'DEV-2026-08';
const EFFECTIVE_FROM = new Date('2026-01-01T00:00:00Z');

/**
 * SHA-256 of the fixture as JSON, recorded as the release's `source_checksum`.
 * It is provenance only: whether to seed is decided by the version alone.
 */
function checksumOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Creates the `DEV` releases of the CNMB and of the tariff, the latter derived
 * from the active `exam_definition` rows (so it needs `seedBilling` first and
 * is skipped when there are none). A new release retires the concepts in force
 * instead of deleting them, because prescriptions point at them by id.
 *
 * Idempotent on (system, version): an existing release is left as it is, even
 * if the fixture above has changed since. Development data only — see above.
 */
export async function seedClinicalCatalogues(prisma: PrismaClient) {
  // ── CNMB ────────────────────────────────────────────────────────────────
  const cnmb = await prisma.catalogSystem.upsert({
    where: { code: 'CNMB' },
    update: { name: 'Cuadro Nacional de Medicamentos Básicos', hierarchical: false }, // prettier-ignore
    create: { code: 'CNMB', name: 'Cuadro Nacional de Medicamentos Básicos', hierarchical: false }, // prettier-ignore
  });

  const cnmbChecksum = checksumOf(CNMB_DEV);
  const cnmbExisting = await prisma.catalogRelease.findUnique({
    where: { systemId_version: { systemId: cnmb.id, version: CNMB_VERSION } },
  });

  let cnmbCount = 0;
  if (!cnmbExisting) {
    await prisma.$transaction(async (tx) => {
      const release = await tx.catalogRelease.create({
        data: {
          systemId: cnmb.id,
          version: CNMB_VERSION,
          publishedOn: EFFECTIVE_FROM,
          effectiveFrom: EFFECTIVE_FROM,
          sourceUrl: 'https://www.conasa.gob.ec/biblioteca/',
          sourceChecksum: cnmbChecksum,
        },
      });
      // Retirar, no borrar: hay recetas que apuntan a estas filas por su id.
      await tx.catalogConcept.updateMany({
        where: { systemId: cnmb.id, validTo: null },
        data: { validTo: EFFECTIVE_FROM, retiredByReleaseId: release.id },
      });
      const created = await tx.catalogConcept.createMany({
        data: CNMB_DEV.map((item) => ({
          systemId: cnmb.id,
          introducedByReleaseId: release.id,
          code: item.code,
          display: item.display,
          validFrom: EFFECTIVE_FROM,
          attributes: {
            presentations: item.presentations,
            source: 'DEV FIXTURE — no es el CNMB',
            ...(item.controlled ? { controlled: true } : {}),
          },
        })),
      });
      cnmbCount = created.count;
    });
  } else {
    cnmbCount = await prisma.catalogConcept.count({
      where: { systemId: cnmb.id, validTo: null },
    });
  }

  // PR-070, PR-104. Una base sembrada con esta versión antes de que existieran
  // la marca de controlado o las presentaciones no las recibiría: la versión
  // ya existe y no se vuelve a sembrar. Se garantizan aparte, en el sitio y sin
  // retirar nada — retirar dejaría sin concepto vigente a las atenciones de
  // ayer.
  for (const item of CNMB_DEV) {
    const current = await prisma.catalogConcept.findFirst({
      where: { systemId: cnmb.id, code: item.code, validTo: null },
      select: { id: true },
    });
    const attributes = {
      presentations: item.presentations,
      source: 'DEV FIXTURE — no es el CNMB',
      ...(item.controlled ? { controlled: true } : {}),
    };
    if (current) {
      await prisma.catalogConcept.update({
        where: { id: current.id },
        data: { attributes },
      });
    } else {
      await prisma.catalogConcept.create({
        data: {
          systemId: cnmb.id,
          code: item.code,
          display: item.display,
          validFrom: EFFECTIVE_FROM,
          attributes,
        },
      });
      cnmbCount += 1;
    }
  }

  // ── Tarifario, derivado de los exámenes que la clínica sabe hacer ───────
  const tariff = await prisma.catalogSystem.upsert({
    where: { code: 'TARIFF' },
    update: { name: 'Tarifario de prestaciones', hierarchical: false },
    create: { code: 'TARIFF', name: 'Tarifario de prestaciones', hierarchical: false }, // prettier-ignore
  });

  const exams = await prisma.examDefinition.findMany({
    where: { active: true },
    select: { code: true, name: true },
    orderBy: { code: 'asc' },
  });

  let tariffCount = 0;
  if (exams.length > 0) {
    const tariffChecksum = checksumOf(exams);
    const existing = await prisma.catalogRelease.findUnique({
      where: { systemId_version: { systemId: tariff.id, version: TARIFF_VERSION } }, // prettier-ignore
    });
    if (!existing) {
      await prisma.$transaction(async (tx) => {
        const release = await tx.catalogRelease.create({
          data: {
            systemId: tariff.id,
            version: TARIFF_VERSION,
            publishedOn: EFFECTIVE_FROM,
            effectiveFrom: EFFECTIVE_FROM,
            sourceUrl: 'derivado de exam_definition',
            sourceChecksum: tariffChecksum,
          },
        });
        await tx.catalogConcept.updateMany({
          where: { systemId: tariff.id, validTo: null },
          data: { validTo: EFFECTIVE_FROM, retiredByReleaseId: release.id },
        });
        const created = await tx.catalogConcept.createMany({
          data: exams.map((exam) => ({
            systemId: tariff.id,
            introducedByReleaseId: release.id,
            code: exam.code,
            display: exam.name,
            validFrom: EFFECTIVE_FROM,
            attributes: { source: 'DEV FIXTURE — derivado de exam_definition' },
          })),
        });
        tariffCount = created.count;
      });
    } else {
      // An exam added to the seed after the release was published (ORD-101's
      // imaging and procedure examples) joins it; the ones already there are
      // left as they are.
      const live = new Set(
        (
          await prisma.catalogConcept.findMany({
            where: { systemId: tariff.id, validTo: null },
            select: { code: true },
          })
        ).map((concept) => concept.code),
      );
      const missing = exams.filter((exam) => !live.has(exam.code));
      if (missing.length > 0) {
        await prisma.catalogConcept.createMany({
          data: missing.map((exam) => ({
            systemId: tariff.id,
            introducedByReleaseId: existing.id,
            code: exam.code,
            display: exam.name,
            validFrom: EFFECTIVE_FROM,
            attributes: { source: 'DEV FIXTURE — derivado de exam_definition' },
          })),
        });
      }
      tariffCount = live.size + missing.length;
    }
  }

  console.log('Catálogos clínicos de desarrollo:');
  console.log(`  CNMB    ${String(cnmbCount).padStart(4)}  ⚠️ NO es el CNMB: el vigente tiene 494 principios activos`); // prettier-ignore
  console.log(`  TARIFF  ${String(tariffCount).padStart(4)}  derivado de exam_definition, sólo como nomenclatura`); // prettier-ignore
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  await seedClinicalCatalogues(prisma);
  await prisma.$disconnect();
}
