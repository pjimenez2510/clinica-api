import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * E19 (AS-345 to AS-356). What «Calidad del asistente» counts, registered as
 * the assistant would have left it in one consultation: its attempts by task
 * and its proposals in the four states, two of them in amber, and the review
 * of each section of the draft at the signature.
 *
 * `assistantQualityScene` is shared: the development seed puts it on a
 * consultation of `medico@` with a patient Carmen, and the integration test
 * puts it on its own attention and checks the board against these rows.
 *
 * NO MODEL WAS CALLED: the attempts carry `prompt_version = 'seed-e19'` so
 * nobody takes them for a real consultation, and so the seed runs once.
 */

export const SEED_PROMPT_VERSION = 'seed-e19';

const MINUTE = 60_000;

interface SceneInput {
  encounterId: string;
  practitionerId: string;
  /** Who decided the proposals: the practitioner's account. */
  deciderUserId: string;
  /** The attention's start; every instant of the scene follows it. */
  startedAt: Date;
}

/** The texts the scene writes into the proposals: none may reach the board. */
export const SCENE_TEXTS = [
  'Dolor de garganta de dos días',
  'Odinofagia y fiebre de 38,5 desde anteayer',
  'Amígdalas hipertróficas con exudado',
  'Amoxicilina 500 mg cada 8 horas por 7 días',
  'Amigdalitis aguda',
  '¿Desde cuándo tiene la fiebre?',
] as const;

export async function assistantQualityScene(
  prisma: PrismaClient,
  input: SceneInput,
): Promise<{ noteId: string }> {
  const at = (minutes: number) =>
    new Date(input.startedAt.getTime() + minutes * MINUTE);

  const noteId = randomUUID();
  await prisma.clinicalNote.create({
    data: {
      id: noteId,
      chainId: noteId,
      encounterId: input.encounterId,
      formCode: '002',
      formVersion: '1',
      content: { motivoConsulta: SCENE_TEXTS[0] },
      authorId: input.practitionerId,
    },
  });

  const run = (
    purpose: string,
    minutes: number,
    figures: {
      outcome?: string;
      tier?: 'fast' | 'quality';
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: number;
      latencyMs: number;
    },
  ) =>
    prisma.aiRun.create({
      data: {
        requestId: randomUUID(),
        attempt: 1,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        tier: figures.tier ?? 'quality',
        purpose,
        promptVersion: SEED_PROMPT_VERSION,
        outcome: figures.outcome ?? 'ok',
        httpStatus: figures.outcome && figures.outcome !== 'ok' ? 504 : 200,
        inputTokens: figures.input ?? null,
        outputTokens: figures.output ?? null,
        cacheReadTokens: figures.cacheRead ?? null,
        cacheWriteTokens: figures.cacheWrite ?? null,
        costUsd: figures.cost ?? null,
        worstCaseUsd: 0.05,
        priceValidFrom: at(-60 * 24 * 30),
        latencyMs: figures.latencyMs,
        startedAt: at(minutes),
        encounterId: input.encounterId,
      },
    });

  const draft = await run('note-draft', 10, { input: 1_200, output: 800, cacheRead: 3_000, cacheWrite: 400, cost: 0.0042, latencyMs: 4_200 }); // prettier-ignore
  await run('note-draft', 14, { input: 300, output: 700, cacheRead: 3_400, cost: 0.0021, latencyMs: 3_900 }); // prettier-ignore
  const questions = await run('note-questions', 15, { tier: 'fast', input: 500, output: 120, cacheRead: 2_000, cost: 0.0009, latencyMs: 1_500 }); // prettier-ignore
  const problems = await run('cie10-problems', 18, { input: 800, output: 200, cost: 0.0011, latencyMs: 2_100 }); // prettier-ignore
  const lines = await run('prescription-lines', 20, { input: 900, output: 260, cacheRead: 1_000, cost: 0.0013, latencyMs: 2_600 }); // prettier-ignore
  // A timeout reports no tokens: its cost is unknown, not zero (AS-345).
  await run('order-exams', 21, { outcome: 'timeout', latencyMs: 60_000 });

  const decided = (status: string, minutes: number) =>
    status === 'PROPOSED'
      ? {}
      : { decidedBy: input.deciderUserId, decidedAt: at(minutes) };

  const said = (text: string) => ({ text, fromMs: 1_000, toMs: 6_000, unsaid: false }); // prettier-ignore
  const unsaid = (text: string) => ({ text, fromMs: null, toMs: null, unsaid: true }); // prettier-ignore

  /** The reviews at the signature (AS-144), written once the note is signed. */
  const reviews: { suggestionId: string; status: string; distance: number }[] =
    [];

  /** A section of the draft, and the review it will have at the signature. */
  async function section(
    name: string,
    phrases: object[],
    status: 'PROPOSED' | 'ACCEPTED' | 'ACCEPTED_WITH_CHANGES' | 'DISCARDED',
    distances: { decided: number | null; signed: number },
  ) {
    const suggestion = await prisma.aiSuggestion.create({
      data: {
        encounterId: input.encounterId,
        aiRunId: draft.id,
        kind: 'note-section',
        proposal: { section: name, title: name, text: SCENE_TEXTS[1], phrases, demo: false }, // prettier-ignore
        sources: [{ kind: 'transcript', fromMs: 1_000, toMs: 6_000 }],
        status,
        distance: distances.decided,
        clinicalNoteId: status.startsWith('ACCEPTED') ? noteId : null,
        proposedAt: at(11),
        ...decided(status, 12),
      },
    });
    reviews.push({ suggestionId: suggestion.id, status, distance: distances.signed }); // prettier-ignore
  }

  await section('motivoConsulta', [said(SCENE_TEXTS[0])], 'ACCEPTED', { decided: 0, signed: 0 }); // prettier-ignore
  await section('enfermedadActual', [said(SCENE_TEXTS[1]), unsaid('desde anteayer')], 'ACCEPTED_WITH_CHANGES', { decided: 0.25, signed: 0.3 }); // prettier-ignore
  await section('examenFisico', [said(SCENE_TEXTS[2])], 'DISCARDED', { decided: null, signed: 1 }); // prettier-ignore
  await section('planTratamiento', [unsaid(SCENE_TEXTS[3])], 'PROPOSED', { decided: null, signed: 0.6 }); // prettier-ignore

  const other = (
    kind: string,
    aiRunId: string,
    proposal: object,
    status: 'PROPOSED' | 'DISCARDED',
    minutes: number,
  ) =>
    prisma.aiSuggestion.create({
      data: {
        encounterId: input.encounterId,
        aiRunId,
        kind,
        proposal,
        sources: [{ kind: 'transcript', fromMs: 2_000, toMs: 5_000 }],
        status,
        proposedAt: at(minutes),
        ...decided(status, minutes + 1),
      },
    });

  await other('diagnosis', problems.id, { problem: SCENE_TEXTS[4], code: 'J03.9', codes: ['J03.9'] }, 'DISCARDED', 18); // prettier-ignore
  await other('diagnosis', problems.id, { problem: 'Fiebre', code: 'R50.9', codes: ['R50.9'] }, 'PROPOSED', 18); // prettier-ignore
  await other('prescription-item', lines.id, { quote: SCENE_TEXTS[3], unsaid: ['dose'] }, 'PROPOSED', 20); // prettier-ignore
  await other('prescription-item', lines.id, { quote: SCENE_TEXTS[3], unsaid: [] }, 'DISCARDED', 20); // prettier-ignore
  await other('note-question', questions.id, { question: SCENE_TEXTS[5] }, 'DISCARDED', 15); // prettier-ignore
  await other('note-question', questions.id, { question: '¿Tiene alergias?' }, 'PROPOSED', 15); // prettier-ignore

  // The signature, and E1's review of each section the physician had in front.
  await prisma.clinicalNote.update({
    where: { id: noteId },
    data: {
      status: 'SIGNED',
      signedAt: at(25),
      signedById: input.practitionerId,
      contentHash: 'e'.repeat(64),
    },
  });
  for (const review of reviews) {
    await prisma.aiSuggestionReview.create({
      data: {
        suggestionId: review.suggestionId,
        clinicalNoteId: noteId,
        statusAtSigning: review.status,
        distance: review.distance,
        reviewedAt: at(25),
      },
    });
  }

  return { noteId };
}

