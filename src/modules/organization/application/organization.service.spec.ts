import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import { InvalidRucError } from '../../../shared/domain/value-objects/ruc.vo';
import {
  EstablishmentNotFoundError,
  SiteNotFoundError,
} from '../domain/organization.errors';
import type {
  EstablishmentInput,
  EstablishmentView,
  OrganizationRepository,
  SiteInput,
  SitePatch,
  SiteScopeFilter,
  SiteView,
} from '../domain/organization.repository';
import { OrganizationService, type Requester } from './organization.service';

/**
 * The rules that are the SERVICE's to enforce, against doubles of its port:
 * the RUC being a RUC (OR-008), the establishment being create-or-update
 * (OR-001), the site link (OR-004) and an audit entry on every mutation
 * (OR-005). What the database guarantees — the unique MSP code, the RESTRICT
 * that answers SITE_IN_USE — is exercised in
 * `test/integration/organization-http.spec.ts` against a real PostgreSQL,
 * because a double that returns what we programmed cannot prove an index
 * exists.
 */

const REQUESTER: Requester = { userId: 'user-1', ip: '10.0.0.1' };

/** Private-company RUC with a check digit computed by hand. */
const VALID_RUC = '1790001563001';

const ESTABLISHMENT: EstablishmentView = {
  id: 'est-1',
  mspUnicode: 'MSP-0001',
  typology: 'Centro de Salud Tipo A',
  legalName: 'Clínica de Prueba S.A.',
  ruc: VALID_RUC,
  headOfficeAddress: 'Av. Amazonas y Naciones Unidas, Quito',
  keepsAccounting: true,
  specialTaxpayerResolution: '5368',
  withholdingAgentResolution: null,
  rimpeRegime: 'NONE',
  fiscalProfileDeclaredAt: null,
  active: true,
};

const SITE: SiteView = {
  id: 'site-1',
  establishmentId: ESTABLISHMENT.id,
  mspUnicode: 'MSP-0001-N',
  name: 'Sede Norte',
  ruc: null,
  sriEstablishmentCode: '001',
  parishConceptId: null,
  addressLine: 'Av. de los Granados',
  phone: '02 000 0000',
  active: true,
};

/** What each test may tune before calling the service. */
interface Answers {
  findEstablishment: EstablishmentView | null;
  updateEstablishment: EstablishmentView | null;
  findSite: SiteView | null;
  updateSite: SiteView | null;
  deleteSite: boolean;
}

/** Every call the double receives, in order: writes AND reads. */
interface Call {
  method: string;
  args: unknown[];
}

function makeDouble(answers: Answers): {
  repository: OrganizationRepository;
  calls: Call[];
} {
  const calls: Call[] = [];
  const note = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };

  const repository: OrganizationRepository = {
    findEstablishment: () => {
      note('findEstablishment');
      return Promise.resolve(answers.findEstablishment);
    },
    createEstablishment: (input: EstablishmentInput) => {
      note('createEstablishment', input);
      return Promise.resolve({ ...ESTABLISHMENT, ...input });
    },
    updateEstablishment: (id: string, input: EstablishmentInput) => {
      note('updateEstablishment', id, input);
      return Promise.resolve(
        answers.updateEstablishment
          ? { ...answers.updateEstablishment, ...input }
          : null,
      );
    },
    listSites: (includeInactive: boolean, scope: SiteScopeFilter) => {
      note('listSites', includeInactive, scope);
      return Promise.resolve([SITE]);
    },
    findSite: (id: string) => {
      note('findSite', id);
      return Promise.resolve(answers.findSite);
    },
    createSite: (input: SiteInput) => {
      note('createSite', input);
      return Promise.resolve({ ...SITE, ...input });
    },
    updateSite: (id: string, patch: SitePatch) => {
      note('updateSite', id, patch);
      return Promise.resolve(answers.updateSite);
    },
    deleteSite: (id: string) => {
      note('deleteSite', id);
      return Promise.resolve(answers.deleteSite);
    },
  };

  return { repository, calls };
}

