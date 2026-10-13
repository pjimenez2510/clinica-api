import { describe, expect, it } from 'vitest';

import {
  NumberingEmissionPointNotFoundError,
  NumberingReasonRequiredError,
} from '../domain/billing.errors';
import type { NumberingRecord } from '../domain/emission-point-numbering';
import type {
  EmissionPointNumberingRepository,
  NumberingFix,
} from '../domain/emission-point-numbering.repository';

import { EmissionPointNumberingService } from './emission-point-numbering.service';

const SITE = '0199a000-0000-7000-8000-00000000000a';
const POINT = '0199a000-0000-7000-8000-000000000001';
const USER = '0199a000-0000-7000-8000-0000000000ff';

function fakeRepository() {
  const fixes: NumberingFix[] = [];
  const repository: EmissionPointNumberingRepository = {
    listForSite: () =>
      Promise.resolve(
        (['01', '04'] as const).map((documentType): NumberingRecord => ({
          emissionPointId: POINT,
          emissionPointCode: '001',
          emissionPointActive: true,
          documentType,
          usedUpTo: 4,
          nextSequential: fixes.at(-1)?.nextSequential ?? null,
          previousSystemLast: null,
          lastChange: null,
        })),
      ),
    siteOf: (id) => Promise.resolve(id === POINT ? SITE : null),
    fix: (change) => {
      fixes.push(change);
      return Promise.resolve();
    },
  };
  return { repository, fixes };
}

describe('BI-306 fijar el próximo número', () => {
  it('BI-306 guarda el motivo sin espacios sobrantes y devuelve lo que saldrá', async () => {
    const { repository, fixes } = fakeRepository();
    const service = new EmissionPointNumberingService(repository);

    const view = await service.fix(
      SITE,
      POINT,
      '01',
      { nextSequential: 100, previousSystemLast: null, reason: '  Migración ' },
      USER,
    );

    expect(fixes).toEqual([
      {
        emissionPointId: POINT,
        documentType: '01',
        nextSequential: 100,
        previousSystemLast: null,
        reason: 'Migración',
        changedById: USER,
      },
    ]);
    expect(view.nextToIssue).toBe(100);
  });

  it('BI-306 sin motivo no escribe nada', async () => {
    const { repository, fixes } = fakeRepository();
    const service = new EmissionPointNumberingService(repository);

    await expect(
      service.fix(
        SITE,
        POINT,
        '01',
        { nextSequential: 100, previousSystemLast: null, reason: ' ' },
        USER,
      ),
    ).rejects.toBeInstanceOf(NumberingReasonRequiredError);
    expect(fixes).toEqual([]);
  });

  it('BI-306 un punto de otra sede se responde como inexistente', async () => {
    const { repository, fixes } = fakeRepository();
    const service = new EmissionPointNumberingService(repository);

    await expect(
      service.fix(
        '0199a000-0000-7000-8000-00000000000b',
        POINT,
        '01',
        { nextSequential: 100, previousSystemLast: null, reason: 'Migración' },
        USER,
      ),
    ).rejects.toBeInstanceOf(NumberingEmissionPointNotFoundError);
    expect(fixes).toEqual([]);
  });
});