/**
 * The development seed: one consultation of `medico@` with a patient Carmen,
 * this morning in Guayaquil, with the scene; and one without the assistant,
 * so the week's adoption is one of two. Once: a second run finds the scene.
 */
async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This seed is for development only.');
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const already = await prisma.aiRun.findFirst({
      where: { promptVersion: SEED_PROMPT_VERSION },
      select: { id: true },
    });
    if (already) {
      console.log('La escena del tablero del asistente ya estaba sembrada.');
      return;
    }
    const doctor = await prisma.user.findUniqueOrThrow({
      where: { email: 'medico@clinica.ec' },
      select: { id: true, practitioner: { select: { id: true } }, roleGrants: { select: { siteId: true } } }, // prettier-ignore
    });
    if (!doctor.practitioner) throw new Error('medico@ has no practitioner');
    const siteId =
      doctor.roleGrants.find((grant) => grant.siteId !== null)?.siteId ??
      (await prisma.site.findFirstOrThrow({ select: { id: true } })).id;
    const patients = await prisma.patient.findMany({
      where: { givenName: { startsWith: 'Carmen' } },
      select: { id: true },
      take: 2,
      orderBy: { id: 'asc' },
    });
    const others = await prisma.patient.findMany({
      where: { givenName: { not: { startsWith: 'Carmen' } } },
      select: { id: true },
      take: 1,
    });
    const carmen = patients[0] ?? others[0];
    if (!carmen) throw new Error('Run db:seed:patients first');

    // Two hours ago and one hour ago: always this week, always in the past.
    const now = Date.now();
    const attention = (patientId: string, startedAt: Date) =>
      prisma.encounter.create({
        data: {
          siteId,
          practitionerId: doctor.practitioner!.id,
          patientId,
          startedAt,
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      });
    const withAssistant = await attention(carmen.id, new Date(now - 2 * 60 * MINUTE)); // prettier-ignore
    await attention((others[0] ?? carmen).id, new Date(now - 60 * MINUTE));
    await assistantQualityScene(prisma, {
      encounterId: withAssistant.id,
      practitionerId: doctor.practitioner.id,
      deciderUserId: doctor.id,
      startedAt: withAssistant.startedAt,
    });
    console.log('Escena del tablero del asistente sembrada (E19).');
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('seed-assistant-quality.mts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