describe('OrganizationService', () => {
  let answers: Answers;
  let entries: AccessAuditEntry[];

  const build = () => {
    const { repository, calls } = makeDouble(answers);
    const service = new OrganizationService(repository, {
      record: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });
    return { service, calls };
  };

  beforeEach(() => {
    entries = [];
    answers = {
      findEstablishment: ESTABLISHMENT,
      updateEstablishment: ESTABLISHMENT,
      findSite: SITE,
      updateSite: SITE,
      deleteSite: true,
    };
  });

  describe('el establecimiento', () => {
    it('OR-003 expone el código único del MSP a quien deba consignarlo en cada atención', async () => {
      const { service } = build();

      await expect(service.getEstablishment()).resolves.toMatchObject({
        mspUnicode: 'MSP-0001',
        typology: 'Centro de Salud Tipo A',
      });
    });

    it('OR-001 responde ESTABLISHMENT_NOT_FOUND mientras no se haya registrado', async () => {
      answers.findEstablishment = null;
      const { service } = build();

      await expect(service.getEstablishment()).rejects.toThrow(
        EstablishmentNotFoundError,
      );
    });

    it('OR-001 crea el establecimiento la primera vez y lo edita después, con el mismo verbo', async () => {
      answers.findEstablishment = null;
      const first = build();

      await first.service.saveEstablishment(
        {
          mspUnicode: 'MSP-0001',
          typology: 'Centro de Salud Tipo A',
          legalName: 'Clínica de Prueba S.A.',
        },
        REQUESTER,
      );
      expect(first.calls.map((c) => c.method)).toEqual([
        'findEstablishment',
        'createEstablishment',
      ]);

      answers.findEstablishment = ESTABLISHMENT;
      const second = build();
      await second.service.saveEstablishment(
        {
          mspUnicode: 'MSP-0001',
          typology: 'Hospital Básico',
          legalName: 'Clínica de Prueba S.A.',
        },
        REQUESTER,
      );
      expect(second.calls.map((c) => c.method)).toEqual([
        'findEstablishment',
        'updateEstablishment',
      ]);
    });

    it('OR-005 deja constancia del alta y de la edición con autor e instante', async () => {
      answers.findEstablishment = null;
      const { service } = build();

      const created = await service.saveEstablishment(
        {
          mspUnicode: 'MSP-0001',
          typology: 'Centro de Salud Tipo A',
          legalName: 'Clínica de Prueba S.A.',
        },
        REQUESTER,
      );

      expect(entries).toEqual([
        {
          userId: 'user-1',
          resourceType: 'organization',
          resourceId: created.id,
          action: 'CREATE',
          ip: '10.0.0.1',
          userAgent: undefined,
        },
      ]);
    });

    it('OR-009 rechaza con INVALID_RUC el RUC de persona natural con verificador equivocado', async () => {
      answers.findEstablishment = null;
      const { service, calls } = build();

      await expect(
        service.saveEstablishment(
          {
            mspUnicode: 'MSP-0001',
            typology: 'Centro de Salud Tipo A',
            legalName: 'Clínica de Prueba S.A.',
            // The cedula 1710034065 with its check digit altered.
            ruc: '1710034060001',
          },
          REQUESTER,
        ),
      ).rejects.toThrow(InvalidRucError);

      // And nothing was written: the refusal happens before the repository.
      expect(calls.map((c) => c.method)).not.toContain('createEstablishment');
      expect(entries).toEqual([]);
    });

    it('OR-008 admite un RUC válido y guarda un RUC vacío como ausente', async () => {
      answers.findEstablishment = null;
      const withRuc = build();
      const saved = await withRuc.service.saveEstablishment(
        {
          mspUnicode: 'MSP-0001',
          typology: 'Centro de Salud Tipo A',
          legalName: 'Clínica de Prueba S.A.',
          ruc: `  ${VALID_RUC}  `,
        },
        REQUESTER,
      );
      expect(saved.ruc).toBe(VALID_RUC);

      const withoutRuc = build();
      const cleared = await withoutRuc.service.saveEstablishment(
        {
          mspUnicode: 'MSP-0001',
          typology: 'Centro de Salud Tipo A',
          legalName: 'Clínica de Prueba S.A.',
          ruc: '',
        },
        REQUESTER,
      );
      expect(cleared.ruc).toBeNull();
    });

    it('OR-028 un guardado que no trae la dirección de la matriz conserva la guardada', async () => {
      const { service, calls } = build();
      await service.saveEstablishment(
        {
          mspUnicode: 'MSP-0001',
          typology: 'Centro de Salud Tipo A',
          legalName: 'Clínica de Prueba S.A.',
        },
        REQUESTER,
      );
      const update = calls.find((c) => c.method === 'updateEstablishment');
      expect(update?.args[1]).toMatchObject({
        headOfficeAddress: 'Av. Amazonas y Naciones Unidas, Quito',
      });
    });

    it('OR-029 OR-031 un guardado sin las banderas fiscales conserva las guardadas sin declararlas, y las enviadas se guardan declaradas', async () => {
      const kept = build();
      await kept.service.saveEstablishment(
        {
          mspUnicode: 'MSP-0001',
          typology: 'Centro de Salud Tipo A',
          legalName: 'Clínica de Prueba S.A.',
        },
        REQUESTER,
      );
      expect(
        kept.calls.find((c) => c.method === 'updateEstablishment')?.args[1],
      ).toMatchObject({
        keepsAccounting: true,
        specialTaxpayerResolution: '5368',
        withholdingAgentResolution: null,
        rimpeRegime: 'NONE',
        // OR-031. Kept is not declared: nobody stated them in this save.
        declaresFiscalProfile: false,
      });

      const changed = build();
      await changed.service.saveEstablishment(
        {
          mspUnicode: 'MSP-0001',
          typology: 'Centro de Salud Tipo A',
          legalName: 'Clínica de Prueba S.A.',
          keepsAccounting: false,
          specialTaxpayerResolution: null,
          rimpeRegime: 'ENTREPRENEUR',
        },
        REQUESTER,
      );
      expect(
        changed.calls.find((c) => c.method === 'updateEstablishment')?.args[1],
      ).toMatchObject({
        keepsAccounting: false,
        specialTaxpayerResolution: null,
        rimpeRegime: 'ENTREPRENEUR',
        declaresFiscalProfile: true,
      });
    });

    it('OR-028 una dirección de la matriz enviada se guarda', async () => {
      const { service, calls } = build();
      await service.saveEstablishment(
        {
          mspUnicode: 'MSP-0001',
          typology: 'Centro de Salud Tipo A',
          legalName: 'Clínica de Prueba S.A.',
          headOfficeAddress: 'Calle Nueva 123, Quito',
        },
        REQUESTER,
      );
      const update = calls.find((c) => c.method === 'updateEstablishment');
      expect(update?.args[1]).toMatchObject({
        headOfficeAddress: 'Calle Nueva 123, Quito',
      });
    });
  });

  describe('las sedes', () => {
    it('OR-007 pide al repositorio las desactivadas solo cuando se le indica', async () => {
      const { service, calls } = build();

      await service.listSites(false, 'all');
      await service.listSites(true, 'all');

      expect(calls).toEqual([
        { method: 'listSites', args: [false, 'all'] },
        { method: 'listSites', args: [true, 'all'] },
      ]);
    });

    it('OR-004 cuelga la sede nueva del establecimiento registrado', async () => {
      const { service, calls } = build();

      await service.createSite(
        { mspUnicode: 'MSP-0001-S', name: 'Sede Sur' },
        REQUESTER,
      );

      const create = calls.find((c) => c.method === 'createSite');
      expect(create?.args[0]).toMatchObject({
        establishmentId: ESTABLISHMENT.id,
        name: 'Sede Sur',
        parishConceptId: null,
      });
    });

    it('OR-004 admite crear una sede antes de que exista el establecimiento', async () => {
      // The column is nullable for exactly this: refusing here would block a
      // clinic from adding a site before filling the establishment form.
      answers.findEstablishment = null;
      const { service, calls } = build();

      await service.createSite(
        { mspUnicode: 'MSP-0001-S', name: 'Sede Sur' },
        REQUESTER,
      );

      const create = calls.find((c) => c.method === 'createSite');
      expect(create?.args[0]).toMatchObject({ establishmentId: null });
    });

    it('OR-007 desactiva una sede sin tocar ninguna otra cosa', async () => {
      const { service, calls } = build();

      await service.updateSite('site-1', { active: false }, REQUESTER);

      expect(calls).toEqual([
        { method: 'updateSite', args: ['site-1', { name: undefined, parishConceptId: undefined, addressLine: undefined, phone: undefined, active: false }] }, // prettier-ignore
      ]);
      expect(entries.map((e) => e.action)).toEqual(['UPDATE']);
    });

    it('OR-008 no borra el RUC de una sede al renombrarla', async () => {
      // `undefined` means "leave it" and `null` means "clear it"; collapsing
      // the two would erase the RUC on every rename.
      const { service, calls } = build();

      await service.updateSite('site-1', { name: 'Sede Norte II' }, REQUESTER);

      const patch = calls[0]?.args[1] as Record<string, unknown>;
      expect('ruc' in patch).toBe(false);
    });

    it('OR-006 responde SITE_NOT_FOUND al borrar una sede que no existe', async () => {
      answers.deleteSite = false;
      const { service } = build();

      await expect(service.deleteSite('site-1', REQUESTER)).rejects.toThrow(
        SiteNotFoundError,
      );
      // A refusal is not a mutation: nothing goes into the trail.
      expect(entries).toEqual([]);
    });

    it('OR-005 deja constancia del borrado de una sede', async () => {
      const { service } = build();

      await service.deleteSite('site-1', REQUESTER);

      expect(entries).toEqual([
        expect.objectContaining({
          resourceType: 'organization',
          resourceId: 'site-1',
          action: 'UPDATE',
        }),
      ]);
    });

    it('responde SITE_NOT_FOUND al editar una sede que no existe', async () => {
      answers.updateSite = null;
      const { service } = build();

      await expect(
        service.updateSite('site-1', { name: 'Otra' }, REQUESTER),
      ).rejects.toThrow(SiteNotFoundError);
    });

    it('responde SITE_NOT_FOUND al pedir una sede que no existe', async () => {
      answers.findSite = null;
      const { service } = build();

      await expect(service.getSite('site-1')).rejects.toThrow(
        SiteNotFoundError,
      );
    });
  });
});
