import { parseArgs } from 'node:util';

import { DEV_PASSWORD } from '../prisma/seed.mts';

/**
 * C2 (AS-086). Opens an attention of today for the development médico, to try
 * the listening and the draft of the note on screen: «Abrir nota clínica»,
 * «Escuchar» with the test audio, «Detener», and the draft arrives.
 *
 * Through the API, as reception and the médico would, with the seed's
 * accounts and a seed patient (invented). Only against a development API:
 * it refuses port 3000, the author's.
 *
 *   pnpm demo:note-draft [--api http://localhost:3280]
 */
const { values } = parseArgs({
  options: { api: { type: 'string', default: process.env.API_URL } },
});
const api = values.api?.replace(/\/$/, '');
/**
 * Only this branch's own development API: http, on this machine, on the port
 * of this worktree's `.env` — never the author's :3000 nor anything else
 * (security review of 12-10-2026: a list of one forbidden port let an https
 * API through).
 */
function isThisBranchApi(url: string | undefined): boolean {
  if (!url || process.env.NODE_ENV === 'production') return false;
  const target = new URL(url);
  return (
    target.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) &&
    target.port !== '' &&
    target.port !== '3000' &&
    target.port === process.env.PORT
  );
}
if (!isThisBranchApi(api)) {
  console.error('Uso: pnpm demo:note-draft [--api http://localhost:<PORT del .env de la rama>]; nunca :3000 ni otra máquina'); // prettier-ignore
  process.exit(2);
}

async function signIn(
  email: string,
): Promise<{ token: string; userId: string }> {
  const response = await fetch(`${api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: DEV_PASSWORD }),
  });
  if (!response.ok) throw new Error(`${email}: el inicio de sesión respondió ${response.status}`); // prettier-ignore
  const body = (await response.json()) as { accessToken: string; user: { id: string } }; // prettier-ignore
  return { token: body.accessToken, userId: body.user.id };
}

async function call<T>(token: string, path: string, body?: object): Promise<T> {
  const response = await fetch(`${api}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
} // prettier-ignore

const reception = await signIn('recepcion@clinica.ec');
const doctor = await signIn('medico@clinica.ec');

const { items: sites } = await call<{ items: { id: string; name: string }[] }>(reception.token, '/agenda/sites'); // prettier-ignore
let where: { siteId: string; practitionerId: string } | null = null;
for (const site of sites) {
  const { items } = await call<{ items: { id: string; userId: string }[] }>(reception.token, `/agenda/sites/${site.id}/practitioners`); // prettier-ignore
  const mine = items.find((each) => each.userId === doctor.userId);
  if (mine) {
    where = { siteId: site.id, practitionerId: mine.id };
    break;
  }
}
if (!where)
  throw new Error('La semilla no vincula a medico@ con ninguna sede.');

const { items: patients } = await call<{ items: { id: string }[] }>(reception.token, '/patients?q=Andrade'); // prettier-ignore
const patient = patients[0];
if (!patient)
  throw new Error('Falta la semilla de pacientes: pnpm db:seed:patients');

const encounter = await call<{ id: string }>(doctor.token, '/encounters', {
  siteId: where.siteId,
  practitionerId: where.practitionerId,
  patientId: patient.id,
  startedAt: new Date().toISOString(),
  careModality: 'MORBIDITY',
  visitSequence: 'FIRST_TIME',
});
console.log(`Atención de prueba: /atencion/${encounter.id}?seccion=nota`);
