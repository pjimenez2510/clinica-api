-- schedule_rule_invariants
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- What a schedule rule must satisfy to be derivable into slots at all.
--
-- Found by adversarial review of E1 (P1-1). `practitioner_schedule_rule` had
-- no CHECK whatsoever, and in E1 its ONLY entry path is SQL and seeds — there
-- is no management endpoint validating anything. A representable-but-broken
-- row did real damage: a rule with `slot_minutes = 0` or `start >= end`
-- reached `slotsOfRuleOn`, threw RangeError, and turned availability AND
-- booking into 500 for every date the row covered. The domain now also skips
-- malformed rules defensively, but the database is where an invariant lives;
-- the filter is the seatbelt, not the guarantee.

-- Weekday is declared ISO-8601 (1 = Monday … 7 = Sunday) in schema.prisma.
-- Out of range was the quietest failure of the three: the rule simply never
-- applied, the practitioner's agenda came out empty, and nothing said why.
ALTER TABLE practitioner_schedule_rule
  ADD CONSTRAINT schedule_rule_weekday_iso CHECK (weekday BETWEEN 1 AND 7);

-- A slot of zero or negative minutes cannot tile an interval.
ALTER TABLE practitioner_schedule_rule
  ADD CONSTRAINT schedule_rule_slot_positive CHECK (slot_minutes > 0);

-- The rule must span a real interval, and it must end strictly inside the day.
--
-- WHY `end_time < '24:00'` AND NOT ONLY `end_time > start_time`. PostgreSQL
-- accepts '24:00' as a `time` value, and the driver hands it to JavaScript as
-- a Date rolled into the NEXT day, whose UTC hour reads 0. An 18:00–24:00 rule
-- would pass a plain ordering CHECK and still arrive at the domain as
-- 18:00–00:00 — inverted, silently. Until the domain can represent
-- end-of-day, "until midnight" is written as 23:59 (or as the last slot that
-- fits); a rule the database accepts but the application inverts is worse
-- than a rejected one.
ALTER TABLE practitioner_schedule_rule
  ADD CONSTRAINT schedule_rule_time_order CHECK (
    end_time > start_time AND end_time < TIME '24:00'
  );

-- `ADD CONSTRAINT ... CHECK` validates existing rows: if any rule already
-- violates these, the deploy stops here, names the constraint, and the row
-- has to be fixed by hand — which is the point. No data is rewritten by this
-- migration on purpose: inventing a weekday or a slot length would silently
-- change somebody's published schedule.
