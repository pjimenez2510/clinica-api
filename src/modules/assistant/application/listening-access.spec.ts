import { describe, expect, it, vi } from 'vitest';

import type { AccessAuditRecorder } from '../../../shared/audit/access-audit.port';
import type {
  CodingContextReader,
  CodingEncounter,
} from '../../../shared/clinical/coding-context.port';
import type { RecordingAuthorization } from '../../../shared/clinical/recording-authorization.port';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNotEncounterOwnerError,
  AssistantRecordingNotAuthorizedError,
} from '../domain/assistant.errors';

import { ListeningAccess, type ListeningRequester } from './listening-access';

const NOW = new Date(Date.UTC(2030, 0, 7, 15)); // fecha-fija: reloj falso de la prueba

function scene({
  status = 'OPEN',
  site = 'site-1',
  owner = 'doctor',
  enabled = ['site-1'],
  authorized = true,
}: {
  status?: CodingEncounter['status'];
  site?: string;
  owner?: string;
  enabled?: string[];
  authorized?: boolean;
} = {}) {
  const state = { enabled, authorized };
  const encounter = { id: 'enc-1', siteId: site, patientId: 'patient-1', practitionerUserId: owner, status } as unknown as CodingEncounter; // prettier-ignore
  const context = {
    encounter: vi.fn((_id: string, sites: 'all' | readonly string[]) =>
      Promise.resolve(
        sites === 'all' || sites.includes(encounter.siteId) ? encounter : null,
      ),
    ),
  } as unknown as CodingContextReader;
  const recording = {
    isAuthorized: vi.fn(() => Promise.resolve(state.authorized)),
    grant: vi.fn(() => {
      state.authorized = true;
      return Promise.resolve();
    }),
  } satisfies RecordingAuthorization;
  const audit = { record: vi.fn(() => Promise.resolve()) } as unknown as AccessAuditRecorder; // prettier-ignore
  const access = new ListeningAccess(
    context,
    audit,
    () => NOW,
    { enabledSites: () => Promise.resolve(state.enabled) },
    recording,
  );
  const requester: ListeningRequester = {
    userId: 'doctor',
    writeSites: ['site-1'],
    tokenExpiresAt: new Date(NOW.getTime() + 600_000),
  };
  return { access, state, recording, requester };
}

describe('ListeningAccess (A3)', () => {
  it('AS-165 refuses the ticket without the authorization to record, and gives it with it', async () => {
    const { access, state, requester } = scene({ authorized: false });
    await expect(access.issue('enc-1', requester)).rejects.toBeInstanceOf(
      AssistantRecordingNotAuthorizedError,
    );

    state.authorized = true;
    await expect(access.issue('enc-1', requester)).resolves.toMatchObject({
      ticket: expect.any(String) as string,
    });
  });

  it('AS-165 the attention refusals answer before the authorization', async () => {
    const closed = scene({ status: 'DISCHARGED', authorized: false });
    await expect(closed.access.issue('enc-1', closed.requester)).rejects.toBeInstanceOf(AssistantEncounterClosedError); // prettier-ignore
    const theirs = scene({ owner: 'other', authorized: false });
    await expect(theirs.access.issue('enc-1', theirs.requester)).rejects.toBeInstanceOf(AssistantNotEncounterOwnerError); // prettier-ignore
    expect(closed.recording.isAuthorized).not.toHaveBeenCalled();
    expect(theirs.recording.isAuthorized).not.toHaveBeenCalled();
  });

  it('AS-163 a confirmation after the site is switched off answers as an attention out of reach', async () => {
    const { access, state, requester } = scene();
    const ticket = (await access.issue('enc-1', requester)).ticket;
    const grant = access.redeem(ticket)!;
    await expect(access.confirm(grant)).resolves.toBeUndefined();

    state.enabled = [];
    await expect(access.confirm(grant)).rejects.toBeInstanceOf(
      AssistantEncounterNotFoundError,
    );
  });

  it('AS-163 a ticket for every site is narrowed to the sites on now', async () => {
    const { access, state, requester } = scene();
    const ticket = (await access.issue('enc-1', { ...requester, writeSites: 'all' })).ticket; // prettier-ignore
    const grant = access.redeem(ticket)!;
    state.enabled = ['site-9'];
    await expect(access.confirm(grant)).rejects.toBeInstanceOf(
      AssistantEncounterNotFoundError,
    );
  });

  it('AS-166 a confirmation after the authorization is revoked refuses with its code', async () => {
    const { access, state, requester } = scene();
    const grant = access.redeem((await access.issue('enc-1', requester)).ticket)!; // prettier-ignore
    state.authorized = false;
    await expect(access.confirm(grant)).rejects.toBeInstanceOf(
      AssistantRecordingNotAuthorizedError,
    );
  });

  it('AS-167 the read says whether the authorization stands', async () => {
    const { access, state, requester } = scene({ authorized: false });
    await expect(access.read('enc-1', requester)).resolves.toEqual({ recordingAuthorized: false }); // prettier-ignore
    state.authorized = true;
    await expect(access.read('enc-1', requester)).resolves.toEqual({ recordingAuthorized: true }); // prettier-ignore
  });

  it('AS-168 the own professional records it with the clock and their user; nobody else', async () => {
    const { access, recording, requester } = scene({ authorized: false });
    await expect(access.authorize('enc-1', { ...requester, ip: '10.0.0.1' })).resolves.toEqual({ recordingAuthorized: true }); // prettier-ignore
    expect(recording.grant).toHaveBeenCalledWith(
      'patient-1',
      { userId: 'doctor', ip: '10.0.0.1', userAgent: undefined },
      NOW,
    );

    const other = scene({ owner: 'other', authorized: false });
    await expect(other.access.authorize('enc-1', other.requester)).rejects.toBeInstanceOf(AssistantNotEncounterOwnerError); // prettier-ignore
    expect(other.recording.grant).not.toHaveBeenCalled();
  });
});
