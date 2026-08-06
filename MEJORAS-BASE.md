# Correcciones y mejoras de la base

Revisión del código actual (`src/`, `prisma/seed*.mts`, tooling) con el objetivo
de dejar cimientos sobre los que se pueda construir el resto del backend sin
tener que volver atrás.

**Criterio de esta lista:** sólo entra lo que afecta al código que ya existe.
No hay aquí features pendientes (auditoría LOPDP, colas, facturación): eso es
trabajo futuro normal, no deuda. Lo que sí entra es todo punto donde un
comentario **afirma** una garantía que el código no da, porque eso sí engaña a
quien construya encima.

Prioridades:

- **P0** — defecto real, explotable o que rompe en ejecución. Se arregla ya.
- **P1** — el cimiento no sostiene lo que dice sostener. Se arregla antes de la
  primera ruta clínica.
- **P2** — coherencia, organización y contrato. Barato ahora, caro con 20.000 líneas.
- **P3** — operación. Antes de que esto toque un servidor real.

---

## P0 — Defectos reales

### P0.1 · El bloqueo por intentos fallidos no funciona con concurrencia

**Dónde:** `src/modules/auth/application/auth.service.ts` → `registerFailedAttempt`
**Y:** `src/modules/auth/infrastructure/prisma-auth-user.repository.ts` → `recordFailedAttempt`

El contador se lee del `AuthUser` cargado al principio del request y se escribe
como **valor absoluto**:

```ts
const failures = currentFailures + 1;          // lectura obsoleta
await this.users.recordFailedAttempt(userId, failures, null);
```

Veinte peticiones concurrentes con contraseña incorrecta leen todas `0` y
escriben todas `1`. `failedAttempts` no llega nunca a `MAX_FAILED_ATTEMPTS` y la
cuenta **no se bloquea jamás**.

Con esto, de las "dos capas a propósito" que documenta el comentario de
`MAX_FAILED_ATTEMPTS` sólo queda una: el throttler por IP. Y ésa es
justamente la que un ataque distribuido esquiva, que es el escenario que la capa
por cuenta existía para cubrir.

**Arreglo.** El incremento tiene que ocurrir en la base, en una sola sentencia,
y la decisión de bloquear tomarse sobre el valor devuelto:

```ts
// repositorio
async registerFailure(userId: string): Promise<number> {
  const { failedAttempts } = await this.prisma.user.update({
    where: { id: userId },
    data: { failedAttempts: { increment: 1 } },
    select: { failedAttempts: true },
  });
  return failedAttempts;
}

async applyLock(userId: string, lockedUntil: Date): Promise<void> { ... }
```

El puerto cambia de `recordFailedAttempt(userId, failures, lockedUntil)` a
`registerFailure(userId): Promise<number>` + `applyLock(userId, until)`. El
cálculo del backoff exponencial se queda en el servicio, que es donde toca.

**Test que lo demuestra:** 10 `signIn` en paralelo con contraseña incorrecta →
`failedAttempts === 10` y la cuenta bloqueada. Hoy da `1` y sin bloqueo.

---

### P0.2 · La verificación TOTP no tiene freno por cuenta

**Dónde:** `src/modules/auth/application/auth.service.ts` → `verifyMfa`

Un código fallido no incrementa `failedAttempts`, no bloquea y no se registra.
El único límite es `@Throttle({ short: { ttl: 60_000, limit: 10 } })` por IP en
el controlador.

Son 6 dígitos —10⁶ combinaciones— y con `WINDOW = 1` hay 3 códigos válidos
simultáneamente. Con el `challengeToken` en mano (que dura los 15 minutos
completos del access token) sólo hace falta rotar IPs.

**Resultado: el segundo factor está peor protegido contra fuerza bruta que el
primero.**

**Arreglo.** Reusar exactamente la misma máquina de P0.1:

```ts
async verifyMfa(userId, code, ctx) {
  const user = await this.requireUser(userId);
  this.assertNotLocked(user);                  // mismo chequeo que signIn
  if (!user.mfaSecretEncrypted) throw new MfaNotEnrolledError();

  let usedStep: bigint;
  try {
    usedStep = this.totp.verify(...);
  } catch (error) {
    await this.registerFailedAttempt(user.id);  // ← lo que falta
    throw error;
  }
  await this.users.clearFailedAttempts(user.id);
  ...
}
```

Con umbral más bajo que el de contraseña (3, no 5): un TOTP no se teclea mal
tantas veces.

---

### P0.3 · `changePassword` no es atómico

