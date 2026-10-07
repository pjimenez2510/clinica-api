import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import { InvalidRucError } from '../../../shared/domain/value-objects/ruc.vo';
import {
  EstablishmentNotFoundError,
  SiteNotFoundError,
  SiteMspUnicodeInUseError,
} from '../domain/organization.errors';
import type {
  DocumentIdentityInput,
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
  tradeName: null,
  contactEmail: null,
  operatingPermit: null,
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
  updateDocumentIdentity: EstablishmentView | null;
  findSite: SiteView | null;
  updateSite: SiteView | null;
  deleteSite: boolean;
  siteHasEncounters?: boolean;
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
    updateDocumentIdentity: (id: string, input: DocumentIdentityInput) => {
      note('updateDocumentIdentity', id, input);
      return Promise.resolve(
        answers.updateDocumentIdentity
          ? { ...answers.updateDocumentIdentity, ...input }
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
    siteHasEncounters: (siteId: string) => {
      note('siteHasEncounters', siteId);
      return Promise.resolve(answers.siteHasEncounters ?? false);
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
      updateDocumentIdentity: ESTABLISHMENT,
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
          // OR-033. A creation carries only what it left.
          before: undefined,
          after: expect.objectContaining({
            legalName: 'Clínica de Prueba S.A.',
          }) as unknown,
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
          confirmsFiscalProfile: true,
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

    it('OR-031 llevar las banderas no las declara: hace falta que alguien lo confirme', async () => {
      const carried = build();
      await carried.service.saveEstablishment(
        {
          mspUnicode: 'MSP-0001',
          typology: 'Centro de Salud Tipo A',
          legalName: 'Clínica de Prueba S.A.',
          keepsAccounting: false,
          rimpeRegime: 'NONE',
        },
        REQUESTER,
      );
      expect(
        carried.calls.find((c) => c.method === 'updateEstablishment')?.args[1],
      ).toMatchObject({ declaresFiscalProfile: false });
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

  describe('los datos de cabecera de los documentos', () => {
    it('OR-010 OR-011 OR-012 guarda nombre comercial, correo y permiso en el establecimiento registrado', async () => {
      const { service, calls } = build();

      const saved = await service.saveDocumentIdentity(
        {
          tradeName: 'Clínica Andina',
          contactEmail: 'contacto@example.com',
          operatingPermit: 'ACESS-2026-0456',
        },
        REQUESTER,
      );

      expect(calls.map((c) => c.method)).toEqual([
        'findEstablishment',
        'updateDocumentIdentity',
      ]);
      expect(saved.tradeName).toBe('Clínica Andina');
      expect(saved.contactEmail).toBe('contacto@example.com');
      expect(saved.operatingPermit).toBe('ACESS-2026-0456');
      expect(entries.map((entry) => entry.action)).toEqual(['UPDATE']);
    });

    it('OR-010 guarda vacío como ausente: lo que falta no se imprime', async () => {
      const { service, calls } = build();

      await service.saveDocumentIdentity(
        { tradeName: '  ', contactEmail: null, operatingPermit: '' },
        REQUESTER,
      );

      expect(calls[1]?.args[1]).toEqual({
        tradeName: null,
        contactEmail: null,
        operatingPermit: null,
      });
    });

    it('OR-010 responde ESTABLISHMENT_NOT_FOUND si no hay establecimiento', async () => {
      answers.findEstablishment = null;
      const { service } = build();

      await expect(
        service.saveDocumentIdentity(
          { tradeName: 'X', contactEmail: null, operatingPermit: null },
          REQUESTER,
        ),
      ).rejects.toThrow(EstablishmentNotFoundError);
      expect(entries).toEqual([]);
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

    it('OR-032 rechaza crear una sede antes de que exista el establecimiento, sin escribir nada', async () => {
      answers.findEstablishment = null;
      const { service, calls } = build();

      await expect(
        service.createSite(
          { mspUnicode: 'MSP-0001-S', name: 'Sede Sur' },
          REQUESTER,
        ),
      ).rejects.toMatchObject({ code: 'SITE_ESTABLISHMENT_REQUIRED' });
      expect(calls.find((c) => c.method === 'createSite')).toBeUndefined();
      expect(entries).toEqual([]);
    });

    it('OR-007 desactiva una sede sin tocar ninguna otra cosa', async () => {
      const { service, calls } = build();

      await service.updateSite('site-1', { active: false }, REQUESTER);

      // OR-033 reads the site first, for the trail; the WRITE is what matters.
      expect(calls.filter((call) => call.method !== 'findSite')).toEqual([
        { method: 'updateSite', args: ['site-1', { name: undefined, parishConceptId: undefined, addressLine: undefined, phone: undefined, active: false }] }, // prettier-ignore
      ]);
      expect(entries.map((e) => e.action)).toEqual(['UPDATE']);
    });

    it('OR-008 no borra el RUC de una sede al renombrarla', async () => {
      // `undefined` means "leave it" and `null` means "clear it"; collapsing
      // the two would erase the RUC on every rename.
      const { service, calls } = build();

      await service.updateSite('site-1', { name: 'Sede Norte II' }, REQUESTER);

      const patch = calls.find((call) => call.method === 'updateSite')
        ?.args[1] as Record<string, unknown>;
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

  describe('bitácora con antes y después (OR-033)', () => {
    it('OR-033 records the establishment before and after an edit', async () => {
      const { service } = build();

      await service.saveEstablishment(
        {
          mspUnicode: ESTABLISHMENT.mspUnicode,
          typology: ESTABLISHMENT.typology,
          legalName: 'Clínica Renombrada S.A.',
          ruc: VALID_RUC,
        },
        REQUESTER,
      );

      expect(entries[0]).toMatchObject({
        action: 'UPDATE',
        resourceType: 'organization',
        before: { legalName: 'Clínica de Prueba S.A.' },
        after: { legalName: 'Clínica Renombrada S.A.' },
      });
      expect(entries[0]?.before).not.toHaveProperty('id');
      expect(entries[0]?.before).not.toHaveProperty('fiscalProfileDeclaredAt');
    });

    it('OR-033 records the document header before and after an edit', async () => {
      const { service } = build();

      await service.saveDocumentIdentity(
        {
          tradeName: 'Clínica Norte',
          contactEmail: null,
          operatingPermit: null,
        },
        REQUESTER,
      );

      expect(entries[0]?.before).toMatchObject({ tradeName: null });
      expect(entries[0]?.after).toMatchObject({ tradeName: 'Clínica Norte' });
    });

    it('OR-033 records the site before and after an edit', async () => {
      answers.updateSite = { ...SITE, name: 'Sede Quito Norte' };
      const { service } = build();

      await service.updateSite(
        SITE.id,
        { name: 'Sede Quito Norte' },
        REQUESTER,
      );

      expect(entries[0]?.before).toEqual({
        mspUnicode: 'MSP-0001-N',
        name: 'Sede Norte',
        ruc: null,
        parishConceptId: null,
        addressLine: 'Av. de los Granados',
        phone: '02 000 0000',
        sriEstablishmentCode: '001',
        active: true,
      });
      expect(entries[0]?.after).toMatchObject({ name: 'Sede Quito Norte' });
    });

    it('OR-033 a new site carries only the after half', async () => {
      const { service } = build();

      await service.createSite(
        { mspUnicode: 'MSP-0002', name: 'Sede Sur' },
        REQUESTER,
      );

      expect(entries[0]?.before).toBeUndefined();
      expect(entries[0]?.after).toMatchObject({ name: 'Sede Sur' });
    });
  });

  describe('corregir el código MSP de una sede (OR-034)', () => {
    it('OR-034 se corrige mientras la sede no tiene atenciones', async () => {
      const { service, calls } = build();

      await service.updateSite(
        SITE.id,
        { mspUnicode: 'MSP-9999' },
        { userId: 'u' },
      );

      const update = calls.find((call) => call.method === 'updateSite');
      expect(update?.args[1]).toMatchObject({ mspUnicode: 'MSP-9999' });
    });

    it('OR-034 con atenciones se rechaza con SITE_MSP_UNICODE_IN_USE y no escribe', async () => {
      answers.siteHasEncounters = true;
      const { service, calls } = build();

      await expect(
        service.updateSite(
          SITE.id,
          { mspUnicode: 'MSP-9999' },
          { userId: 'u' },
        ),
      ).rejects.toBeInstanceOf(SiteMspUnicodeInUseError);
      expect(calls.some((call) => call.method === 'updateSite')).toBe(false);
    });

    it('OR-034 enviar el mismo código no pregunta ni cambia nada', async () => {
      answers.siteHasEncounters = true;
      const { service, calls } = build();

      await service.updateSite(
        SITE.id,
        { mspUnicode: SITE.mspUnicode, name: 'Sede Norte' },
        { userId: 'u' },
      );

      const update = calls.find((call) => call.method === 'updateSite');
      expect(update?.args[1]).not.toHaveProperty('mspUnicode');
    });
  });
});
