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

/**
 * D-017. The trail carries the value a mutation replaced — and only for the
 * resource types that were declared safe to carry one.
 *
 * WHY THE WHITELIST IS THE REQUIREMENT AND NOT A PRECAUTION. `access_audit` is
 * written by every module, including the one that records each read of a
 * clinical chart. A free-form «previous value» there is an open road for a
 * patient's data to land in the very table that exists to watch who looks at
 * them — a table that is append-only and never purged, so a mistake cannot be
 * undone. The `CHECK` is what makes the road closed instead of merely
 * discouraged, and these tests ask PostgreSQL to break it: the whole point of
 * D-017 is a guarantee the application cannot bypass, and an application-level
 * convention would pass every unit test while proving nothing.
 */
describe('AG-097 · CF-066 · el valor anterior en la bitácora', () => {
  const db = useDatabase();

  it('AG-097 guarda desde qué valor y hasta cuál en un recurso declarado', async () => {
    const prisma = db();

    const entry = await prisma.accessAudit.create({
      data: {
        resourceType: 'configuration',
        resourceId: 'a-site-id',
        action: 'UPDATE',
        before: { overbookingCap: 2 },
        after: { overbookingCap: 4 },
      },
    });

    expect(entry.before).toEqual({ overbookingCap: 2 });
    expect(entry.after).toEqual({ overbookingCap: 4 });
  });

  it('CF-066 RECHAZA un valor anterior en un recurso clínico', async () => {
    // Written straight through SQL on purpose: what is being asked is whether
    // the BASE refuses it, not whether our code happens not to try.
    const prisma = db();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO access_audit (resource_type, resource_id, action, "before")
         VALUES ('patient', $1, 'READ', $2::jsonb)`,
        'some-patient-id',
        JSON.stringify({ names: 'quien fuera', cedula: 'la que fuera' }),
      ),
    ).rejects.toThrow(/access_audit_payload_only_for_declared_resources/);
  });

  it('CF-066 RECHAZA también el valor nuevo en un recurso clínico', async () => {
    // Both columns, because refusing only one would leave the road open.
    const prisma = db();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO access_audit (resource_type, resource_id, action, "after")
         VALUES ('encounter', $1, 'UPDATE', $2::jsonb)`,
        'some-encounter-id',
        JSON.stringify({ diagnosis: 'lo que fuera' }),
      ),
    ).rejects.toThrow(/access_audit_payload_only_for_declared_resources/);
  });

  it('CF-066 sigue aceptando la fila de acceso a una historia, que no lleva valor', async () => {
    // The ordinary row — a read — is unaffected, which is what makes the two
    // columns free: a NULL lives in the row's bitmap and costs no space.
    const prisma = db();

    const entry = await prisma.accessAudit.create({
      data: {
        resourceType: 'patient',
        resourceId: 'some-patient-id',
        action: 'READ',
      },
    });

    expect(entry.before).toBeNull();
    expect(entry.after).toBeNull();
  });

  it('AG-097 el valor anterior tampoco se puede corregir después', async () => {
    // The immutability trigger and the whitelist are separate guarantees and
    // both have to hold: a «previous value» somebody can rewrite answers
    // «desde qué valor» with whatever the last editor preferred.
    const prisma = db();
    const entry = await prisma.accessAudit.create({
      data: {
        resourceType: 'configuration',
        resourceId: 'a-site-id',
        action: 'UPDATE',
        before: { overbookingCap: 2 },
        after: { overbookingCap: 4 },
      },
    });

    await expect(
      prisma.accessAudit.update({
        where: { id: entry.id },
        data: { before: { overbookingCap: 3 } },
      }),
    ).rejects.toThrow(/append-only/);
  });
});

/**
 * AG-073. The trail says from WHERE a chart was opened — the appointment it was
 * reached from — in the same row as the read.
 *
 * One row naming both resources, as FHIR `AuditEvent.entity` and IHE BALP do:
 * two rows related only by their timestamps come apart as soon as somebody has
 * two tabs open. And both halves or neither, which is what the base checks: a
 * context type with no identifier is an assertion nobody can follow.
 */
describe('AG-073 · el contexto del acceso en la bitácora', () => {
  const db = useDatabase();

  it('AG-073 guarda en la misma fila la cita desde la que se abrió la ficha', async () => {
    const prisma = db();

    const entry = await prisma.accessAudit.create({
      data: {
        resourceType: 'patient',
        resourceId: 'some-patient-id',
        action: 'READ',
        contextType: 'agenda_entry',
        contextId: 'some-entry-id',
      },
    });

    expect(entry.contextType).toBe('agenda_entry');
    expect(entry.contextId).toBe('some-entry-id');
  });

  it('AG-073 acepta una lectura sin contexto, que es la de siempre', async () => {
    const prisma = db();

    const entry = await prisma.accessAudit.create({
      data: { resourceType: 'patient', resourceId: 'p', action: 'READ' },
    });

    expect(entry.contextType).toBeNull();
    expect(entry.contextId).toBeNull();
  });

  it('AG-073 RECHAZA un tipo de contexto sin su identificador', async () => {
    const prisma = db();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO access_audit (resource_type, resource_id, action, context_type)
         VALUES ('patient', 'p', 'READ', 'agenda_entry')`,
      ),
    ).rejects.toThrow(/access_audit_context_both_or_neither/);
  });

  it('AG-073 RECHAZA un tipo de contexto que no está declarado', async () => {
    // `'cita'` en vez de `'agenda_entry'`: una investigación que filtra por el
    // tipo declarado no la encontraría nunca.
    const prisma = db();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO access_audit (resource_type, resource_id, action, context_type, context_id)
         VALUES ('patient', 'p', 'READ', 'cita', 'some-entry-id')`,
      ),
    ).rejects.toThrow(/access_audit_context_declared_types/);
  });

  it('AG-073 RECHAZA un identificador de contexto sin su tipo', async () => {
    const prisma = db();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO access_audit (resource_type, resource_id, action, context_id)
         VALUES ('patient', 'p', 'READ', 'some-entry-id')`,
      ),
    ).rejects.toThrow(/access_audit_context_both_or_neither/);
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