**Dónde:** `src/modules/auth/application/auth.service.ts` → `changePassword`

```ts
await this.users.updatePasswordHash(userId, hash);
await this.refreshTokens.revokeAllForUser(userId, PASSWORD_CHANGE);
```

Si la segunda falla, la contraseña ya cambió y las sesiones del atacante siguen
vivas — el escenario exacto contra el que el comentario dice defender.

No hay ni un `$transaction` en todo el proyecto. Ésta es la primera operación
que lo necesita, y la primera es la que fija el patrón para las cincuenta
siguientes.

**Arreglo.** Añadir al puerto de persistencia una operación que exprese la
intención completa, y que el adaptador la resuelva en una transacción:

```ts
// ports.ts
interface AuthUserRepositoryPort {
  /** Cambia la contraseña y revoca toda sesión, o no hace ninguna de las dos. */
  rotateCredentials(userId: string, passwordHash: string, reason: string): Promise<void>;
}
```

La alternativa —exponer `$transaction` a la capa de aplicación— rompe la regla
de dependencia. La transacción es un detalle del adaptador; lo que la aplicación
declara es la atomicidad.

---

### P0.4 · `BigInt` va a romper el primer endpoint que lo devuelva

**Dónde:** `prisma/schema.prisma` → `AccessAudit.id`, `ObservationResult.id`,
`PatientMerge.id`, `AgendaStatusHistory.id`

`JSON.stringify` lanza `TypeError: Do not know how to serialize a BigInt`. No
hay serializador registrado. El día que exista `GET /audit` la respuesta es un
500 genérico sin pista de la causa.

**Arreglo.** En `main.ts`, antes de `bootstrap()`, o mejor en un módulo de
arranque explícito:

```ts
// Prisma devuelve BigInt para claves autoincrementales; JSON no lo sabe
// serializar. Como string y no como number: por encima de 2^53 un number
// pierde precisión en silencio, y esto son identificadores.
(BigInt.prototype as { toJSON?: () => string }).toJSON = function () {
  return this.toString();
};
```

Con un test que lo fije. Parchear un prototipo global merece una prueba que
explique por qué está ahí.

---

### P0.5 · El límite de 1 MB del body probablemente no se aplica

**Dónde:** `src/main.ts`

`NestFactory.create()` no recibe `{ bodyParser: false }`, así que el adaptador
de Express **ya registró** su parser JSON por defecto (100 KB) antes de que
corra tu `app.useBodyParser('json', { limit: '1mb' })`. El primero gana.

Falla hacia el lado seguro, pero el comentario dice 1 MB y no es 1 MB.

**Arreglo.** `NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false })`
y un test de integración que mande 200 KB y espere 201, más otro que mande 2 MB
y espere 413.

---

## P1 — Cimientos que no sostienen lo que dicen

### P1.1 · `@RequirePermission` acepta cualquier string

**Dónde:** `src/shared/http/auth.decorators.ts`

```ts
export const RequirePermission = (permission: string) => ...
```

El bloque de documentación inmediatamente encima dice: *"El permiso no es texto
libre: `Permission` es una unión cerrada, así que un typo no compila."* Es falso.
`@RequirePermission('recod:read')` compila y produce una ruta inalcanzable que
nadie sabe explicar.

El test de integración lo caza, pero eso es un ciclo de CI en lugar de un ciclo
de compilador — y el comentario le dice al lector que no hace falta comprobarlo.

**Arreglo.** Tipar el parámetro. El obstáculo es que `Permission` vive en
`modules/auth/domain` y el decorador en `shared/http`, y la regla
`sin-imports-entre-modulos` de `dependency-cruiser` lo prohíbe.

Eso no es un problema del arreglo: es la señal de que **el catálogo de permisos
es vocabulario compartido, no propiedad del módulo auth**. Ver P1.3.

---

### P1.2 · El guard no aplica el alcance por sede

**Dónde:** `src/modules/auth/infrastructure/permissions.guard.ts`

El guard evalúa `principal.can(required)` — global. `Principal.canAtSite` y
`Principal.sitesFor` están escritos, comentados, bien pensados y **nadie los
llama**.

Consecuencia: una recepcionista con grant en la sede A pasa el guard para
cualquier ruta de agenda de cualquier sede. El filtro queda como responsabilidad
de cada handler.

Ése es exactamente el modo de fallo —*"a alguien se le olvida"*— que el diseño
declara haber eliminado con el cierre por defecto. Cierras por defecto la
dimensión de permiso y dejas abierta la de sede, que en una clínica multi-sede es
la que produce el acceso indebido.

