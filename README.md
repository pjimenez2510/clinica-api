# clinica-api

API del sistema de gestión clínica para Ecuador. NestJS 11 · PostgreSQL 18 · Prisma 7.

> Documentación de arquitectura y decisiones: `../clinica-docs/ADR-001-stack-backend.md`

---

## Levantar el entorno

```bash
corepack enable pnpm        # solo la primera vez
pnpm install
docker compose up -d        # postgres, redis, minio, mailpit
pnpm db:deploy              # aplica migraciones
pnpm db:seed                # crea usuarios de prueba
pnpm start:dev
```

La API queda en `http://localhost:3000/api` y la documentación interactiva en
**`http://localhost:3000/api/docs`** (Swagger UI, solo fuera de producción).

## Usuarios de prueba

Los crea `pnpm db:seed`. **Solo para desarrollo local.**

| Correo | Contraseña | Perfil |
|---|---|---|
| `medico@clinica.ec` | `el caballo come alfalfa` | Con registro ACESS |
| `recepcion@clinica.ec` | `el caballo come alfalfa` | Sin registro ACESS |

La contraseña es una frase larga a propósito: la política sigue la
recomendación del NIST, donde **manda la longitud** y no las reglas de
composición. `Password1!` sería rechazada por corta.

El seed es idempotente y además **reinicia el bloqueo por intentos fallidos y
el segundo factor**, así que si una prueba manual deja la cuenta bloqueada,
basta con volver a ejecutarlo.

---

## Probar la autenticación

La forma más cómoda es **Swagger UI** en `/api/docs`. Desde la terminal:

### Iniciar sesión

```bash
curl -i -c cookies.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"medico@clinica.ec","password":"el caballo come alfalfa"}'
```

Devuelve el `accessToken` **en el cuerpo** y el refresh token **en una cookie
`httpOnly`** que JavaScript no puede leer. Por eso hace falta `-c cookies.txt`:
sin guardar la cookie, el refresh no funciona.

### Usar el token

```bash
curl http://localhost:3000/api/v1/auth/logout \
  -X POST -H "Authorization: Bearer <accessToken>"
```

### Rotar la sesión

```bash
curl -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/v1/auth/refresh
```

Cada refresh **invalida el token anterior**. Si reutilizas uno ya usado, el
sistema lo interpreta como un token robado, revoca **todas** las sesiones de esa
familia y devuelve `REFRESH_TOKEN_REUSE_DETECTED`. Para probarlo, guarda una
copia del `cookies.txt` antes de refrescar y vuelve a enviarla después.

### Segundo factor

```bash
# 1. Iniciar enrolamiento: devuelve el secreto y el URI para el QR
curl -X POST http://localhost:3000/api/v1/auth/mfa/enroll \
  -H "Authorization: Bearer <accessToken>"

# 2. Confirmar con el código de la app autenticadora
curl -X POST http://localhost:3000/api/v1/auth/mfa/confirm \
  -H "Authorization: Bearer <accessToken>" \
  -H 'Content-Type: application/json' -d '{"code":"123456"}'
```

Una vez confirmado, el login devuelve `{"mfaRequired":true,"challengeToken":"..."}`
en lugar de una sesión. Ese token **solo abre los endpoints de MFA**: hay que
completar `POST /auth/mfa/verify` con el código para obtener la sesión real.

### Respuestas de error

Todas siguen **RFC 9457** con `Content-Type: application/problem+json`:

```json
{
  "type": "https://api.clinica.ec/problems/unauthenticated",
  "title": "INVALID_CREDENTIALS",
  "status": 401,
  "code": "INVALID_CREDENTIALS",
  "instance": "/api/v1/auth/login",
  "timestamp": "2026-08-06T01:47:48.000Z"
}
```

El campo `code` es **estable y nunca se traduce**: es el contrato que consumen
los clientes, los logs y las alertas. `title` y `detail` sí son traducibles.

Un correo inexistente y una contraseña incorrecta devuelven **exactamente lo
mismo**, y tardan lo mismo. Es deliberado: la diferencia permitiría averiguar
quién trabaja en la clínica.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm start:dev` | Arranca en modo watch |
| `pnpm verify` | typecheck + lint + reglas de arquitectura + tests |
| `pnpm test` | Tests unitarios |
| `pnpm test:cov` | Cobertura con umbrales por capa |
| `pnpm arch:check` | Verifica las reglas de dependencia entre capas |
| `pnpm db:migrate:new <nombre>` | Crea una migración VACÍA para escribirla a mano |
| `pnpm db:deploy` | Aplica las migraciones escritas. Nunca inventa SQL |
| `pnpm db:reset` | Borra la base, migra y siembra de nuevo |
| `pnpm db:studio` | Explorador visual de la base |

`pnpm verify` es lo que debería pasar antes de cada commit.

---

## Estructura

```
src/
├── shared/           # transversal, sin lógica de negocio
│   ├── domain/       # DomainError, value objects (Cedula)
│   ├── http/         # filtro RFC 9457, interceptors, decoradores de auth
│   ├── infrastructure/
│   ├── observability/# redacción de datos de salud en logs
│   └── config/       # validación de entorno con Zod al arrancar
└── modules/
    └── auth/
        ├── domain/         # política de contraseñas
        ├── application/    # casos de uso + PUERTOS
        └── infrastructure/ # adaptadores (Argon2, jose, Prisma, TOTP)
```

**La regla de dependencia se verifica en CI** con `pnpm arch:check`: el dominio
no puede importar infraestructura, y la capa de aplicación depende de puertos,
nunca de adaptadores concretos. Una regla arquitectónica que no está
automatizada es solo una sugerencia.

---

## ⚠️ `prisma migrate dev` está prohibido en este repositorio

`migrate dev` genera el SQL necesario para que la base **se parezca a
`schema.prisma`**. Eso es correcto cuando el esquema puede describir la base
entera. Aquí no puede: hay columnas generadas (`patient.search_name`), índices
GIN con `gin_trgm_ops`, un BRIN, índices únicos parciales, restricciones
`EXCLUDE` y disparadores de inmutabilidad. Nada de eso cabe en el esquema, así
que Prisma los lee como cosas que **sobran** y propone borrarlos.

Ha ocurrido tres veces. La tercera se aplicó y se llevó `search_name`, cuatro
índices y `clinical_note_chain_version_unique`, que es una garantía
médico-legal. `pnpm migrations:check` lo detecta, pero corre en `verify` y en
CI: después del daño.

El flujo correcto:

```bash
pnpm db:migrate:new nombre_de_la_migracion
# escribir el SQL a mano
pnpm migrations:check
pnpm db:deploy
```
