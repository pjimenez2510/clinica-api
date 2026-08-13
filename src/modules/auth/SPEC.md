# SPEC — Módulo `auth`

**Estado:** borrador para revisión · **Fecha:** 12 de agosto de 2026
**Fase:** 0/1 — Cimientos y núcleo operativo · **Formato:** EARS, según ADR-010

Quién entra, quién es y qué puede hacer. El módulo existía desde Fase 0 con su
mitad de **sesión** construida y probada; lo que este `SPEC.md` añade es la
mitad de **administración**, que nunca se escribió y sin la cual un permiso
nuevo no puede concederse desde la aplicación (D-012).

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Este módulo **posee** la cuenta de usuario, la sesión (contraseña, segundo
factor, tokens), el **rol** y la **concesión de rol por sede**, y el catálogo de
permisos que el código comprueba.

**Fuera de alcance:** el **profesional** —cédula, ACESS, especialidades,
horarios— es de `staff`, aunque su cédula y su registro vivan hoy en la fila de
`app_user` por no duplicarlos (ver notas de esquema de `staff`). La cuenta y el
profesional son cosas distintas: hay cuentas sin perfil clínico (recepción,
caja) y la habilitación para firmar no es un permiso del sistema, es una
credencial del MSP.

**Depende de:** nada. Es la base sobre la que se apoya el resto.

## Vocabulario

| Término               | Significado exacto en este módulo                                                       |
| --------------------- | ---------------------------------------------------------------------------------------- |
| **Cuenta**            | `app_user`: quién inicia sesión. Puede tener o no perfil de profesional                   |
| **Rol**               | Nombre de un conjunto de permisos. Es **dato**: la clínica crea los suyos                 |
| **Rol del sistema**   | `is_system = true`: lo define el código y llega con la instalación. Editable, no borrable |
| **Permiso**           | Código que una ruta exige. Es **código**: inventarlo en una fila no protegería nada       |
| **Concesión**         | `user_role_grant`: este usuario tiene este rol, opcionalmente **en esta sede**            |
| **Alcance por sede**  | `site_id` de la concesión. `NULL` = todas las sedes                                       |

---

## Entregas priorizadas

### A1 — Sesión _(P1, ya construida en Fase 0)_

Inicio de sesión con Argon2id, segundo factor TOTP, rotación de refresco con
detección de reutilización, bloqueo por intentos y cierre de sesión.

**Cubre:** AU-001 a AU-012.

### A2 — Administración de cuentas, roles y permisos _(P1)_

Un administrador da de alta a una persona, le asigna roles —con su sede— y
ajusta qué permisos lleva cada rol, sin desplegar código.

**Por qué es P1:** D-012 dejó la mitad del problema resuelto —un permiso nuevo
llega al administrador— pero moverlo a otro rol, o dar de alta a la recepcionista
que entra el lunes, sigue exigiendo tocar la base de datos a mano.
**Prueba independiente:** crear una cuenta, concederle un rol en una sede, y
comprobar que sus permisos efectivos cambian **sin reiniciar** y que la
concesión aparece en la bitácora.
**Cubre:** AU-020 a AU-034.

---

## Requisitos

### Sesión (REQ-118, Fase 0)

- **AU-001** — El sistema DEBERÁ almacenar las contraseñas con Argon2id y NO
  DEBERÁ poder recuperarlas en claro.
- **AU-002** — SI las credenciales no corresponden a una cuenta activa,
  ENTONCES el sistema DEBERÁ responder lo mismo tanto si el correo no existe
  como si la cuenta está inactiva o bloqueada, sin revelar cuál es el caso.
- **AU-003** — El sistema DEBERÁ bloquear la cuenta tras un número de intentos
  fallidos y registrar el bloqueo.
- **AU-004** — El sistema DEBERÁ emitir tokens de acceso de vida corta y
  refrescos rotatorios, y SI un refresco se reutiliza, ENTONCES DEBERÁ
  invalidar toda la familia de sesiones de esa cuenta.
- **AU-005** — El sistema DEBERÁ permitir matricular un segundo factor TOTP con
  códigos de respaldo, y DEBERÁ cifrar el secreto en la aplicación (ADR-008 §3).
- **AU-010** — El acceso DEBERÁ estar **cerrado por defecto**: una ruta sin
  declaración explícita de permiso se rechaza (REQ-118).
- **AU-011** — MIENTRAS el usuario no tenga alcance sobre la sede del recurso,
  el sistema NO DEBERÁ permitirle leerlo ni modificarlo.
- **AU-012** — El sistema DEBERÁ resolver los permisos **por petición** y no
  dentro del token, para que revocar surta efecto en segundos.

