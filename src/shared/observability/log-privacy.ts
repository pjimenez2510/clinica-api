/**
 * Protection of personal and health data in logs.
 *
 * STRATEGY: allowlist, not denylist.
 *
 * A denylist is a race you lose by default: it only protects what somebody
 * remembered to enumerate in the past, and every sprint adds new fields to
 * patient entities. The failure modes are asymmetric:
 *
 *   - Wrong allowlist -> a less informative log, noticed while debugging.
 *   - Wrong denylist  -> PHI on disk, replicated to backups and retained for
 *                        the whole retention period. Irreversible and
 *                        reportable to the data protection authority.
 *
 * Ecuador's LOPDP does not say "strip the sensitive parts", it says "process
 * only what is necessary". An allowlist is the literal implementation of that.
 */

/**
 * Keys that MAY appear in a log.
 *
 * Adding an entry here requires explicit review in the pull request. Nothing
 * that identifies a patient: no cedula, no names, no diagnosis.
 */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  // Pino envelope
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'name',

  // Correlation
  'trace_id',
  'span_id',
  'req_id',
  'reqId',

  // Serializers and their fields
  'req',
  'res',
  'err',
  'responseTime',
  'id',
  'method',
  'url',
  'route',
  'statusCode',

  // Business: INTERNAL identifiers, never national ones
  'site_id',
  'user_id',
  'role',
  'module',
  'patient_id',
  'encounter_id',
  'order_id',
  'invoice_id',

  // De-identified clinical context
  'specialty_code',
  'document_type',
  'state',
  'action',
  'result',

  // Technical metrics
  'duration_ms',
  'count',
  'total',
  'page',
  'limit',
  'retries',
  'cache_hit',

  // Errors
  'type',
  'message',
  'code',
  'stack',
  'error_code',
  'status',
  'dependency',

  // Context
  'context',
  'service',
  'version',
  'env',

  // Operational (startup, configuration): never contain patient data
  'port',
  'docs',
  'sri_environment',
]);

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;

/**
 * Prunes an object down to the allowed keys.
 *
 * The missing `else` at the end of the loop IS the policy: anything not
 * declared is dropped silently.
 */
export function pruneToAllowlist(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';

  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean')
    return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const trimmed: unknown[] = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((v) => pruneToAllowlist(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      trimmed.push(`[+${value.length - MAX_ARRAY_ITEMS} items omitted]`);
    }
    return trimmed;
  }

  if (type === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (ALLOWED_KEYS.has(key)) {
        output[key] = pruneToAllowlist(v, depth + 1);
      }
      // No `else`: anything not allowed is dropped. This is the policy.
    }
    return output;
  }

  return undefined;
}

/**
 * Strips the query string from a URL and normalises numeric identifiers.
 * In a clinical system the query string usually carries a cedula or a medical
 * record number.
 */
export function sanitizeUrl(url?: string): string {
  if (!url) return '';
  const i = url.indexOf('?');
  const base = i === -1 ? url : url.slice(0, i);
  return base.replace(/\/\d{4,}/g, '/:id');
}

/**
 * ORDER MATTERS: most specific first.
 *
 * An Ecuadorian mobile number (09 + 8 digits) is exactly 10 digits long, same
 * as a cedula. If the generic 10-digit pattern runs first it swallows every
 * phone number and mislabels it.
 *
 * (Both end up masked either way, so the label is cosmetic — but a log that
 * lies about which kind of data it hid gets in the way during an incident.)
 */
const PII_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  [/\b\d{13}\b/g, '[RUC]'], // 13 digits, before cedula and phone
  [/\b09\d{8}\b/g, '[PHONE]'], // 10 digits with a fixed prefix
  [/\b\d{10}\b/g, '[CEDULA]'], // 10 digits, the most generic: goes last
];

/**
 * Cleans an error message.
 *
 * PostgreSQL and Prisma errors often embed the row that caused the conflict —
 * with the patient's name and cedula inside.
 */
export function sanitizeErrorMessage(message?: string): string {
  if (!message) return '';
  let cleaned = message;
  for (const [pattern, replacement] of PII_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  // Detail of a pg constraint violation: `Key (cedula)=(1712345678)`
  cleaned = cleaned.replace(
    /\((?:[^()]{0,200})\)\s*=\s*\((?:[^()]{0,200})\)/g,
    '(...)=(...)',
  );
  return cleaned.slice(0, 500);
}
