import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * The guarantees of `20260820052524_clinical_flow_states`, against a real
 * PostgreSQL.
 *
 * WHY THESE CANNOT BE UNIT TESTS. Every assertion here is a CHECK, an
 * exclusion constraint or a trigger. A double hands back whatever it was told
 * to hand back and proves none of them — it cannot tell you that two
 * overlapping prices are refused, because refusing them is the database's job
 * and the whole reason the rule was written in SQL rather than in a service.
 *
 * Written against raw SQL on purpose: these are statements about the SCHEMA,
 * and routing them through the Prisma client would test the client's mapping
 * as much as the constraint.
 */
const db = useDatabase();

/** The error PostgreSQL raises, whatever Prisma wraps it in. */
async function failsWith(promise: Promise<unknown>, fragment: string) {
  await expect(promise).rejects.toThrow(
    expect.objectContaining({
      message: expect.stringContaining(fragment) as unknown as string,
    }),
  );
}

async function openEncounter(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const [row] = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO encounter
       (site_id, practitioner_id, patient_id, started_at,
        "careModality", "careSetting", "visitSequence", "updated_at")
     VALUES ($1, $2, $3, now(), 'MORBIDITY', 'INTRAMURAL', 'FIRST_TIME', now())
     RETURNING id`,
    site.id,
    practitioner.id,
    patient.id,
  );
  return { site, practitioner, patient, encounterId: row!.id };
}

describe('encounter status (EN, D-A-008/D-A-010)', () => {
  it('refuses an OPEN encounter that already ended — the column and ended_at cannot disagree', async () => {
    const prisma = db();
    const { encounterId } = await openEncounter(prisma);

    await failsWith(
      prisma.$executeRawUnsafe(
        `UPDATE encounter SET ended_at = now() WHERE id = $1`,
        encounterId,
      ),
      'encounter_status_matches_ended_at',
    );
  });

  it('refuses to close an encounter without a discharge condition — an automatic closure would have to invent one (D-A-010)', async () => {
    const prisma = db();
    const { encounterId } = await openEncounter(prisma);

    await failsWith(
      prisma.$executeRawUnsafe(
        `UPDATE encounter SET status = 'DISCHARGED', ended_at = now() WHERE id = $1`,
        encounterId,
      ),
      'encounter_discharge_states_a_condition',
    );
  });

  it('closes when the discharge condition is stated', async () => {
    const prisma = db();
    const { encounterId } = await openEncounter(prisma);

    await prisma.$executeRawUnsafe(
      `UPDATE encounter
          SET status = 'DISCHARGED', ended_at = now(), "dischargeCondition" = 'ALIVE'
        WHERE id = $1`,
      encounterId,
    );

    const [row] = await prisma.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status FROM encounter WHERE id = $1`,
      encounterId,
    );
    expect(row!.status).toBe('DISCHARGED');
  });

  it('demands a reason when someone other than the author closed it (D-A-010, substitution rule)', async () => {
    const prisma = db();
    const { encounterId } = await openEncounter(prisma);
    const substitute = await createPractitioner(prisma);

    await failsWith(
      prisma.$executeRawUnsafe(
        `UPDATE encounter
            SET status = 'DISCHARGED', ended_at = now(),
                "dischargeCondition" = 'ALIVE',
                closed_by_id = $2, closed_at = now()
          WHERE id = $1`,
        encounterId,
        substitute.id,
      ),
      'encounter_substitute_closure_states_reason',
    );
  });
});

describe('the patient axis, separate from the act (D-A-008)', () => {
  it('refuses a subject status on a BLOCK — a block is not a person', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);

    await failsWith(
      prisma.$executeRawUnsafe(
        `INSERT INTO agenda_entry
           (site_id, practitioner_id, kind, status, starts_at, ends_at,
            subject_status, subject_status_at, "updated_at")
         VALUES ($1, $2, 'BLOCK', 'BLOCKED', now(), now() + interval '1 hour',
                 'ARRIVED', now(), now())`,
        site.id,
        practitioner.id,
      ),
      'agenda_entry_subject_status_needs_a_patient',
    );
  });
});

describe('the emergency call of Ley 77 art. 10 (D-A-002)', () => {
  it('refuses a flag that does not say who raised it — the record IS the point', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);

    await failsWith(
      prisma.$executeRawUnsafe(
        `INSERT INTO agenda_entry
           (site_id, practitioner_id, patient_id, kind, status, booking_channel,
            starts_at, ends_at, emergency_assessed_at, emergency_assessed_by_id,
            emergency_flagged_at, "updated_at")
         VALUES ($1, $2, $3, 'APPOINTMENT', 'CHECKED_IN', 'WALK_IN',
                 now(), now() + interval '30 minutes', now(), $4, now(), now())`,
        site.id,
        practitioner.id,
        patient.id,
        practitioner.userId,
      ),
      'agenda_entry_emergency_flag_names_who_and_when',
    );
  });
});

describe('the assessment itself, separate from its outcome (Ley 77 art. 10)', () => {
  /**
   * The defect this pair of columns fixes. Recording only the FLAG made NULL
   * mean two different things — «assessed, not an emergency» and «nobody
   * assessed» — and art. 10 obliges proving THE CALL WAS MADE, negatives
   * included. The patient nobody assessed is the one art. 13 turns into a
   * prison sentence, and a schema that cannot tell them apart cannot answer.
   */
  it('refuses a flag raised without an assessment behind it', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);

    await failsWith(
      prisma.$executeRawUnsafe(
        `INSERT INTO agenda_entry
           (site_id, practitioner_id, patient_id, kind, status, booking_channel,
            starts_at, ends_at, emergency_flagged_at, emergency_flagged_by_id,
            "updated_at")
         VALUES ($1, $2, $3, 'APPOINTMENT', 'CHECKED_IN', 'WALK_IN',
                 now(), now() + interval '30 minutes', now(), $4, now())`,
        site.id,
        practitioner.id,
        patient.id,
        practitioner.userId,
      ),
      'agenda_entry_emergency_flag_follows_assessment',
    );
  });

  it('records an assessment whose outcome was NOT an emergency — the case the old shape could not express', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);

    const [row] = await prisma.$queryRawUnsafe<
      {
        emergency_assessed_at: Date | null;
        emergency_flagged_at: Date | null;
      }[]
    >(
      `INSERT INTO agenda_entry
         (site_id, practitioner_id, patient_id, kind, status, booking_channel,
          starts_at, ends_at, emergency_assessed_at, emergency_assessed_by_id,
          "updated_at")
       VALUES ($1, $2, $3, 'APPOINTMENT', 'CHECKED_IN', 'WALK_IN',
               now(), now() + interval '30 minutes', now(), $4, now())
       RETURNING emergency_assessed_at, emergency_flagged_at`,
      site.id,
      practitioner.id,
      patient.id,
      practitioner.userId,
    );

    // Assessed, and it was not an emergency. Both facts, distinguishable.
    expect(row!.emergency_assessed_at).not.toBeNull();
    expect(row!.emergency_flagged_at).toBeNull();
  });
});