Hoy no es explotable porque no hay rutas de recurso. **Es la decisión que hay que
tomar antes de escribir la primera, no después de la vigésima.**

**Opciones, en orden de preferencia:**

1. **El decorador declara de dónde sale la sede y el guard la valida.**

   ```ts
   @RequirePermission('agenda:write', { siteFrom: 'param:siteId' })
   ```

   El guard resuelve el `siteId` del parámetro de ruta y llama a `canAtSite`.
   Cierra el hueco en el mismo sitio donde ya está la política. Limitación: sólo
   sirve cuando la sede está en la URL; para un `POST` cuyo `siteId` va en el
   cuerpo no vale, porque **los guards corren antes que los pipes** y el body no
   está validado (esto ya lo tienes documentado en `jwt-auth.guard.ts`).

2. **Para el resto, un helper de consulta obligatorio.** Que la capa de datos no
   acepte un filtro de sede suelto, sino un `Principal` + el permiso, y construya
   ella el `where`:

   ```ts
   const scope = siteScope(principal, 'agenda:read');
   // devuelve {} para ALL_SITES, { siteId: { in: [...] } } si es acotado,
   // y LANZA si el array está vacío — nunca "sin filtro"
   ```

   El punto crítico está ya escrito en el comentario de `sitesFor`: un array
   vacío es una denegación, jamás "no hay filtro que aplicar". Que eso lo aplique
   una función y no la memoria de quien escribe la query.

3. Un test que camine las rutas y exija que toda ruta con `siteId` en sus
   parámetros declare cómo se valida — el mismo patrón de
   `route-authorisation.spec.ts`, que ya demostró funcionar.

Elige una y escríbela en un ADR. Lo que no puede quedar es implícito.

---

### P1.3 · `Principal` y compañía están en el módulo equivocado

**Dónde:** `src/modules/auth/domain/principal.ts`,
`src/modules/auth/domain/permissions.ts`,
`src/modules/auth/infrastructure/jwt-auth.guard.ts` (`CurrentUserService`),
`src/modules/auth/infrastructure/permissions.guard.ts` (`PRINCIPAL`)

Todo módulo de negocio va a necesitar saber quién es el llamante y qué puede
hacer. Pero `dependency-cruiser` tiene esta regla:

```js
{
  name: 'sin-imports-entre-modulos',
  from: { path: '^src/modules/([^/]+)/' },
  to: { path: '^src/modules/([^/]+)/', pathNot: '^src/modules/$1/' },
}
```

**El primer módulo clínico choca de frente con tu propia regla.** Y el arreglo
apresurado, bajo presión de sprint, va a ser una excepción en el
`.dependency-cruiser.cjs`. Esa excepción es la primera grieta, y las reglas de
arquitectura mueren por acumulación de excepciones, no de golpe.

**Arreglo (10 minutos ahora, un día dentro de seis meses):**

```
src/shared/authorisation/
├── permission.catalogue.ts    ← PERMISSION_CATALOGUE, type Permission
├── principal.ts               ← Principal, ResolvedGrant, RoleAssignment, ALL_SITES
└── current-principal.ts       ← token CLS + servicio de lectura
```

`modules/auth` pasa a ser **quien produce** el `Principal`; `shared/authorisation`
es **el vocabulario** con que todos lo consumen. Y de paso P1.1 se resuelve solo:
`shared/http` ya puede importar `Permission` sin violar nada.

`default-roles.ts` y `RISKY_COMBINATIONS` **se quedan en `modules/auth`**: son
política de arranque del módulo de autorización, no vocabulario compartido.

---

### P1.4 · Los errores de dominio no tienen dueño ni registro

Esto responde directamente a la pregunta de si está bien declarar
`AccountInactiveError` dentro de `auth.service.ts`.

**Respuesta corta: como reflejo está bien, como sitio definitivo no.**

Lo que la colocación acierta: el error es parte del contrato del caso de uso y
leerlo junto a la lógica que lo lanza es mejor que un `errors.ts` genérico y
lejano. No lo cambies por un cajón de sastre.

Lo que falla, en concreto:

**a) La dirección del import queda al revés.** Para tipar un `catch` o escribir
un test, el consumidor tiene que importar `auth.service.ts` — y con él arrastra
`@nestjs/common`, `PinoLogger`, `assertValidPassword` y los cinco puertos. El
controlador ya lo hace. Un error es un valor liviano; no debería obligar a
importar la máquina que lo produce.

