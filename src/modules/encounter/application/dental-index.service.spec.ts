import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type {
  DentalIndexCounts,
  DentalIndexReading,
} from '../domain/dental-index';
import type {
  DentalIndexRepository,
  DentalIndexSave,
} from '../domain/dental-index.repository';
import {
  DentalIndexNotApplicableError,
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import type {
  EncounterQuery,
  EncounterRepository,
  EncounterView,
} from '../domain/encounter.repository';

import { DentalIndexService } from './dental-index.service';
import type { Requester } from './encounter.service';

/**
 * EN-052 against in-memory ports: which index the attention takes, and what
 * the service refuses before writing. The bands of age and the counts of each
 * index are also the database's (`test/integration/encounter-dental-index.spec.ts`).
 */
const SITE = 'site-1';
const requester: Requester = {
  userId: 'user-1',
  sites: [SITE],
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const anEncounter = (overrides: Partial<EncounterView> = {}): EncounterView =>
  ({
    id: 'encounter-1',
    siteId: SITE,
    status: 'OPEN',
    ageYears: 8,
    ageMonths: 3,
    ageDays: 2,
    ...overrides,
  }) as EncounterView;

class FakeDental implements DentalIndexRepository {
  specialty: string | null = 'odontologia';
  stored: DentalIndexReading | null = null;
  saved: DentalIndexCounts[] = [];

  specialtyCodeOf(): Promise<string | null> {
    return Promise.resolve(this.specialty);
  }

  find(): Promise<DentalIndexReading | null> {
    return Promise.resolve(this.stored);
  }

  save(
    _query: EncounterQuery,
    counts: DentalIndexCounts,
  ): Promise<DentalIndexSave> {
    this.saved.push(counts);
    const before = this.stored;
    const same =
      before !== null &&
      before.decayed === counts.decayed &&
      before.extracted === counts.extracted &&
      before.filled === counts.filled &&
      before.missing === counts.missing;
    if (!same) {
      this.stored = { ...counts, recordedAt: new Date(), editedAt: null };
    }
    return Promise.resolve({
      reading: this.stored!,
      outcome: before === null ? 'CREATED' : same ? 'UNCHANGED' : 'UPDATED',
    });
  }
}

describe('EN-052 el índice CEO-D / CPO-D de la atención', () => {
  let encounter: EncounterView | null;
  let dental: FakeDental;
  let audit: AccessAuditEntry[];
  let service: DentalIndexService;

  beforeEach(() => {
    encounter = anEncounter();
    dental = new FakeDental();
    audit = [];
    const encounters = {
      findById: () => Promise.resolve(encounter),
    } as unknown as EncounterRepository;
    const recorder: AccessAuditRecorder = {
      record: (entry) => {
        audit.push(entry);
        return Promise.resolve();
      },
    };
    service = new DentalIndexService(encounters, dental, recorder);
  });

  it('EN-052 dice qué índice toca: CEO-D a los 8 años y CPO-D a los 30, en odontología', async () => {
    await expect(service.dentalIndexOf('encounter-1', requester)).resolves.toEqual({ index: 'CEO_D', reading: null }); // prettier-ignore
    encounter = anEncounter({ ageYears: 30 });
    await expect(service.dentalIndexOf('encounter-1', requester)).resolves.toMatchObject({ index: 'CPO_D' }); // prettier-ignore
    // Nothing recorded, nothing disclosed: no trail.
    expect(audit).toEqual([]);

    dental.stored = { decayed: 1, extracted: null, filled: 2, missing: 0, recordedAt: new Date(), editedAt: null }; // prettier-ignore
    await service.dentalIndexOf('encounter-1', requester);
    expect(audit.map((entry) => [entry.resourceType, entry.action])).toEqual([
      ['encounter_dental_index', 'READ'],
    ]);
  });

  it('EN-052 D-160 fuera de odontología no toca ninguno, y guardarlo responde DENTAL_INDEX_NOT_APPLICABLE sin escribir', async () => {
    dental.specialty = 'medicina_general';

    await expect(service.dentalIndexOf('encounter-1', requester)).resolves.toEqual({ index: null, reading: null }); // prettier-ignore
    await expect(
      service.recordDentalIndex('encounter-1', { index: 'CEO_D', decayed: 2, extracted: 1, filled: 0 }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(DentalIndexNotApplicableError);
    expect(dental.saved).toEqual([]);

    // Positive control: the same body in odontology is recorded.
    dental.specialty = 'odontologia';
    await service.recordDentalIndex('encounter-1', { index: 'CEO_D', decayed: 2, extracted: 1, filled: 0 }, requester); // prettier-ignore
    expect(dental.saved).toEqual([{ decayed: 2, extracted: 1, filled: 0, missing: null }]); // prettier-ignore
  });

  it('EN-052 D-160 a los 11 años no toca ninguno, y el índice que no es el de la edad se rechaza', async () => {
    encounter = anEncounter({ ageYears: 11 });
    await expect(service.dentalIndexOf('encounter-1', requester)).resolves.toMatchObject({ index: null }); // prettier-ignore
    await expect(
      service.recordDentalIndex('encounter-1', { index: 'CPO_D', decayed: 1, missing: 0, filled: 1 }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(DentalIndexNotApplicableError);

    encounter = anEncounter({ ageYears: 8 });
    await expect(
      service.recordDentalIndex('encounter-1', { index: 'CPO_D', decayed: 1, missing: 0, filled: 1 }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(DentalIndexNotApplicableError);
    // The count of the other index: missing teeth in a CEO-D, extracted in a CPO-D.
    await expect(
      service.recordDentalIndex('encounter-1', { index: 'CEO_D', decayed: 1, extracted: 0, missing: 1, filled: 1 }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(DentalIndexNotApplicableError);
    encounter = anEncounter({ ageYears: 14 });
    await expect(
      service.recordDentalIndex('encounter-1', { index: 'CPO_D', decayed: 1, extracted: 1, missing: 0, filled: 1 }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(DentalIndexNotApplicableError);
    expect(dental.saved).toEqual([]);
  });

  it('EN-052 guarda el CPO-D sin extraídos y deja bitácora de la escritura y de la corrección', async () => {
    encounter = anEncounter({ ageYears: 40 });

    const first = await service.recordDentalIndex('encounter-1', { index: 'CPO_D', decayed: 3, missing: 2, filled: 5 }, requester); // prettier-ignore
    expect(first).toMatchObject({ index: 'CPO_D', reading: { decayed: 3, extracted: null, missing: 2, filled: 5 } }); // prettier-ignore
    await service.recordDentalIndex('encounter-1', { index: 'CPO_D', decayed: 2, missing: 2, filled: 6 }, requester); // prettier-ignore
    // The same counts again: no write to account for.
    await service.recordDentalIndex('encounter-1', { index: 'CPO_D', decayed: 2, missing: 2, filled: 6 }, requester); // prettier-ignore
    expect(audit.map((entry) => entry.action)).toEqual(['CREATE', 'UPDATE']);
  });

  it('EN-052 sólo con la atención admitiendo contenido, y una atención fuera de alcance no existe', async () => {
    encounter = anEncounter({ status: 'DISCHARGED' });
    await expect(
      service.recordDentalIndex('encounter-1', { index: 'CEO_D', decayed: 0, extracted: 0, filled: 0 }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(EncounterAlreadyClosedError);

    encounter = null;
    await expect(service.dentalIndexOf('encounter-1', requester)).rejects.toBeInstanceOf(EncounterNotFoundError); // prettier-ignore
    expect(dental.saved).toEqual([]);
    expect(audit).toEqual([]);
  });
});
