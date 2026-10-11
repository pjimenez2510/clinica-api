import type { Cedula } from '../../../shared/domain/value-objects/cedula.vo';
import type {
  IdentityFinding,
  IdentityLookup,
} from '../domain/identity-proposal';
import { normaliseRegistryName, splitPair } from '../domain/registry-name';

/**
 * IL-001, IL-003, IL-008 (D-206 §1 c). Didit's database validation of an
 * Ecuadorian cedula, which answers from the Registro Civil under contract.
 *
 * THE CONTRACT, as Didit documents it publicly
 * (docs.didit.me/api-reference/database-validation/ecuador/cedula, read on
 * 10-10-2026; to be checked again when the account is opened):
 *
 *   POST {IDENTITY_PROVIDER_URL}            x-api-key: {IDENTITY_PROVIDER_API_KEY}
 *   { issuing_state: "ECU", services: "ecu_cedula", personal_number }
 *   → { match_type, source_data: { first_name, last_name, … } }
 *
 * ANTI-CORRUPTION LAYER: Didit's shape ends here. DIGERCIC would be another
 * class implementing the same port, and nothing else would change.
 *
 * Every failure to get an answer THROWS — a non-2xx status, a body that is
 * not JSON, an aborted request — and the service turns it into «no proposal»
 * (IL-003). A clean «not found» is `null`.
 *
 * Built only when the URL and the key exist (`identity-lookup.module.ts`):
 * without credentials this class is never instantiated, so nothing is called.
 */
export class DiditIdentityLookup implements IdentityLookup {
  readonly source = 'PROVIDER' as const;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async findByCedula(
    cedula: Cedula,
    signal: AbortSignal,
  ): Promise<IdentityFinding | null> {
    const response = await this.fetchFn(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        issuing_state: 'ECU',
        services: 'ecu_cedula',
        personal_number: cedula.toString(),
      }),
      signal,
      redirect: 'error',
    });
    if (!response.ok)
      throw new ProviderAnswerError(`status ${response.status}`);

    return toFinding((await response.json()) as unknown, cedula.toString());
  }
}

/** The provider answered, but not something usable. */
export class ProviderAnswerError extends Error {
  override readonly name = 'ProviderAnswerError';
}

/** A name field is at most this long; the schema caps the columns at 100/300. */
const MAX_FIELD = 100;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== ''
    ? value.trim().slice(0, MAX_FIELD)
    : null;

/**
 * Maps Didit's body to the port's shape; `null` when it found nobody.
 *
 * ⚠️ ONLY A FULL MATCH FOR THE CEDULA WE ASKED. Anything short of
 * `match_type: "full_match"` is `null` — a partial or fuzzy match is not a
 * name to propose. And if the body carries an `identification_number`, it MUST
 * be the one we asked: a provider that answers for a different cedula would
 * otherwise put another person's name on the chart, cached for 30 days.
 */
export function toFinding(
  body: unknown,
  expectedCedula: string,
): IdentityFinding | null {
  if (body === null || typeof body !== 'object') {
    throw new ProviderAnswerError('body is not an object');
  }
  const answer = body as Record<string, unknown>;
  if (answer.match_type !== 'full_match') return null;
  const data = answer.source_data;
  if (data === null || typeof data !== 'object') return null;
  const source = data as Record<string, unknown>;

  const answered = text(source.identification_number);
  if (answered !== null && answered !== expectedCedula) {
    throw new ProviderAnswerError('identification number does not match');
  }

  const lastName = text(source.last_name);
  const firstName = text(source.first_name);
  if (lastName === null && firstName === null) return null;

  const [familyName, secondFamilyName] = splitPair(lastName);
  const [givenName, secondGivenName] = splitPair(firstName);
  const birth = text(source.date_of_birth);
  return {
    source: 'PROVIDER',
    sourceName: normaliseRegistryName(`${lastName ?? ''} ${firstName ?? ''}`),
    familyName,
    secondFamilyName,
    givenName,
    secondGivenName,
    birthDate:
      birth !== null && /^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth : null,
    // Surnames and names arrive in separate fields: the order is the source's.
    orderToReview: false,
  };
}
