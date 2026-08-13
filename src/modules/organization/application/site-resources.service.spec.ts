import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import {
  EmissionPointNotFoundError,
  SiteNotFoundError,
  SiteRoomNotFoundError,
} from '../domain/organization.errors';
import type {
  EmissionPointView,
  SiteResourcesRepository,
  SiteRoomView,
} from '../domain/site-resources.repository';
import type { Requester } from './organization.service';
import { SiteResourcesService } from './site-resources.service';

/**
 * What this service owns, against doubles of its port: the site named by the
 * URL existing before anything is written, and an audit entry on every
 * mutation (OR-026). The uniqueness of a room name (OR-020) and of an
 * emission point code (OR-024) are unique indexes and are exercised against a
 * real PostgreSQL in `test/integration/organization-http.spec.ts` — a double
 * cannot prove an index exists.
 */

const REQUESTER: Requester = { userId: 'user-1', ip: '10.0.0.1' };

const ROOM: SiteRoomView = {
  id: 'room-1',
  siteId: 'site-1',
  name: 'Consultorio 1',
  active: true,
};

const EMISSION_POINT: EmissionPointView = {
  id: 'point-1',
  siteId: 'site-1',
  code: '001',
  description: 'Punto de emisión principal',
  active: true,
};

interface Answers {
  siteExists: boolean;
  updateRoom: SiteRoomView | null;
  deleteRoom: boolean;
  updateEmissionPoint: EmissionPointView | null;
  deleteEmissionPoint: boolean;
}

interface Call {
  method: string;
  args: unknown[];
}

function makeDouble(answers: Answers): {
  repository: SiteResourcesRepository;
  calls: Call[];
} {
  const calls: Call[] = [];
  const note = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };

  const repository: SiteResourcesRepository = {
    siteExists: (siteId) => {
      note('siteExists', siteId);
      return Promise.resolve(answers.siteExists);
    },
    listRooms: (siteId, includeInactive) => {
      note('listRooms', siteId, includeInactive);
      return Promise.resolve([ROOM]);
    },
    createRoom: (input) => {
      note('createRoom', input);
      return Promise.resolve({ ...ROOM, ...input });
    },
    updateRoom: (id, patch) => {
      note('updateRoom', id, patch);
      return Promise.resolve(answers.updateRoom);
    },
    deleteRoom: (id) => {
      note('deleteRoom', id);
      return Promise.resolve(answers.deleteRoom);
    },
    listEmissionPoints: (siteId, includeInactive) => {
      note('listEmissionPoints', siteId, includeInactive);
      return Promise.resolve([EMISSION_POINT]);
    },
    createEmissionPoint: (input) => {
      note('createEmissionPoint', input);
      return Promise.resolve({ ...EMISSION_POINT, ...input });
    },
    updateEmissionPoint: (id, patch) => {
      note('updateEmissionPoint', id, patch);
      return Promise.resolve(answers.updateEmissionPoint);
    },
    deleteEmissionPoint: (id) => {
      note('deleteEmissionPoint', id);
      return Promise.resolve(answers.deleteEmissionPoint);
    },
  };

  return { repository, calls };
}