**b) El contrato público está desperdigado.** El README dice que `code` es
*"estable y nunca se traduce: es el contrato que consumen los clientes, los logs
y las alertas"*. Hoy esos códigos están repartidos en cinco archivos, entre
capas distintas, y **nada impide que dos clases declaren el mismo `code`**. No
existe un sitio donde leer qué puede devolver la API. Un contrato público que no
se puede enumerar no es un contrato.

**c) Hay errores en la capa equivocada.** `RefreshTokenReuseError` con código
`REFRESH_TOKEN_REUSE_DETECTED` está documentado en el README como parte de lo
que ve el cliente, y vive en
`modules/auth/infrastructure/refresh-token.service.ts`. **Un adaptador de
infraestructura está definiendo contrato público.** Si mañana cambias la
estrategia de tokens, el contrato con el frontend se mueve por debajo.

**Criterio que propongo — por qué existe el error, no por dónde se lanza:**

| Naturaleza | Dónde vive | Ejemplos |
|---|---|---|
| Regla de negocio / invariante | `modules/<m>/domain/<m>.errors.ts` | `InvalidCredentialsError`, `AccountInactiveError`, `MfaNotEnrolledError`, `MfaAlreadyEnrolledError`, `RefreshTokenReuseError`, `InvalidRefreshTokenError`, `WeakPasswordError` |
| Invariante de un value object | Junto al VO | `InvalidCedulaError` ✅ ya está bien |
| Forma del transporte HTTP | Junto al controlador | `MissingRefreshCookieError` ✅ ya está bien |
| Fallo técnico del adaptador | Junto al adaptador | `InvalidTokenError` (firma mal, token corrupto) |

La infraestructura **lanza** errores de dominio; no los **define**. Es la misma
regla que ya aplicas con los puertos, extendida a los errores.

**d) Falta el registro.** Un solo test convierte la promesa del README en algo
verificado:

```ts
// src/shared/domain/errors/error-catalogue.spec.ts
it('ningún código de error está duplicado', () => { ... });
it('el catálogo de códigos no cambió sin querer', () => {
  expect(ALL_ERROR_CODES).toEqual(FROZEN_LIST);   // snapshot explícito
});
it('todo código es SCREAMING_SNAKE_CASE', () => { ... });
```

La lista congelada es el punto: renombrar un código pasa a ser una línea en un
diff que alguien revisa, en vez de un cambio silencioso que rompe la alerta de
un integrador.

**e) Detalle menor.** `UserNotFoundError` extiende `NotFoundError` → 404, y se
lanza desde `requireUser()`, que sólo corre para usuarios **ya autenticados**.
Un 404 ahí es raro: el token es válido pero el usuario no existe, que es un
estado inconsistente del sistema. Es más honesto un 401 con revocación de
sesión, o un error propio.

---

### P1.5 · `ports.ts`: un archivo está bien, pero hay tres cosas que no son puertos

Esto responde a la otra pregunta.

**Un archivo `application/ports.ts` con los cinco puertos está bien.** Cohesión
alta —los consume un solo servicio—, ~120 líneas, y los símbolos de inyección
junto a su interfaz, que es lo que evita el clásico `tokens.ts` que se
desincroniza. La ubicación en `application/` es la correcta para hexagonal: el
puerto pertenece a quien lo necesita, no a quien lo implementa.

Se parte el día que (a) otro módulo necesite uno de ellos, o (b) pase de ~250
líneas. Ni una cosa ni la otra hoy.

**Lo que sí hay que sacar ya, porque no son puertos sino vocabulario:**

1. **`ClientContext`** (`{ ip, userAgent }`) está **duplicado literalmente** en
   `ports.ts` y en `refresh-token.service.ts`. Y lo va a necesitar la auditoría,
   que no es del módulo auth. → `shared/`.

2. **`RevocationReason`** está **duplicado literalmente** en `auth.service.ts` y
   en `refresh-token.service.ts`. Dos constantes idénticas en dos capas
   distintas: en cuanto alguien añada `ADMIN_REVOKED` a una y no a la otra,
   empiezan los valores que no cuadran con los de la base.

3. **`IssuedRefreshTokenResult`** (ports) e **`IssuedRefreshToken`**
   (refresh-token.service) son la misma forma con dos nombres. Uno solo.

**Sobre `AuthUserRepositoryPort`:** tiene 10 métodos y tres de ellos
(`savePendingMfaSecret`, `confirmMfa`, `recordMfaStep`) son estado de MFA, no
identidad. Segregarlo en `AuthUserRepositoryPort` + `MfaStatePort` es más
limpio, pero no urge — con un solo implementador el beneficio es teórico. Si
después de P0.1 y P0.3 el puerto pasa de 12 métodos, pártelo.

