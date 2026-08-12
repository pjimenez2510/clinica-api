---
paths:
  - "prisma/migrations/**/*.sql"
  - "prisma/schema.prisma"
---

# Migraciones y esquema

## Lo que Prisma no sabe hacer

Este esquema contiene objetos que `schema.prisma` **no puede expresar** y que
por tanto Prisma lee como diferencias a eliminar:

- `EXCLUDE USING gist` de agenda (profesional y consultorio).
- Triggers de inmutabilidad de notas firmadas y de la bitácora.
- Columnas generadas (`search_name`, `search_display`, `valid_period`).
- Índices trigram y BRIN.
- `CHECK` con lógica de dominio (dígito verificador de cédula, coherencia de
  paciente/bloqueo, rangos de signos vitales).

Consecuencia: **toda migración generada se lee entera antes de aplicarse.**
`prisma migrate dev` ya produjo una vez `DROP` de siete de estos objetos. Un
hook lo bloquea, pero el hook protege el comando, no el criterio.

## Reglas

- Migración nueva: `pnpm db:migrate:new <nombre>`. Nunca `prisma migrate dev`.
- **Nunca `prisma db push`.** Rehace el esquema desde `schema.prisma` y borra
  todo lo anterior.
- Una migración ya versionada en git es **inmutable**. Para corregirla se crea
  otra. Un hook lo bloquea.
- `pnpm migrations:check` debe pasar: comprueba que ninguna migración elimina un
  objeto protegido.
- Toda garantía nueva escrita en SQL necesita su prueba de integración contra
  PostgreSQL real en `test/integration/`. Un `EXCLUDE` sin prueba es una
  intención.

## Convenciones de columna

- `timestamptz` siempre. La única excepción deliberada es
  `practitioner_schedule_rule.start_time`/`end_time`: son hora de pared, no
  instantes.
- Identificadores `uuidv7()` generados por la base.
- `snake_case` en la base, mapeado con `@map` al `camelCase` de Prisma.
- Toda fecha clínica derivada de un `timestamptz` se calcula con
  `AT TIME ZONE 'America/Guayaquil'`. Un `::date` desnudo usa el huso de la
  sesión y desplaza un día la franja vespertina.
- `ON DELETE RESTRICT` por defecto. En un sistema clínico no se borra en
  cascada: se anula, se revoca o se marca.

## Al nombrar un constraint

El nombre viaja al cliente a través del mapeo de errores de PostgreSQL, así que
es parte del contrato. Formato: `<tabla>_<qué_garantiza>`, en inglés y
descriptivo — `agenda_entry_no_practitioner_overlap`, no `agenda_chk_3`.