describe('SiteResourcesService', () => {
  let answers: Answers;
  let entries: AccessAuditEntry[];

  const build = () => {
    const { repository, calls } = makeDouble(answers);
    const service = new SiteResourcesService(repository, {
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
      siteExists: true,
      updateRoom: ROOM,
      deleteRoom: true,
      updateEmissionPoint: EMISSION_POINT,
      deleteEmissionPoint: true,
    };
  });

  describe('los consultorios', () => {
    it('OR-020 comprueba que la sede existe antes de crear el consultorio', async () => {
      const { service, calls } = build();

      await service.createRoom('site-1', 'Consultorio 2', REQUESTER);

      expect(calls.map((c) => c.method)).toEqual(['siteExists', 'createRoom']);
    });

    it('OR-020 responde SITE_NOT_FOUND cuando la sede de la URL no existe', async () => {
      answers.siteExists = false;
      const { service, calls } = build();

      await expect(
        service.createRoom('site-1', 'Consultorio 2', REQUESTER),
      ).rejects.toThrow(SiteNotFoundError);
      expect(calls.map((c) => c.method)).not.toContain('createRoom');
    });

    it('OR-022 pide los consultorios desactivados solo cuando se le indica', async () => {
      const { service, calls } = build();

      await service.listRooms('site-1', false);

      expect(calls).toContainEqual({
        method: 'listRooms',
        args: ['site-1', false],
      });
    });

    it('OR-022 desactiva un consultorio y responde SITE_ROOM_NOT_FOUND si no existe', async () => {
      const found = build();
      await found.service.updateRoom('room-1', { active: false }, REQUESTER);
      expect(found.calls).toEqual([
        { method: 'updateRoom', args: ['room-1', { active: false }] },
      ]);

      answers.updateRoom = null;
      const missing = build();
      await expect(
        missing.service.updateRoom('room-1', { active: false }, REQUESTER),
      ).rejects.toThrow(SiteRoomNotFoundError);
    });

    it('OR-026 deja en la bitácora toda mutación de consultorios, con autor', async () => {
      const { service } = build();

      await service.createRoom('site-1', 'Consultorio 2', REQUESTER);
      await service.updateRoom('room-1', { name: 'Consultorio A' }, REQUESTER);
      await service.deleteRoom('room-1', REQUESTER);

      expect(entries.map((e) => e.action)).toEqual([
        'CREATE',
        'UPDATE',
        'UPDATE',
      ]);
      expect(
        entries.every(
          (e) => e.userId === 'user-1' && e.resourceType === 'organization',
        ),
      ).toBe(true);
    });

    it('OR-026 no escribe en la bitácora cuando el borrado no encontró nada', async () => {
      answers.deleteRoom = false;
      const { service } = build();

      await expect(service.deleteRoom('room-1', REQUESTER)).rejects.toThrow(
        SiteRoomNotFoundError,
      );
      expect(entries).toEqual([]);
    });
  });

  describe('los puntos de emisión', () => {
    it('OR-023 comprueba la sede antes de crear el punto de emisión', async () => {
      const { service, calls } = build();

      await service.createEmissionPoint('site-1', { code: '002' }, REQUESTER);

      expect(calls.map((c) => c.method)).toEqual([
        'siteExists',
        'createEmissionPoint',
      ]);
      expect(calls[1]?.args[0]).toMatchObject({
        siteId: 'site-1',
        code: '002',
        description: null,
      });
    });

    it('OR-025 lista los puntos de emisión como dato, sin numerar ningún comprobante', async () => {
      const { service, calls } = build();

      const items = await service.listEmissionPoints('site-1', false);

      expect(items).toEqual([EMISSION_POINT]);
      // The absence IS the requirement: nothing in this path reads or writes a
      // sequential, which is billing's business (REQ-085).
      expect(calls.map((c) => c.method)).toEqual([
        'siteExists',
        'listEmissionPoints',
      ]);
    });

    it('OR-026 responde EMISSION_POINT_NOT_FOUND al editar o borrar uno inexistente', async () => {
      answers.updateEmissionPoint = null;
      answers.deleteEmissionPoint = false;
      const { service } = build();

      await expect(
        service.updateEmissionPoint('point-1', { active: false }, REQUESTER),
      ).rejects.toThrow(EmissionPointNotFoundError);
      await expect(
        service.deleteEmissionPoint('point-1', REQUESTER),
      ).rejects.toThrow(EmissionPointNotFoundError);
      expect(entries).toEqual([]);
    });

    it('OR-026 deja en la bitácora toda mutación de puntos de emisión', async () => {
      const { service } = build();

      await service.createEmissionPoint('site-1', { code: '002' }, REQUESTER);
      await service.updateEmissionPoint('point-1', { active: false }, REQUESTER); // prettier-ignore
      await service.deleteEmissionPoint('point-1', REQUESTER);

      expect(entries.map((e) => e.action)).toEqual([
        'CREATE',
        'UPDATE',
        'UPDATE',
      ]);
    });
  });
});
