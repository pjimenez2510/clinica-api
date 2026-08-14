/**
 * En qué fase está la base de datos de este proyecto.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ CAMBIA CON ESTE VALOR, Y POR QUÉ EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `development` — **no hay ninguna instalación en producción todavía**. Una
 * migración se puede EDITAR y se pueden fusionar varias en una: el bucle es
 * «edito el SQL → `pnpm db:reset`», que tira la base, la vuelve a aplicar y
 * siembra. Es el bucle que la propia documentación de Prisma recomienda para
 * desarrollo, y es lo que evita el peor resultado posible de esta fase: dejar
 * un modelo peor porque corregirlo obligaba a apilar una migración encima de
 * otra. Decisión del usuario, 14-08-2026: «es preferible un cambio bien
 * aplicado que otro sólo por no dañar algo».
 *
 * `production` — hay al menos una base que alguien más ya migró. Una migración
 * versionada pasa a ser INMUTABLE: editarla funciona en la máquina que ya la
 * corrió y rompe en silencio todas las que no. Para corregir algo se crea otra.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE NO CAMBIA EN NINGUNA DE LAS DOS FASES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `prisma migrate dev` y `prisma db push` siguen bloqueados SIEMPRE, y no es
 * ceremonia: los dos calculan su diff contra `schema.prisma`, y este esquema
 * tiene 20 objetos que ese archivo no puede describir — 4 `EXCLUDE USING gist`,
 * 16 disparadores, columnas generadas e índices trigram y BRIN. Todo lo que la
 * base tiene y el archivo no, lo leen como sobrante y lo borran. Ya ocurrió
 * tres veces. La propia documentación de Prisma lo dice de otra forma: «la
 * migración sólo contendrá lo que refleja tu schema.prisma; si editaste
 * manualmente tus migraciones para añadir SQL personalizado, tendrás que volver
 * a añadirlo tú».
 *
 * El día que esto pase a `production`, cámbialo aquí y díselo al equipo: a
 * partir de ese commit, corregir una migración es crear otra.
 */
export const DATABASE_PHASE = 'development';

/** Si una migración ya versionada puede editarse. */
export const MIGRATIONS_ARE_REWRITABLE = DATABASE_PHASE === 'development';