**Sobre lo que exporta el módulo:**

```ts
exports: [TokenService, CurrentUserService, PasswordHasher]
```

Está exportando **clases concretas de infraestructura**. Cualquier módulo que
las consuma queda acoplado al adaptador, que es justo lo que los puertos
existían para evitar. Exporta los símbolos (`TOKEN_ISSUER`, `PASSWORD_HASHER`) y
que el consumidor dependa de la interfaz.

---

### P1.6 · `strict: true` en TypeScript

**Dónde:** `tsconfig.json`

Hoy hay `strictNullChecks` y `noImplicitAny` sueltos. Faltan:

- `strictFunctionTypes`
- `useUnknownInCatchVariables`
- `noUncheckedIndexedAccess` ← el que más aporta aquí
- `noImplicitOverride`
- `noImplicitReturns`
- `noImplicitThis`
- `alwaysStrict`

Un proyecto con este nivel de rigor en SQL corriendo con el compilador a media
potencia es incoherente. Y `noUncheckedIndexedAccess` atrapa exactamente los
sitios donde ya hay riesgo: `cedula[2]`, `cedula[9]`, `header.split(' ')`,
`payload.sub!`.

Activar `strict: true` con 2.000 líneas cuesta una tarde. Con 20.000 no se hace
nunca.

Añadir también `noUnusedLocals` y `noUnusedParameters`, o dejarlos al linter
—pero que estén en un sitio.

---

### P1.7 · Claims del JWT sin validar

**Dónde:** `src/modules/auth/infrastructure/token.service.ts` → `verifyAccessToken`

```ts
sub: payload.sub!,
fam: payload.fam as string,
grants: (payload.grants as RoleAssignment[]) ?? [],
```

Un `!` y dos `as` sobre datos que vienen de fuera del proceso. La firma garantiza
que el token lo emitimos nosotros, no que su forma sea la que este código
espera: una rotación de claves mal hecha, un token de una versión anterior del
esquema de claims, o un bug futuro en `issueAccessToken` producen un `Principal`
con `grants` corrupto y **el fallo aparece tres capas más abajo**, sin relación
visible con la causa.

**Arreglo.** Un esquema Zod de los claims, parseado tras `jwtVerify`. Cuesta
microsegundos, elimina los tres castings y convierte un fallo difuso en un
`InvalidTokenError` en el borde:

```ts
const accessClaimsSchema = z.object({
  sub: z.uuid(),
  fam: z.string().min(1),
  grants: z.array(z.object({ roleId: z.uuid(), siteId: z.uuid().nullable() })),
  mfa: z.boolean(),
});
```

Nota adicional: `fam: 'pending-mfa'` no es un UUID, así que el esquema tiene que
contemplarlo — y ese es justamente el tipo de detalle que un esquema explícito
saca a la luz y un `as string` esconde. Vale la pena que el challenge token
lleve un claim propio (`typ: 'mfa_challenge'`) en vez de un `fam` con un valor
mágico dentro.

---

### P1.8 · `expiresIn: 900` a mano mientras el TTL es configurable

**Dónde:** `src/modules/auth/auth.controller.ts` (dos veces: `refresh` y
`toSessionResponse`)

`JWT_ACCESS_TTL` es configurable y por defecto vale `15m`. El controlador
devuelve `900` literal. Cambia la variable de entorno y **la API le miente al
cliente sobre cuándo caduca su token** — el frontend programa el refresh mal y
aparecen 401 intermitentes imposibles de reproducir.

**Arreglo.** Que `TokenService` exponga `accessTokenSeconds` (calculado del TTL
en `onModuleInit`) y que el controlador lo lea. Una sola fuente.

---

## P2 — Coherencia y contrato

### P2.1 · Tres lecturas de `process.env` que se saltan la validación

**Dónde:**
- `src/shared/http/problem-details.filter.ts` → `isProduction`
- `src/shared/observability/logger.config.ts` → `isProduction`, `LOG_LEVEL`, `APP_VERSION`

`logger.config.ts` se evalúa **en tiempo de import**, antes de que corra
`validateEnv`. Un `LOG_LEVEL=verbose` revienta con un error de pino en vez del
mensaje legible que construiste en `env.schema.ts` — y anula el fail-fast en el
único sitio donde ese fail-fast se nota.

