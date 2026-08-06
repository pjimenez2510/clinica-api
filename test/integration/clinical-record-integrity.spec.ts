import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * The medico-legal guarantees of the clinical record.
 *
 * Every one of these lives in PostgreSQL. That placement is the decision under
 * test: a rule enforced only in the service layer is bypassed by a migration,
 * a maintenance script, or the next module that forgets to call it.
 */
describe('clinical record integrity', () => {
  const db = useDatabase();

  describe('cedula check digit', () => {
    it('accepts a cedula whose check digit is correct', async () => {
      const prisma = db();
      const patient = await createPatient(prisma);

      const identifier = await prisma.patientIdentifier.create({
        data: { patientId: patient.id, type: 'CEDULA', value: '1710034065' },
      });

      expect(identifier.value).toBe('1710034065');
    });

    it('REFUSES a cedula with a wrong check digit', async () => {
      // Same number, last digit off by one. A length check would let this pass,
      // and it would end up on an IESS certificate that the institute rejects.
      const prisma = db();
      const patient = await createPatient(prisma);

      await expect(
        prisma.patientIdentifier.create({
          data: { patientId: patient.id, type: 'CEDULA', value: '1710034066' },
        }),
      ).rejects.toThrow(/patient_identifier_cedula_valid/);
    });

    it('does NOT apply the check digit to a foreign document', async () => {
      // A Colombian ID does not follow the Ecuadorian algorithm. Validating it
      // the same way would lock out every foreign patient.
      const prisma = db();
      const patient = await createPatient(prisma);

      const foreign = await prisma.patientIdentifier.create({
        data: {
          patientId: patient.id,
          type: 'CEDULA',
          issuingCountry: 'COL',
          value: '80123456',
        },
      });

      expect(foreign.id).toBeTruthy();
    });

    it('REFUSES two active patients holding the same cedula', async () => {
      const prisma = db();
      const first = await createPatient(prisma);
      const second = await createPatient(prisma);

      await prisma.patientIdentifier.create({
        data: { patientId: first.id, type: 'CEDULA', value: '1710034065' },
      });

      await expect(
        prisma.patientIdentifier.create({
          data: { patientId: second.id, type: 'CEDULA', value: '1710034065' },
        }),
      ).rejects.toThrow(/Unique constraint failed/);
    });
  });

  describe('vitals', () => {
    async function vitalsContext() {
      const prisma = db();
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      const patient = await createPatient(prisma);
      const encounter = await createEncounter(prisma, {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
      });
      return { prisma, encounter };
    }

    it('computes BMI in the database, not in the application', async () => {
      // 70 kg at 1.75 m = 22.86. Computed by a trigger so that the report to
      // the Ministry and the screen can never disagree.
      const { prisma, encounter } = await vitalsContext();

      const vitals = await prisma.encounterVitals.create({
        data: { encounterId: encounter.id, weightKg: 70, heightCm: 175 },
      });

      expect(Number(vitals.bmi)).toBeCloseTo(22.86, 2);
    });

    it('recomputes BMI when the weight is corrected', async () => {
      const { prisma, encounter } = await vitalsContext();
      await prisma.encounterVitals.create({
        data: { encounterId: encounter.id, weightKg: 70, heightCm: 175 },
      });

      const corrected = await prisma.encounterVitals.update({
        where: { encounterId: encounter.id },
        data: { weightKg: 80 },
      });

      expect(Number(corrected.bmi)).toBeCloseTo(26.12, 2);
    });

    it('leaves BMI null when the height is missing', async () => {
      const { prisma, encounter } = await vitalsContext();

      const vitals = await prisma.encounterVitals.create({
        data: { encounterId: encounter.id, weightKg: 70 },
      });

      expect(vitals.bmi).toBeNull();
    });

    it('REFUSES a weight typed with an extra digit', async () => {
      // 750 kg instead of 75. This is the typo the range exists to catch.
      const { prisma, encounter } = await vitalsContext();

      await expect(
        prisma.encounterVitals.create({
          data: { encounterId: encounter.id, weightKg: 750, heightCm: 175 },
        }),
      ).rejects.toThrow(/encounter_vitals_ranges/);
    });

    it('REFUSES a diastolic pressure above the systolic', async () => {
      const { prisma, encounter } = await vitalsContext();

      await expect(
        prisma.encounterVitals.create({
          data: { encounterId: encounter.id, systolicBp: 80, diastolicBp: 120 },
        }),
      ).rejects.toThrow(/encounter_vitals_ranges/);
    });
  });

  describe('a signed note is never edited', () => {
    async function signedNote() {
      const prisma = db();
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      const patient = await createPatient(prisma);
      const encounter = await createEncounter(prisma, {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
      });
      const note = await prisma.clinicalNote.create({
        data: {
          chainId: encounter.id,
          formCode: '002',
          encounterId: encounter.id,
          authorId: practitioner.id,
          content: { motivo: 'cefalea' },
          status: 'SIGNED',
          signedById: practitioner.id,
          signedAt: new Date('2026-09-14T14:30:00Z'),
          contentHash: 'a'.repeat(64),
        },
      });
      return { prisma, note, practitioner };
    }

    it('allows editing a draft', async () => {
      // Its own chain: the point is that being a DRAFT is what makes it
      // mutable, not which encounter it belongs to.
      const prisma = db();
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      const patient = await createPatient(prisma);
      const encounter = await createEncounter(prisma, {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
      });
      const draft = await prisma.clinicalNote.create({
        data: {
          chainId: encounter.id,
          formCode: '002',
          encounterId: encounter.id,
          authorId: practitioner.id,
          content: { motivo: 'borrador' },
        },
      });

      const edited = await prisma.clinicalNote.update({
        where: { id: draft.id },
        data: { content: { motivo: 'corregido' } },
      });

      expect(edited.content).toEqual({ motivo: 'corregido' });
    });

    it('REFUSES changing the content of a signed note', async () => {
      // The whole point. A doctor who wants to correct the record amends it
      // with a new version; the original stays readable, which is what a court
      // asks for.
      const { prisma, note } = await signedNote();

      await expect(
        prisma.clinicalNote.update({
          where: { id: note.id },
          data: { content: { motivo: 'otra cosa' } },
        }),
      ).rejects.toThrow(/signed clinical note|insufficient_privilege|cannot/i);
    });

    it('REFUSES deleting any note, signed or not', async () => {
      const { prisma, note } = await signedNote();

      await expect(
        prisma.clinicalNote.delete({ where: { id: note.id } }),
      ).rejects.toThrow(/never deleted/);
    });

    it('allows marking it superseded without touching the content', async () => {
      // The single permitted mutation: the amendment chain moves forward, the
      // signed content does not change.
      const { prisma, note } = await signedNote();

      const superseded = await prisma.clinicalNote.update({
        where: { id: note.id },
        data: { status: 'SUPERSEDED' },
      });

      expect(superseded.status).toBe('SUPERSEDED');
      expect(superseded.content).toEqual({ motivo: 'cefalea' });
    });

    it('REFUSES two current notes in the same chain', async () => {
      const { prisma, note } = await signedNote();

      await expect(
        prisma.clinicalNote.create({
          data: {
            chainId: note.chainId,
            version: 2,
            formCode: '002',
            encounterId: note.encounterId,
            authorId: note.authorId,
            content: { motivo: 'duplicada' },
          },
        }),
        // Prisma normalises unique-index violations to the FIELD names and
        // drops the index name. CHECK and EXCLUDE violations keep theirs,
        // which is why the other assertions here can be more specific.
      ).rejects.toThrow(
        /Unique constraint failed on the fields: \(`chain_id`\)/,
      );
    });
  });
});
