---
paths:
  - "clinica-api*/prisma/migrations/**/*.sql"
  - "clinica-api*/prisma/schema.prisma"
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

## En qué fase estamos

`scripts/database-phase.mjs` lo declara, y **hoy dice `development`**: no hay
ninguna instalación en producción. Mientras siga así:

- Una migración **se puede editar**, y varias se pueden fusionar en una. El
  bucle es **editar el SQL → `pnpm db:reset`**, que tira la base, la reaplica y
  siembra. Es el bucle que la propia documentación de Prisma recomienda para
  desarrollo.
- **Es preferible corregir el modelo ahora que arrastrarlo.** Decisión del
  usuario (14-08-2026): un cambio bien aplicado vale más que uno peor hecho por
  no tocar una migración. Lo que en producción sería temerario, aquí es lo
  barato.

Cuando exista producción se cambia esa constante a `production` y la migración
versionada vuelve a ser **inmutable**: para corregir algo se crea otra. Un hook
lo bloquea a partir de ese momento.

## Reglas que no dependen de la fase

- Migración nueva: `pnpm db:migrate:new <nombre>`. **Nunca `prisma migrate dev`.**
- **Nunca `prisma db push`.**

Estas dos no son ceremonia de producción y no se relajan nunca: las dos calculan
su diff **contra `schema.prisma`**, y este esquema tiene 20 objetos que ese
archivo no puede describir —4 `EXCLUDE USING gist`, 16 disparadores, columnas
generadas, índices trigram y BRIN—. Todo lo que la base tiene y el archivo no lo
leen como sobrante y lo borran. Ya pasó tres veces. La documentación de Prisma
lo dice con otras palabras: «la migración sólo contendrá lo que refleja tu
`schema.prisma`; si editaste manualmente tus migraciones para añadir SQL
personalizado, tendrás que volver a añadirlo tú».

Añadir a mano lo que el lenguaje de esquema no expresa **es el camino oficial de
Prisma**, no una rareza de este proyecto.
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