**Arreglo.** `LoggerModule.forRootAsync({ inject: [ConfigService], useFactory })`.
Para el filtro, inyectar `ConfigService` como ya hace el controlador.

---

### P2.2 · `env.schema.ts`: validaciones que no validan

**`JWT_ACCESS_TTL: z.string().default('15m')`** — acepta `"banana"`. El fallo
aparece al emitir el primer token, no al arrancar. → `.regex(/^\d+[smhd]$/)`.

**`MFA_ENCRYPTION_KEY: z.string().min(44)`** — comprueba el largo del base64, no
que decodifique a 32 bytes. `TotpService` lo revuelve a comprobar y lanza en el
constructor, así que el proceso sí muere al arrancar, pero **con el mensaje
equivocado y en el sitio equivocado**. Muévelo al esquema:

```ts
MFA_ENCRYPTION_KEY: z.string().refine(
  (v) => Buffer.from(v, 'base64').length === 32,
  'debe decodificar a exactamente 32 bytes (AES-256-GCM)',
),
```

**`S3_*` y `SMTP_*` obligatorios** sin que nada los use. La app se niega a
arrancar por configuración de features que no existen. → `.optional()` hasta que
haya un adaptador que los lea. El fail-fast pierde autoridad si obliga a
inventar valores.

**`TRUST_PROXY_HOPS` con default `0`** — correcto en desarrollo, peligroso en
producción, donde casi siempre hay un nginx delante. El propio comentario explica
por qué equivocarse aquí no es cosmético. Que sea obligatorio y explícito cuando
`NODE_ENV === 'production'`:

```ts
.superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && raw.TRUST_PROXY_HOPS === undefined) {
    ctx.addIssue({ code: 'custom', path: ['TRUST_PROXY_HOPS'],
      message: 'debe declararse explícitamente en producción' });
  }
})
```

**`CORS_ORIGINS`** no valida que sean URLs. Un espacio de más y ese origen deja
de funcionar sin decir nada.

---

### P2.3 · Los parámetros de Argon2 están escritos tres veces

**Dónde:** `src/modules/auth/infrastructure/password-hasher.service.ts` (dos
objetos: `ARGON2_OPTIONS` y `REHASH_CHECK_OPTIONS`) y `prisma/seed.mts`.

Los dos primeros están separados a propósito y bien justificado. El del seed es
una **tercera copia sin relación**. Cuando subas el `memoryCost` —que es
exactamente el escenario que `needsRehash` existe para soportar—, el seed va a
seguir generando hashes con los parámetros viejos y la contraseña de desarrollo
se va a rehashear en cada login, en silencio.

**Arreglo.** Exportar los parámetros desde un módulo que el seed pueda importar,
como ya hace `seed-authorisation.mts` con `PERMISSION_CATALOGUE`.

---

### P2.4 · Defensas silenciosas en `PermissionsGuard`

**Dónde:** `src/modules/auth/infrastructure/permissions.guard.ts`

```ts
const principal = new Principal(
  claims?.sub ?? '',
  await this.roles.resolve(claims?.grants ?? []),
);
```

Si `claims` no está, `JwtAuthGuard` no corrió o no publicó nada — es una
violación de invariante, no un caso de uso. Construir un `Principal` vacío
convierte un bug de orden de guards en una denegación normal, indistinguible de
un permiso que falta. Debe lanzar y decirlo.

Dos detalles más en el mismo archivo:

- `PRINCIPAL` se **usa antes de declararse** (`this.cls.set(PRINCIPAL, ...)` está
  arriba, el `export const` al final). Funciona por el orden de inicialización de
  módulos, pero que el linter no lo señale indica que falta
  `no-use-before-define` en la configuración de ESLint.
- El `Principal` sólo se publica en la rama de permisos. Las rutas
  `@OwnAccount()` y `@MfaOptional()` no lo tienen. Es inconsistente y va a
  sorprender a quien escriba un handler.

---

### P2.5 · `MfaOptional` salta el control de permisos por completo

**Dónde:** `src/modules/auth/infrastructure/permissions.guard.ts`

```ts
if (this.reflector.getAllAndOverride<boolean>(MFA_OPTIONAL_KEY, targets)) {
  return true;   // ← ni MFA ni permiso
}
```

Correcto para las tres rutas actuales, pero el nombre del decorador dice "el MFA
es opcional aquí", no "esta ruta no comprueba permisos". Alguien lo va a poner en
una cuarta ruta pensando lo primero.

El test `route-authorisation.spec.ts` lo protege con una lista exacta, que es la
red adecuada. Cambia el nombre a algo que no engañe (`@MfaFlowOnly()`) y
menciona en el comentario del decorador que también salta la autorización.

