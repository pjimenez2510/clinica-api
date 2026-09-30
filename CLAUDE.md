# Constitución — `clinica-api`

Sistema de gestión clínica para Ecuador. Backend NestJS 11 · PostgreSQL 18 ·
Prisma · pnpm. Las decisiones y su porqué están en el repositorio hermano
`clinica-docs`; aquí solo van las **invariantes que no se negocian por tarea**.

> Si una instrucción de este archivo contradice lo que pide una tarea, gana este
> archivo y se dice en voz alta. Si contradice a un ADR, gana el ADR y este
> archivo está desactualizado: corregirlo en el mismo commit.

---

## 1. Antes de dar algo por terminado

Se trabaja por el flujo de seis etapas de `clinica-docs/GUIA-FRAMEWORK.md`
(definir → planificar → construir → verificar en pantalla → revisar → cerrar),
en una rama con plan en `clinica-docs/planes/`. Cada turno termina con:

```bash
pnpm verify:tocado      # formato, tipos, lint, arquitectura y pruebas de lo tocado
```

Y la entrega se cierra con la puerta completa, de una en una en la máquina:

```bash
../scripts/con-turno pnpm verify             # format, typecheck, lint, arch, migraciones, rtm, pruebas con cobertura
../scripts/con-turno pnpm test:integration   # obligatorias si se tocó la base
```

Nada se declara hecho porque «funciona en mi máquina». El criterio completo es
la puerta de calidad del `ROADMAP.md` en `clinica-docs`.

**Esto no depende de la buena voluntad.** Los hooks del espacio de trabajo
(`clinica-docs/workspace/claude/hooks/`, activos al abrir Claude en
`PROYECTO/`) bloquean de verdad: escribir código sin plan, cerrar el turno con
código sin verificar, fusionar a `main` sin revisión, `prisma migrate dev`,
`prisma db push`, editar una migración ya versionada, `git push` y los commits
con atribución de IA. Si un hook te bloquea, la respuesta nunca es rodearlo: es
hacer lo que dice o decírselo al usuario. → ADR-010.

## 2. Idioma

- **Todo el código en inglés**: identificadores, archivos, tipos, tablas,
  columnas y **comentarios**.
- **Español solo** en textos que lee el usuario final y en documentación.
- Los términos del dominio ecuatoriano no se traducen: `Cedula`, `RUC`, `CIE10`,
  `SRI`, `IESS`, `RDACAA`, `ACESS`, `CNMB`. Lo que los rodea sí:
  `Cedula.create()`, nunca `Cedula.crear()`.
- Los errores llevan `code` estable en inglés (`WEAK_PASSWORD`) y el texto
  traducible aparte. → ADR-005.

## 3. Arquitectura de módulo

`src/modules/<m>/{domain,application,infrastructure,dto}` + controlador.
Las fronteras las verifica `pnpm arch:check`, no la buena voluntad:

- `domain` no importa de `application`, ni de `infrastructure`, ni de NestJS,
  Prisma o cualquier framework.
- `application` no importa de `infrastructure` ni del ORM: habla por puertos.
- **Ningún módulo importa de otro módulo.** Lo compartido vive en `shared/`.
- Sin ciclos y sin huérfanos.

**Un servicio por agregado, no por entidad.** Se parte cuando cruza cualquiera
de estos tres límites: más de ~8 casos de uso públicos, dos grupos de métodos
sin dependencias en común, o dos motivos de cambio distintos. El número de
líneas por sí solo no es motivo. → ADR-008 §2.

## 4. Errores

- El error vive **donde está su razón de ser**, no donde se lanza. Regla de
  negocio → `modules/<m>/domain/<m>.errors.ts`. Invariante de un value object →
  junto al value object. Forma del transporte → junto al controlador o guard.
  Fallo del adaptador → junto al adaptador.
- **La infraestructura lanza errores de dominio; no los define.**
- Todo código nuevo se añade a `shared/domain/errors/error-catalogue.ts`.
  `error-catalogue.spec.ts` falla si diverge. La incomodidad es intencionada:
  el `code` es contrato público y renombrarlo rompe clientes.
- Contrato HTTP: RFC 9457 con `application/problem+json`, `title` legible y
  `code` estable, separados. Errores por campo en `errors[]`.
- Todo error tiene prueba de su contrato: código, estado HTTP y mensaje.
  → ADR-001, ADR-008 §1.

## 5. Base de datos