### Cuentas (REQ-152)

- **AU-020** — El sistema DEBERÁ permitir crear una cuenta con nombre, apellido
  y correo institucional único, con el permiso de administración de usuarios.
- **AU-021** — CUANDO se cree una cuenta, el sistema NO DEBERÁ fijarle una
  contraseña elegida por el administrador: DEBERÁ emitir una credencial de
  primer acceso que obligue a cambiarla.
  > **[NECESITA ACLARACIÓN]** ¿Cómo llega esa credencial a la persona: correo,
  > o la entrega el administrador en pantalla? Ver `D-013`.
- **AU-022** — El sistema NO DEBERÁ permitir **borrar** una cuenta: DEBERÁ
  desactivarla. Sus accesos quedan en la bitácora y borrarla dejaría huérfana
  la evidencia que exige la LOPDP (REQ-110).
- **AU-023** — MIENTRAS una cuenta esté desactivada, el sistema DEBERÁ
  rechazar su inicio de sesión y DEBERÁ invalidar sus sesiones abiertas.
- **AU-024** — El sistema DEBERÁ impedir que un administrador se desactive a sí
  mismo o se quite su propio permiso de administración, para que la instalación
  no pueda quedarse sin nadie que la administre.
- **AU-025** — Toda mutación de una cuenta DEBERÁ quedar en la bitácora con
  autor, instante y valor anterior, y NO DEBERÁ registrar nunca la contraseña
  ni el secreto del segundo factor.

### Roles y permisos (REQ-153, D-002, D-012)

- **AU-030** — El sistema DEBERÁ permitir crear roles propios de la clínica y
  editar los que trae la instalación, con el permiso de administración.
- **AU-031** — El sistema NO DEBERÁ permitir borrar un rol del sistema
  (`is_system`) ni uno que tenga concesiones vivas: DEBERÁ ofrecer desactivarlo.
- **AU-032** — El sistema DEBERÁ permitir conceder y revocar roles a una
  cuenta, **con alcance de sede opcional**, y el cambio DEBERÁ surtir efecto sin
  reiniciar la sesión de esa cuenta (AU-012).
- **AU-033** — El sistema DEBERÁ exponer el catálogo de permisos con su recurso
  y su descripción, para que quien asigna sepa qué está concediendo. Los
  permisos NO DEBERÁN poder crearse ni borrarse desde la aplicación: son código
  (D-002).
- **AU-034** — CUANDO se conceda a un rol un permiso de historia clínica
  (`record:*`) y ese rol tenga además administración de usuarios, el sistema
  DEBERÁ advertirlo sin impedirlo: es la separación que una auditoría de la
  SPDP pregunta primero, y la clínica puede decidir asumirla.

---

## Códigos de error

| Código                     | HTTP | Cuándo                                                       |
| -------------------------- | ---- | ------------------------------------------------------------- |
| `EMAIL_ALREADY_REGISTERED` | 409  | Correo repetido al crear una cuenta (AU-020)                  |
| `USER_NOT_FOUND`           | 404  | La cuenta indicada no existe                                  |
| `CANNOT_DEMOTE_SELF`       | 422  | Un administrador se desactiva o se despoja a sí mismo (AU-024) |
| `ROLE_CODE_DUPLICATE`      | 409  | Código de rol repetido (AU-030)                               |
| `ROLE_IN_USE`              | 409  | Borrar un rol con concesiones vivas (AU-031)                  |
| `SYSTEM_ROLE_PROTECTED`    | 422  | Borrar un rol del sistema (AU-031)                            |
| `UNKNOWN_PERMISSION`       | 422  | Conceder un permiso que el código no declara (AU-033)         |

Los de sesión —`INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `MFA_REQUIRED`,
`REFRESH_TOKEN_REUSE`— ya existen en `error-catalogue.ts` desde Fase 0 y no se
tocan.

## Notas de esquema

Todo lo que A2 necesita **ya existe**: `app_user`, `role`, `role_permission`,
`user_role_grant` con su `site_id`, y el índice único parcial
`user_role_grant_active_unique`. **No hace falta migración.**

Dos cosas comprobadas contra el código antes de escribir esto, para que nadie
las re-implemente:

- **Un rol desactivado ya no concede nada.** `role-permission.registry.ts`
  excluye `active: false` **en la consulta**, no filtrando después, y lo
  explica: filtrar a posteriori es un paso que alguien puede olvidarse.
- **Revocar surte efecto en segundos.** El token lleva sólo los roles y los
  permisos se resuelven por petición con caché corta, que es lo que hace
  cumplible AU-032 sin cerrar la sesión de nadie.