---

### P2.6 · `X-Request-Id` del cliente como identificador de correlación

**Dónde:** `src/shared/observability/logger.config.ts` → `genReqId`

Validas el charset —bien, eso evita la inyección de saltos de línea en el log—
pero el cliente sigue eligiendo el identificador. Puede reusar el de otro, o
mandar el mismo en 10.000 peticiones para que sean indistinguibles.

Si ese ID es la correlación con que se reconstruye un acceso indebido ante la
SPDP, **no puede estar bajo control del sujeto investigado**.

**Arreglo.** Generar siempre el tuyo; guardar el del cliente como campo aparte
(`client_request_id`) para poder correlacionar con el frontend sin depender de él.

---

### P2.7 · Ruido y forma en el filtro de errores

**Dónde:** `src/shared/http/problem-details.filter.ts`

1. **`traceId` declarado y nunca poblado.** El tipo lo promete (*"el usuario
   reporta el id y encuentras la traza"*) y el body nunca lo lleva, aunque
   `genReqId` ya lo puso en la cabecera de respuesta. Dos líneas leyéndolo del CLS.
2. **Todo 4xx loguea el objeto de error completo.** Cada 401 de token expirado
   —que en producción son continuos— escribe un `err` con stack. A escala, eso
   es coste y ruido que tapa lo que importa. Para `status < 500`, código y ruta
   bastan.
3. **No comprueba `res.headersSent`.** Si el error ocurre después de empezar a
   escribir la respuesta, `httpAdapter.reply` lanza dentro del filtro y el
   proceso pierde el manejador. Una guarda de tres líneas.

---

### P2.8 · `TimeoutInterceptor` usa `Reflect.defineMetadata` a pelo

**Dónde:** `src/shared/http/interceptors/timeout.interceptor.ts`

El resto del proyecto usa `SetMetadata`. Aquí se manipula la metadata
directamente. Funciona, pero es la única excepción al patrón y no hay razón
escrita. `export const Timeout = (ms: number) => SetMetadata(TIMEOUT_KEY, ms);`

---

### P2.9 · Configuración muerta en `vitest.config.mts`

- `exclude: ['test/e2e/**']` — esa carpeta no existe; la suite está en
  `test/integration/`.
- Umbral de cobertura para `src/modules/facturacion-sri/domain/**`, módulo que no
  existe.

Ninguna de las dos rompe nada, pero configuración que apunta a la nada es cómo
empieza la configuración en la que nadie confía. Bórralas y añádelas cuando el
módulo exista.

---

### P2.10 · `seed-authorisation.mts`: sin transacción y sin ejecutarse solo

- Los `upsert` de permisos van uno a uno sin transacción: un fallo a mitad deja
  el catálogo parcialmente sincronizado.
- El comentario dice *"corre en TODOS los entornos, a diferencia del seed de
  desarrollo"*, pero nada lo ejecuta automáticamente: ni CI, ni un paso de
  despliegue, ni `db:deploy`. Sin él, una base de producción no puede conceder
  nada.

**Arreglo.** Envolver en `$transaction` y decidir dónde corre — lo natural es un
paso de arranque idempotente o parte del `db:deploy` del despliegue.

---

## P3 — Antes de tocar un servidor

Estos no afectan al código actual, pero son los que convierten "corre en mi
máquina" en "corre".

| # | Qué | Dónde | Por qué |
|---|---|---|---|
| P3.1 | `migrations:check` no corre en CI | `.github/workflows/ci.yml`, job `verify` | El script existe y está en `pnpm verify`, pero el job corre `typecheck`, `lint:check`, `arch:check` y `test` — no éste. La comprobación que protege del fallo que ya te pasó dos veces sólo corre si alguien se acuerda. **Una línea.** |
| P3.2 | Throttler en memoria | `app.module.ts` | Con dos réplicas el límite de login se duplica. Redis ya está en `docker-compose` justo para esto. |
| P3.3 | Pool de `pg` sin configurar | `prisma.service.ts` | El comentario dice *"el pool lo controlas tú, no Prisma"*. Sólo se pasa `connectionString`; `max` queda en el default (10). O lo configuras, o el comentario miente. |
| P3.4 | `statement_timeout` en ninguna parte | — | `TimeoutInterceptor` documenta que él corta la respuesta y que la consulta sigue viva en PostgreSQL, y que lo que la corta de verdad es `statement_timeout`. No está en `DATABASE_URL`, ni en compose, ni en migraciones. |
| P3.5 | `purgeExpired()` nunca se llama | `refresh-token.service.ts` | `refresh_token` crece sin límite. |
| P3.6 | Sin Dockerfile | — | No hay artefacto de despliegue en un proyecto que razona sobre `trust proxy`, HSTS preload y delegar la compresión a nginx. |
| P3.7 | `/health` público, sin throttle y con I/O a la base | `health.controller.ts` | Amplificación trivial. Límite generoso pero finito, o sólo en red interna. |
| P3.8 | Sin hook de pre-commit | — | El README dice que `pnpm verify` *"es lo que debería pasar antes de cada commit"*. Nada lo hace pasar. |

---

## Anexo A · Comentarios que hay que corregir

Los comentarios de este proyecto son buenos y creíbles, y ése es justamente el
riesgo: quien lea va a confiar sin verificar. Cada uno de éstos afirma algo falso
hoy. **O se implementa, o el comentario baja a `TODO:` explícito.** No hay
tercera opción.

| Archivo | Afirma | Realidad |
|---|---|---|
| `auth.decorators.ts` | *"`Permission` es una unión cerrada, un typo no compila"* | El parámetro es `string` (P1.1) |
| `auth.service.ts` | *"Dos capas a propósito: por cuenta y por IP"* | La capa por cuenta no funciona con concurrencia (P0.1) |
| `prisma.service.ts` | *"El pool de conexiones lo controlas tú"* | No se configura nada (P3.3) |
| `main.ts` | *"Límite de payload de 1 MB"* | Probablemente 100 KB (P0.5) |
| `problem-details.types.ts` | *"El usuario reporta el id y encuentras la traza"* | `traceId` nunca se puebla (P2.7) |
| `refresh-token.service.ts` | *"Pensado para correr desde un job programado"* | Nadie lo llama (P3.5) |
| `seed-authorisation.mts` | *"Corre en TODOS los entornos"* | Nada lo ejecuta (P2.10) |
| `schema.prisma` (`ViolenceScreening`) | *"Una tabla se puede REVOKE y auditar aparte"* | Ningún `REVOKE`, ningún permiso, ningún flujo |
| `docker-compose.yml` (redis) | *"Rate limiting compartido entre instancias"* | El throttler es en memoria (P3.2) |

---

## Anexo B · Decisiones, no tareas

Cuatro cosas que no se arreglan escribiendo código, sino decidiendo y
escribiéndolo en un ADR. Son las que de verdad fijan la forma del backend.

1. **Cómo se aplica el alcance por sede.** (P1.2) La más importante con
   diferencia. Debe decidirse antes de la primera ruta clínica.
2. **Dónde viven los errores y cómo se congela el catálogo de códigos.** (P1.4)
   Fija la respuesta y aplícala igual en los quince módulos siguientes.
3. **Regla de corte de servicios.** `AuthService` tiene 5 casos de uso y 300
   líneas; está bien y la justificación de no partirlo es correcta. Pero es el
   techo. Si `EncounterService` sigue el mismo patrón acaba con 15 métodos.
   Decide ahora la regla (por agregado, no por entidad) mientras es barato.
4. **Qué se cifra a nivel de aplicación y qué se delega al disco.** Hoy el
   secreto TOTP se cifra con AES-256-GCM y el contenido clínico va en claro. Hay
   un argumento sólido para esa asimetría —quien lee la base sin la clave no
   puede suplantar el segundo factor— pero está sin escribir, y sin escribir se
   parece a una omisión. Escríbelo.

---

## Orden sugerido

**Sesión 1 — defectos** (medio día)
P0.1 · P0.2 · P0.3 · P0.4 · P0.5

**Sesión 2 — apretar el compilador** (una tarde)
P1.6 (`strict: true`) · P1.7 (claims con Zod) · P2.2 (validaciones de entorno)

**Sesión 3 — mover los cimientos** (medio día)
P1.3 (`shared/authorisation`) → desbloquea P1.1 · P1.4 (errores + registro) ·
P1.5 (duplicados de `ports.ts`)

**Sesión 4 — la decisión** (discusión + ADR + implementación)
P1.2 (alcance por sede). **Bloquea la primera ruta clínica.**

**Sesión 5 — limpieza** (una tarde)
P2.1 · P2.4 · P2.5 · P2.6 · P2.7 · P2.8 · P2.9 · P2.10 · P1.8 · P2.3 ·
P3.1 · Anexo A

P3.2 a P3.8 cuando exista un entorno donde desplegar.