- **Lo que la base garantiza, se prueba contra la base.** Un doble que devuelve
  lo que le pedimos no demuestra que exista el `EXCLUDE`. Testcontainers con
  PostgreSQL 18.
- **Toda migración generada se lee entera antes de aplicarse.** `prisma migrate
  dev` ya generó una vez `DROP` de columnas generadas, índices trigram y
  constraints que existen en SQL y no en `schema.prisma`. Es un riesgo activo,
  no una anécdota. `migrate dev` y `db push` están bloqueados en toda fase.
- **Mientras no haya producción, una migración se puede reescribir.** Lo declara
  `scripts/database-phase.mjs`. El bucle es editar el SQL y `pnpm db:reset`.
  Corregir el modelo ahora vale más que arrastrarlo: lo caro no es rehacer la
  base hoy, es haber dejado un modelo peor por no tocarla. Cuando exista
  producción, esa constante pasa a `production` y vuelve la inmutabilidad.
- `timestamptz` siempre. La única excepción deliberada es
  `practitioner_schedule_rule.start_time`/`end_time`, que son hora de pared y no
  instantes.
- **Toda fecha clínica se resuelve en `America/Guayaquil`**, nunca con el huso de
  la sesión. Un `::date` sobre `timestamptz` a las 21:00 cae al día siguiente y
  eso cambia `age_days` de un neonato, que es como el RDACAA lo clasifica.
- Los identificadores son `uuidv7()` generados por la base.

## 6. Seguridad y datos personales

- **Cerrado por defecto.** Una ruta sin declaración de permiso se rechaza, y una
  prueba recorre las rutas que NestJS registró de verdad y falla si alguna no lo
  declara, nombra un permiso inexistente o amplía la superficie pública.
- El alcance por sede se comprueba además del rol. → ADR-007.
- **Nunca interpolar variables en una llamada de log.** Hay regla de ESLint. El
  logger poda PHI por lista blanca y falla cerrado; interpolar la esquiva.
- Ninguna respuesta de error distingue entre cuenta inexistente, inactiva o
  bloqueada: eso enumera al personal de la clínica.
- Se cifra en la aplicación lo que permitiría **suplantar** a alguien (secreto
  TOTP, contraseña). El contenido clínico se protege con control de acceso y
  bitácora, no con cifrado de campo. → ADR-008 §3.
- Ninguna prueba usa datos de una persona real. Las cédulas de prueba llevan
  dígito verificador calculado.

## 7. Especificación antes que código

Todo módulo de dominio nuevo empieza por su `src/modules/<m>/SPEC.md`, con
criterios de aceptación en EARS e identificadores `<MOD>-###`. La spec vive
junto al código y **se corrige en el mismo commit que cambia el comportamiento**.

No llevan `SPEC.md`: infraestructura transversal, corrección de defectos,
refactorizaciones, ni CRUD sin invariantes. → ADR-010.

## 8. Decisiones que no toma un agente

Política clínica, de negocio o legal —plazos de retención, quién autoriza qué,
valores por defecto, qué exige una norma que no se ha leído— **no se inventa con
un valor razonable**. Se registra en `../clinica-docs/DECISIONES-PENDIENTES.md`
con una recomendación y sus consecuencias, se sigue con lo que no dependa de
ello, y se le pregunta al usuario en bloque, no de una en una.

## 9. Cómo se trabaja aquí

- **Investigar antes de elegir una librería**, verificando versiones vigentes en
  fuente oficial, y presentar alternativa con su porqué. Nunca una sola opción.
- **Nada de patrones por simetría.** Un patrón entra cuando resuelve un problema
  que ya existe en el código, no porque el módulo vecino lo tenga.
- Después de cada entregable importante, revisión adversarial sobre el diff
  (seguridad, contratos, cobertura, cazador de fallos). Lo confirmado se corrige
  antes de marcar `[x]` en el ROADMAP.
- Los commits **no mencionan a Claude ni a ninguna IA**, ni en el mensaje ni en
  trailers.
- El ROADMAP es estado real, no plan aspiracional. Se actualiza al cerrar, no
  al empezar.

## Índice de decisiones

`clinica-docs`: ADR-000 convenciones de Claude Code · ADR-001 stack backend ·
ADR-003 modelo clínico · ADR-004 SRI y firma · ADR-005 mensajes al usuario ·
ADR-007 autorización y bitácora · ADR-008 convenciones de módulo · ADR-010 SDD y
EARS. Normativa ecuatoriana en `ESPECIFICACION-SISTEMA-CLINICA-ECUADOR.md`.
