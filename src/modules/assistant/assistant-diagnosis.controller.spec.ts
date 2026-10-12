import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';

import type { DiagnosisProposalService } from './application/diagnosis-proposal.service';
import { AssistantDiagnosisController } from './assistant-diagnosis.controller';

const OVERVIEW = { baseline: [], problems: [], readAt: null, demo: false };

function controller(enabled: boolean) {
  const proposals = {
    overview: vi.fn(() => Promise.resolve(OVERVIEW)),
    read: vi.fn(() => Promise.resolve({ ...OVERVIEW, dropped: 0 })),
    accept: vi.fn(() => Promise.resolve(OVERVIEW)),
    discard: vi.fn(() => Promise.resolve(OVERVIEW)),
  };
  const currentUser = {
    requirePrincipal: () => ({
      sitesFor: (permission: string) =>
        permission === 'record:read' ? ALL_SITES : ['site-1'],
    }),
    requireUserId: () => 'user-1',
  } as unknown as CurrentUserService;
  const req = { ip: '127.0.0.1', get: () => 'test' } as unknown as Request;
  return {
    proposals,
    req,
    controller: new AssistantDiagnosisController(
      proposals as unknown as DiagnosisProposalService,
      currentUser,
      enabled,
    ),
  };
}

const ENCOUNTER = '0190a2b4-0000-7000-8000-000000000001';
const SUGGESTION = '0190a2b4-0000-7000-8000-000000000002';

describe('AssistantDiagnosisController', () => {
  it('AS-026 with ASSISTANT_ENABLED off every route answers 404 and nothing is read', async () => {
    const { controller: off, proposals, req } = controller(false);

    for (const call of [
      () => off.overview(ENCOUNTER, req),
      () => off.read(ENCOUNTER, req),
      () => off.accept(ENCOUNTER, SUGGESTION, { diagnosisId: SUGGESTION }, req),
      () => off.discard(ENCOUNTER, SUGGESTION, req),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(proposals.overview).not.toHaveBeenCalled();
    expect(proposals.read).not.toHaveBeenCalled();
  });

  it('AS-026 AS-039 control: on, it asks with the record sites of each permission', async () => {
    const { controller: on, proposals, req } = controller(true);

    await on.read(ENCOUNTER, req);

    expect(proposals.read).toHaveBeenCalledWith(ENCOUNTER, {
      userId: 'user-1',
      readSites: 'all',
      writeSites: ['site-1'],
      ip: '127.0.0.1',
      userAgent: 'test',
    });
  });
});
