import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';

describe('access audit is append-only', () => {
  const db = useDatabase();

  /**
   * This log is the primary evidence before the SPDP under the LOPDP. If the
   * application administrator can edit it, it proves nothing — so the
   * protection cannot live in the application that writes to it.
   *
   * `REVOKE UPDATE, DELETE` would not do: the table owner keeps its privileges,
   * and the application connects as the owner.
   */
  async function record(prisma: ReturnType<typeof db>) {
    return prisma.accessAudit.create({
      data: {
        resourceType: 'Patient',
        resourceId: 'some-patient-id',
        action: 'READ',
      },
    });
  }

  it('accepts new entries', async () => {
    const prisma = db();
    const entry = await record(prisma);
    expect(entry.id).toBeTruthy();
  });

  it('REFUSES modifying an entry', async () => {
    const prisma = db();
    const entry = await record(prisma);

    await expect(
      prisma.accessAudit.update({
        where: { id: entry.id },
        data: { action: 'NOTHING_TO_SEE_HERE' },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('REFUSES deleting an entry', async () => {
    const prisma = db();
    const entry = await record(prisma);

    await expect(
      prisma.accessAudit.delete({ where: { id: entry.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it('REFUSES emptying the table', async () => {
    // TRUNCATE does not fire row-level triggers, so it needs its own. Without
    // it, the whole log could be erased with one statement.
    const prisma = db();
    await record(prisma);

    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE access_audit'),
    ).rejects.toThrow(/append-only/);
  });
});

describe('catalog concepts are valid over a period', () => {
  const db = useDatabase();

  /**
   * A CIE-10 code changes meaning between revisions. A diagnosis recorded in
   * 2024 has to keep resolving with the 2024 catalogue, or the record says
   * something the doctor never wrote.
   *
   * PostgreSQL 18 temporal UNIQUE: the same code may exist many times, as long
   * as no two versions are valid at once.
   */
  async function system(prisma: ReturnType<typeof db>) {
    return prisma.catalogSystem.create({
      data: { code: 'CIE10', name: 'CIE-10 Ecuador' },
    });
  }

  it('allows the same code twice when the periods do not overlap', async () => {
    const prisma = db();
    const cie10 = await system(prisma);

    await prisma.catalogConcept.create({
      data: {
        systemId: cie10.id,
        code: 'J00',
        display: 'Rinofaringitis aguda',
        validFrom: new Date('2020-01-01'),
        validTo: new Date('2024-01-01'),
      },
    });

    const revised = await prisma.catalogConcept.create({
      data: {
        systemId: cie10.id,
        code: 'J00',
        display: 'Rinofaringitis aguda (resfriado común)',
        validFrom: new Date('2024-01-01'),
      },
    });

    expect(revised.id).toBeTruthy();
  });

  it('REFUSES two definitions of the same code valid at the same time', async () => {
    const prisma = db();
    const cie10 = await system(prisma);

    await prisma.catalogConcept.create({
      data: {
        systemId: cie10.id,
        code: 'J00',
        display: 'Rinofaringitis aguda',
        validFrom: new Date('2020-01-01'),
      },
    });

    await expect(
      prisma.catalogConcept.create({
        data: {
          systemId: cie10.id,
          code: 'J00',
          display: 'Otra definición del mismo código',
          validFrom: new Date('2023-01-01'),
        },
      }),
    ).rejects.toThrow(/catalog_concept_code_temporal_unique/);
  });

  it('allows the same code in a different catalogue system', async () => {
    const prisma = db();
    const cie10 = await system(prisma);
    const cnmb = await prisma.catalogSystem.create({
      data: { code: 'CNMB', name: 'Cuadro Nacional de Medicamentos Básicos' },
    });

    await prisma.catalogConcept.create({
      data: {
        systemId: cie10.id,
        code: 'J00',
        display: 'Rinofaringitis aguda',
        validFrom: new Date('2020-01-01'),
      },
    });

    const sameCodeElsewhere = await prisma.catalogConcept.create({
      data: {
        systemId: cnmb.id,
        code: 'J00',
        display: 'Un medicamento que casualmente usa este código',
        validFrom: new Date('2020-01-01'),
      },
    });

    expect(sameCodeElsewhere.id).toBeTruthy();
  });

  it('REFUSES a period that starts and ends on the same day', async () => {
    // Zero-day validity. The CHECK catches this one, because
    // `daterange(x, x, '[)')` is simply the empty range and does not raise.
    const prisma = db();
    const cie10 = await system(prisma);

    await expect(
      prisma.catalogConcept.create({
        data: {
          systemId: cie10.id,
          code: 'J01',
          display: 'Sinusitis aguda',
          validFrom: new Date('2024-01-01'),
          validTo: new Date('2024-01-01'),
        },
      }),
    ).rejects.toThrow(/catalog_concept_period_not_empty/);
  });

  it('REFUSES a period that ends before it starts', async () => {
    // KNOWN LIMITATION, asserted so it is not mistaken for a bug later.
    //
    // The `catalog_concept_period_not_empty` CHECK exists to give a readable
    // message here — and it never runs. `valid_period` is a GENERATED column,
    // computed before constraints are evaluated, and `daterange()` itself
    // raises 22000 on an inverted range. So the row IS rejected, which is what
    // matters, but with PostgreSQL's own wording rather than ours.
    //
    // It cannot be fixed by reordering: a CHECK on the same table always runs
    // after the generated column. Making the message friendly is the job of
    // the error mapping in the HTTP layer, not of this constraint.
    const prisma = db();
    const cie10 = await system(prisma);

    await expect(
      prisma.catalogConcept.create({
        data: {
          systemId: cie10.id,
          code: 'J01',
          display: 'Sinusitis aguda',
          validFrom: new Date('2024-01-01'),
          validTo: new Date('2020-01-01'),
        },
      }),
    ).rejects.toThrow(/range lower bound must be less than or equal/);
  });

  it('finds a concept ignoring accents and case', async () => {
    // The generated column plus a trigram index is what makes searching
    // "rinofaringitis" find "Rinofaringítis" — nobody types accents in a
    // consulting room with fifteen minutes per patient.
    const prisma = db();
    const cie10 = await system(prisma);
    await prisma.catalogConcept.create({
      data: {
        systemId: cie10.id,
        code: 'J00',
        display: 'Rinofaringítis Aguda',
        validFrom: new Date('2020-01-01'),
      },
    });

    const found = await prisma.$queryRaw<{ code: string }[]>`
      SELECT code FROM catalog_concept
      WHERE search_display LIKE '%rinofaringitis%'
    `;

    expect(found).toHaveLength(1);
  });
});
