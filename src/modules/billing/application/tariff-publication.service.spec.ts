import { describe, expect, it, vi } from 'vitest';

import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  PriceListNotFoundError,
  TariffPublicationEmptyError,
  TariffPublicationNotFoundError,
} from '../domain/billing.errors';
import { Money, Percentage } from '../domain/money';
import type { TariffCandidate, TariffLine } from '../domain/tariff-publication';
import type {
  NewTariffPublication,
  TariffPublicationView,
} from '../domain/tariff-publication.repository';
import { TariffPublicationService } from './tariff-publication.service';

// An instant from the clock, and every day derived from it.
const now = new Date();
const today = clinicalDateOf(now);

const candidate = (amount: string, overrides: Partial<TariffCandidate> = {}): TariffCandidate => ({
  billableServiceId: 'service-1',
  code: 'CON-01',
  name: 'Consulta de medicina general',
  categoryName: 'Consultas',
  active: true,
  taxPercentage: Percentage.ZERO,
  prices: [{ amount: Money.parse(amount), validFrom: addDays(today, -10), validTo: null }],
  ...overrides,
}); // prettier-ignore

const line = (amount: string): TariffLine => ({
  billableServiceId: 'service-1',
  code: 'CON-01',
  name: 'Consulta de medicina general',
  categoryName: 'Consultas',
  amount: Money.parse(amount),
  taxPercentage: Percentage.ZERO,
});

const publication = (
  overrides: Partial<TariffPublicationView> = {},
): TariffPublicationView => ({
  id: 'publication-1',
  version: 1,
  effectiveFrom: today,
  publishedAt: now,
  publishedBy: { id: 'user-1', name: 'Administración' },
  establishmentName: 'Centro de Especialidades',
  lineCount: 1,
  lines: [line('30.00')],
  ...overrides,
});

function build(candidates: TariffCandidate[] | null = [candidate('30.00')]) {
  const mocks = {
    findSelfPayTariff: vi
      .fn()
      .mockResolvedValue(
        candidates === null
          ? null
          : { priceListId: 'list-particular', candidates },
      ),
    // Like the adapter: `linesOf` runs on the candidates read under the lock.
    publish: vi.fn().mockImplementation((command: NewTariffPublication) => {
      if (candidates === null) return Promise.resolve(null);
      const lines = command.linesOf(candidates);
      return Promise.resolve(publication({ lines, lineCount: lines.length }));
    }),
    listPublications: vi.fn().mockResolvedValue([]),
    findPublication: vi.fn().mockResolvedValue(null),
    findLatestPublication: vi.fn().mockResolvedValue(null),
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const service = new TariffPublicationService(mocks, { record });
  return { service, mocks, record };
}

describe('TariffPublicationService', () => {
  it('BI-113 publica la lista particular de hoy con su fecha, su autor y la bitácora', async () => {
    const { service, mocks, record } = build();

    await service.publish({ userId: 'user-1' }, now);

    const command = mocks.publish.mock.calls[0]?.[0] as NewTariffPublication;
    expect(command.effectiveFrom).toBe(today);
    expect(command.publishedAt).toBe(now);
    expect(command.publishedById).toBe('user-1');
    const lines = command.linesOf([candidate('30.00')]);
    expect(lines.map((l) => l.amount.toString())).toEqual(['30.00']);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'tariff_publication',
        action: 'CREATE',
        resourceId: 'publication-1',
      }),
    );
  });

  it('BI-111 sin nada activo con precio vigente no publica un cartel vacío', async () => {
    const { service } = build([candidate('30.00', { active: false })]);

    await expect(
      service.publish({ userId: 'user-1' }, now),
    ).rejects.toBeInstanceOf(TariffPublicationEmptyError);
  });

  it('BI-111 sin lista particular no hay de dónde publicar', async () => {
    const { service } = build(null);
    await expect(
      service.publish({ userId: 'user-1' }, now),
    ).rejects.toBeInstanceOf(PriceListNotFoundError);
  });

  it('BI-115 la publicación al día no tiene diferencias', async () => {
    const { service, mocks } = build([candidate('30.00')]);
    mocks.findLatestPublication.mockResolvedValue(publication());

    const overview = await service.overview(now);

    expect(overview.latest).toEqual({ id: 'publication-1', version: 1, differences: [] }); // prettier-ignore
  });

  it('BI-115 un precio cambiado la deja desactualizada y no la reescribe', async () => {
    const { service, mocks } = build([candidate('35.00')]);
    mocks.findLatestPublication.mockResolvedValue(publication());

    const overview = await service.overview(now);

    expect(overview.latest?.differences.map((d) => d.kind)).toEqual(['PRICE_CHANGED']); // prettier-ignore
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('BI-113 sin publicaciones no hay última', async () => {
    const { service } = build();
    expect(await service.overview(now)).toEqual({ items: [], latest: null });
  });

  it('BI-110 la vista pública es la última; sin ninguna, TARIFF_PUBLICATION_NOT_FOUND', async () => {
    const { service, mocks } = build();
    await expect(service.onTheWall()).rejects.toBeInstanceOf(
      TariffPublicationNotFoundError,
    );

    mocks.findLatestPublication.mockResolvedValue(publication({ version: 3 }));
    expect((await service.onTheWall()).version).toBe(3);
  });

  it('BI-113 una publicación anterior se lee tal como se copió', async () => {
    const { service, mocks } = build();
    await expect(service.find('missing')).rejects.toBeInstanceOf(
      TariffPublicationNotFoundError,
    );
    mocks.findPublication.mockResolvedValue(publication({ id: 'old' }));
    expect((await service.find('old')).id).toBe('old');
  });
});
