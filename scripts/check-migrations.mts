import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Refuses a migration that drops an object Prisma cannot see.
 *
 * WHY THIS EXISTS: `prisma migrate dev` reads schema.prisma as the whole
 * truth. Everything this project keeps in SQL — generated columns, trigram
 * indexes, the BRIN index on the audit log, partial unique indexes — is
 * invisible to it, so every generated migration proposes removing them. It has
 * already happened twice, and both times the migration had to be edited by
 * hand before applying.
 *
 * Reading each one carefully is not a control: it works until the day somebody
 * is in a hurry, and the failure is silent — accent-insensitive patient search
 * simply stops working, months later, for nobody's apparent reason.
 *
 * The CI job that checks the objects exist AFTER migrating is the other half.
 * This one fails earlier and says exactly which line to delete.
 */

const MIGRATIONS = join(import.meta.dirname, '..', 'prisma', 'migrations');

/**
 * Objects that live only in SQL. Dropping one is almost always Prisma
 * proposing it, not a human meaning it.
 */
const PROTECTED = [
  'search_name',
  'search_display',
  'valid_period',
  // Generated columns of `practitioner_schedule_rule` (ST-042). They exist
  // only to feed `schedule_rule_no_overlap`, so dropping either silently
  // removes the exclusion with it.
  'minutes_range',
  'validity',
  'patient_search_name_trgm',
  'catalog_concept_search_trgm',
  'catalog_concept_current',
  'clinical_note_chain_version_unique',
  'clinical_note_one_current_per_chain',
  'patient_identifier_active_unique',
  // Índice PARCIAL (`WHERE merged_into_id IS NOT NULL`): responde «¿qué fichas
  // absorbió ésta?», que con D-031 —la superviviente lee por el enlace— es
  // camino de lectura y no una rareza, y es lo que impide que detectar una
  // cadena de fusiones (PA-046) recorra el registro entero. Prisma no puede
  // describir el predicado, así que lo lee como sobrante.
  'patient_absorbed_charts',
  'access_audit_occurred_brin',
  'agenda_entry_daily_agenda',
  // Índice PARCIAL (`WHERE service_type_id IS NOT NULL`): sin él, cada intento
  // de borrar un tipo de atención recorre `agenda_entry` entera para decidir
  // SP-025. Prisma no puede describir el predicado, así que lo lee como
  // sobrante.
  'agenda_entry_by_service_type',
  // Su gemelo en la lista de espera (`WHERE service_type_id IS NOT NULL`):
  // borrar un tipo de atención tiene que decidir también si alguien lo espera
  // (AG-060). Prisma no puede describir el predicado.
  'waitlist_entry_by_service_type',
  // Índice único PARCIAL (`WHERE rescheduled_from_id IS NOT NULL`): es a la vez
  // la garantía de que una cita se reprograma UNA sola vez (AG-050) y el índice
  // con el que se recorre la cadena hacia adelante (AG-051). Prisma no puede
  // describir el predicado, así que lo lee como sobrante.
  'agenda_entry_one_reschedule_per_entry',
  // Índice único PARCIAL (`WHERE converted_entry_id IS NOT NULL`): un cupo
  // satisface UNA entrada de lista de espera (AG-063). Sin él dos entradas
  // pueden apuntar a la misma cita y las dos quedan `SCHEDULED`, así que la
  // lista certifica que se atendió a dos personas con un cupo. Prisma no puede
  // describir el predicado, así que lo lee como sobrante.
  'waitlist_entry_one_per_converted_entry',
  // Índice PARCIAL (`WHERE status IN ('WAITING','CONTACTED')`): es la consulta
  // de AG-061 —los candidatos ABIERTOS de una sede— y su predicado es el del
  // requisito. Las entradas cerradas, que con el tiempo son casi todas, no se
  // proponen nunca (AG-067) y por eso no están en el índice.
  'waitlist_entry_open_candidates',
  'encounter_pending_report',
  'user_role_grant_active_unique',
  // Índice único PARCIAL: una cuenta, como mucho una invitación de credencial
  // viva (AU-027). Sin él, dos reenvíos simultáneos dejan dos enlaces válidos
  // y el que se envió por error sigue sirviendo.
  'credential_invitation_one_live_per_user',
  // Los tres índices únicos PARCIALES que hacen que «pulsar dos veces enviar a
  // caja» no duplique cargos (BI-154). Sus predicados —`… IS NOT NULL` y
  // `origin = 'CONSULTATION'`— no caben en `schema.prisma`, así que Prisma los
  // lee como sobrantes; y sin ellos la idempotencia vuelve a ser una lectura
  // previa, que bajo dos peticiones simultáneas no garantiza nada.
  'charge_item_one_per_encounter_procedure',
  'charge_item_one_per_service_order_item',
  'charge_item_one_consultation_per_encounter',
  // Índice único PARCIAL (`WHERE specialty_id IS NOT NULL`): UNA prestación por
  // (especialidad, secuencia de visita), que es lo que hace inequívoca la
  // propuesta del cargo de la consulta (BI-158).
  'billable_service_one_per_consultation',
];

/**
 * A drop is fine when the same migration puts the object back.
 *
 * Two real cases, both found by running this: `DROP COLUMN IF EXISTS
 * valid_period` followed immediately by the `ADD COLUMN … GENERATED` that
 * defines it — an idempotent recreate — and `user_role_grant_active_unique`
 * rebuilt after the role column changed type. Refusing either would make the
 * check impossible to satisfy, and a check nobody can satisfy gets deleted.
 */
function isRecreated(sql: string, name: string): boolean {
  const recreated = [
    `CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${name}"?\\b`,
    `ADD\\s+COLUMN\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${name}"?\\b`,
  ];
  return recreated.some((pattern) => new RegExp(pattern, 'i').test(sql));
}

const problems: string[] = [];

for (const dir of readdirSync(MIGRATIONS, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;

  const file = join(MIGRATIONS, dir.name, 'migration.sql');
  let sql: string;
  try {
    sql = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  sql.split('\n').forEach((line, index) => {
    const dropping =
      /^\s*(DROP\s+(INDEX|COLUMN)|ALTER\s+TABLE.*DROP\s+COLUMN)/i;
    if (!dropping.test(line)) return;

    for (const name of PROTECTED) {
      if (!new RegExp(`\\b${name}\\b`).test(line)) continue;
      if (isRecreated(sql, name)) continue;
      problems.push(
        `${dir.name}/migration.sql:${index + 1} drops "${name}"\n    ${line.trim()}`,
      );
    }
  });
}

if (problems.length > 0) {
  console.error(
    'These migrations drop objects that exist only in SQL:\n\n' +
      problems.map((p) => `  ${p}`).join('\n\n') +
      '\n\nPrisma proposes these because schema.prisma cannot describe them.' +
      '\nDelete the DROP lines unless you genuinely mean to remove the object.\n',
  );
  process.exit(1);
}

console.log(
  `Checked ${readdirSync(MIGRATIONS).length} migrations: no protected object is dropped.`,
);
