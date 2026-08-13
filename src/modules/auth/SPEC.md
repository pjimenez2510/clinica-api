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

**Solo servidor:** AU-001, AU-003, AU-012. Cómo se hashea una contraseña no
se ve; el bloqueo por intentos responde a la pantalla lo MISMO que una
contraseña incorrecta —eso es AU-002, y contarlo aparte lo delataría—; y
«por petición y no dentro del token» es una propiedad del servidor que un
navegador no puede observar.

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

**Solo servidor:** AU-025, AU-026, AU-027. Los dos primeros son bitácora y
el plazo de caducidad definido en un único sitio; AU-027 es un índice único
parcial. La pantalla no puede enseñar ninguno: por AU-028, un enlace
caducado, gastado o inventado responden lo mismo.

### A3 — Primera credencial por correo _(P1, 13-08-2026)_

Dar de alta a alguien funciona por fin **de extremo a extremo**: la persona
recibe un enlace de un solo uso en su correo institucional, elige su propia
contraseña y entra. El administrador nunca la conoce.

**Por qué es P1:** hasta esta entrega, `POST /auth/users` creaba una cuenta que
no podía iniciar sesión y no había ningún camino en software para que lo
hiciera. La cuenta existía, admitía roles, y era inútil.
**Prueba independiente:** crear una cuenta, abrir el enlace del correo, fijar
una contraseña y entrar con ella; y comprobar que el enlace ya no sirve una
segunda vez.
**Cubre:** AU-021, AU-026 a AU-029.

**Solo servidor:** AU-026, AU-027. Ver A2.

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

  > **A MEDIAS, y por eso no lo cita ninguna prueba.** El TOTP está: matrícula,
  > confirmación, secreto cifrado con clave propia, rechazo de un código
  > repetido y de uno anterior al último consumido —todo ello con prueba en
  > `totp.service.spec.ts` y `mfa-enrolment.service.spec.ts`—. **Los códigos de
  > respaldo no existen**: no hay columna en `app_user`, ni método en
  > `MfaEnrolmentService`, ni forma de usarlos al iniciar sesión.
  >
  > No se cita AU-005 en las pruebas del TOTP a propósito. Marcarlo cubierto
  > pondría A1 en 8/8 y **taparía una función que nadie ha construido**: quien
  > pierde el teléfono se queda fuera de la clínica sin más salida que un
  > administrador tocando la base a mano. Un eslabón en verde mintiendo es peor
  > que uno en rojo, así que se queda en rojo hasta que exista.
- **AU-010** — El acceso DEBERÁ estar **cerrado por defecto**: una ruta sin
  declaración explícita de permiso se rechaza (REQ-118).
- **AU-011** — MIENTRAS el usuario no tenga alcance sobre la sede del recurso,
  el sistema NO DEBERÁ permitirle leerlo ni modificarlo.
- **AU-012** — El sistema DEBERÁ resolver los permisos **por petición** y no
  dentro del token, para que revocar surta efecto en segundos.

### Cuentas (REQ-152)

- **AU-020** — El sistema DEBERÁ permitir crear una cuenta con nombre, apellido
  y correo institucional único, con el permiso de administración de usuarios. SI
  la cuenta lleva **cédula**, ENTONCES el sistema DEBERÁ validarla —diez
  dígitos, provincia existente, tercer dígito menor que 6 y dígito verificador—
  y rechazarla con `INVALID_CEDULA` cuando no lo sea. La ausencia de cédula
  sigue siendo legítima: recepción y caja no firman nada.

  > **Por qué se añade.** Esa columna es la que el RDACAA exige en cada atención
  > (REQ-021) y la que `staff` sirve en la ficha profesional, y no la
  > comprobaba nadie: `PATCH /auth/users/:id {"cedula":"abc"}` respondía 2xx. El
  > `is_valid_cedula()` de la base colgaba únicamente de `patient_identifier`.
  > Ahora la valida el value object `Cedula` en el DTO y la respalda
  > `app_user_cedula_valid` en la base.
- **AU-021** — CUANDO se cree una cuenta, el sistema NO DEBERÁ fijarle una
  contraseña elegida por el administrador: DEBERÁ emitir una credencial de
  primer acceso de un solo uso y **enviarla por correo electrónico** al correo
  institucional de la persona, para que sea ella quien elija su contraseña. El
  sistema NO DEBERÁ almacenar el token en claro ni mostrarlo a quien crea la
  cuenta, y DEBERÁ aplicar a esa contraseña la **misma política** que al cambio
  de contraseña.

  > **D-013, resuelta el 13-08-2026: por correo (opción A).** El
  > `[NECESITA ACLARACIÓN]` que había aquí queda cerrado. Esto es lo que se
  > construyó, y por qué cada pieza es como es:
  >
  > - `POST /auth/users` sigue creando la cuenta con el centinela
  >   `UNUSABLE_PASSWORD_HASH` —que ningún Argon2 puede producir—, así que la
  >   mitad prohibitiva de AU-021 sigue siendo cierta y comprobable: el
  >   administrador no elige la contraseña de nadie. `credentialPending: true`
  >   dice que la cuenta todavía no entra.
  > - Además emite una fila en `credential_invitation` con el **SHA-256** del
  >   token, igual que `refresh_token`, y envía al correo institucional un
  >   enlace a `{WEB_BASE_URL}/acceso/credencial?token=…`. El token existe en
  >   memoria durante una respuesta HTTP y en ningún otro sitio.
  > - `POST /auth/credential` es **público**, porque quien no puede iniciar
  >   sesión es justo quien tiene que alcanzarlo. Valida el enlace, aplica
  >   `assertValidPassword` —la misma función que `POST /auth/password`,
  >   importada y no reescrita—, fija el hash, marca la invitación como usada,
  >   revoca las sesiones abiertas de la cuenta y deja constancia en la
  >   bitácora **con la propia persona como autora**: nadie más pudo hacerlo,
  >   que es lo que hace posible el no repudio.
  > - `GET /auth/credential/:token` es público por lo mismo, y responde un
  >   booleano para que la pantalla pueda decir «este enlace ya no sirve» antes
  >   de pedir una contraseña.
  >
  > **Lo que este mecanismo cuesta y hay que saber:** dar de alta a alguien
  > pasa a depender de que la clínica tenga servidor de correo. Por eso
  > `SMTP_HOST` sigue siendo opcional y el rechazo llega al usarlo
  > (`MAIL_NOT_CONFIGURED`), no al arrancar, y por eso existe AU-029.
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

### Primera credencial (REQ-152, D-013)

Los cuatro requisitos que introduce la entrega del 13-08-2026. AU-021 dice
**qué** se envía; éstos dicen qué pasa con el tiempo, con el reenvío, con un
enlace que no sirve y con un correo que no sale.

- **AU-026** — La invitación de primera credencial DEBERÁ caducar a las **72
  horas** de emitirse, y el plazo DEBERÁ estar definido en un único sitio.

  > **Por qué 72 y no 24 ni una semana.** El enlace es una credencial al
  > portador que vive en un buzón: su vida útil es exactamente la ventana en la
  > que un mensaje reenviado, olvidado o interceptado sigue siendo una toma de
  > la cuenta. Con 24 horas, todo el que entra un viernes por la tarde encuentra
  > el enlace muerto el lunes, el administrador acaba reenviando para media
  > plantilla y la caducidad deja de significar nada. 72 horas cubren el fin de
  > semana y nada más. El número vive en `CREDENTIAL_INVITATION_TTL_HOURS`, no
  > en un `DEFAULT` de la base: dos definiciones de un plazo son una que se
  > olvida de cambiar.

- **AU-027** — CUANDO se reenvíe la invitación de una cuenta, el sistema DEBERÁ
  **anular la que estuviera viva** antes de emitir la nueva, de modo que un
  enlace enviado por error deje de funcionar.

  > La garantía es el índice único parcial
  > `credential_invitation_one_live_per_user` (`WHERE used_at IS NULL`), no un
  > `if`: dos administradores que reenvían a la vez leen los dos «no hay
  > ninguna viva» y escriben los dos. El caso que lo hace importar es el correo
  > mal tecleado, donde el enlace anterior está en el buzón de un desconocido.

- **AU-028** — SI la invitación presentada es desconocida, ya usada o está
  caducada, ENTONCES el sistema DEBERÁ responder **exactamente lo mismo** en
  los tres casos (`INVALID_CREDENTIAL_TOKEN`), sin revelar cuál es.

  > Es AU-002 aplicado a un canal donde quien llama es anónimo **por diseño**.
  > Distinguirlos convierte un endpoint público en un oráculo sobre el propio
  > secreto: «ya se usó» confirma que el token existía —y por tanto que una
  > conjetura tenía la forma correcta— y «caducó» confirma que a alguien se le
  > invitó.

- **AU-029** — SI el envío del correo falla, ENTONCES el sistema NO DEBERÁ
  deshacer la creación de la cuenta y DEBERÁ indicar en la respuesta que la
  invitación no salió, de modo que pueda reenviarse.

  > Las dos alternativas son peores. Deshacer el alta convierte una caída del
  > servidor de correo en «no se puede dar de alta a nadie». Fallar la petición
  > conservando la fila deja al administrador convencido de que no pasó nada,
  > así que lo intenta otra vez y recibe `EMAIL_ALREADY_REGISTERED`: un mensaje
  > sobre direcciones para un problema sobre servidores. La respuesta lleva
  > `invitationSent: false`, que es una respuesta **normal** a un 201.
  >
  > Por esto el puerto de correo tiene la política **contraria** a la del
  > puerto de bitácora: `AccessAuditRecorder.record` no puede lanzar hacia el
  > llamante —negarle a un médico una historia porque la bitácora no responde
  > es el intercambio equivocado en una clínica—, mientras que un correo de
  > credencial que falla en silencio deja a una persona sin poder entrar y a
  > nadie enterado.

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

  > **La descripción es la única salvaguarda de una concesión.** Los roles son
  > dato (AU-030): una clínica inventa «TALENTO HUMANO» y marca las casillas que
  > reconoce. `user:read` decía «las cuentas, los roles y el catálogo de
  > permisos» mientras el listado llevaba —y lleva— la **cédula** de toda la
  > plantilla, así que la descripción la nombra. No se retiró del listado
  > porque `clinica-web` no pide el detalle de una cuenta: la lee de la fila, y
  > quitarla haría que la siguiente edición guardara `cedula: null` y borrara la
  > cédula de cada profesional a quien alguien cambiase el nombre.
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
| `CANNOT_GRANT_TO_SELF`     | 422  | Alguien se concede a sí mismo un rol                          |
| `ROLE_CODE_DUPLICATE`      | 409  | Código de rol repetido (AU-030)                               |
| `ROLE_NOT_FOUND`           | 404  | El rol indicado no existe                                     |
| `ROLE_IN_USE`              | 409  | Borrar un rol con concesiones vivas (AU-031)                  |
| `SYSTEM_ROLE_PROTECTED`    | 422  | Borrar un rol del sistema (AU-031)                            |
| `UNKNOWN_PERMISSION`       | 422  | Conceder un permiso que el código no declara (AU-033)         |
| `INVALID_CEDULA`           | 422  | Cédula del personal que no supera su dígito verificador (AU-020) |
| `INVALID_CREDENTIAL_TOKEN` | 422  | Enlace de primera credencial desconocido, usado o caducado (AU-028) |
| `MAIL_NOT_CONFIGURED`      | 502  | La instalación no tiene `SMTP_HOST` (AU-029)                  |
| `MAIL_DELIVERY_FAILED`     | 503  | El servidor de correo no aceptó el mensaje (AU-029)           |

`INVALID_CREDENTIAL_TOKEN` es **uno solo para tres situaciones**, y eso es el
requisito y no una simplificación (AU-028). Es 422 y no 404 porque un 404 diría
«este token no existe», que es exactamente lo que no puede decirse; y porque
nada se buscó por cuenta de quien llama.

Los dos del correo se distinguen por **lo que hay que hacer**:
`MAIL_NOT_CONFIGURED` es configuración que falta —no es reintentable y la frase
nombra la variable, porque quien la lee es quien despliega—, y
`MAIL_DELIVERY_FAILED` es un servidor que no aceptó el mensaje y puede
aceptarlo dentro de un minuto, así que sale como 503 con `Retry-After`.
**Ninguno de los dos hace fracasar el alta de la cuenta** (AU-029): quedan en
el registro y la respuesta lleva `invitationSent: false`.

`CANNOT_GRANT_TO_SELF` **no es una regla nueva de esta entrega**: la garantía
`user_role_grant_no_self_grant` está en la base desde
`20260806045045_staff_roles_and_site_scope`, con su porqué escrito al lado —«la
pregunta de auditoría *quién dio a esta persona acceso a las historias* no puede
responderse *ella misma*»—. Construir las pantallas de A2 es lo que por fin le ha
dado una forma de alcanzarse desde la aplicación, y el código convierte un
`CHECK_FAILED` en una frase sobre la que una clínica puede actuar. Sólo prohíbe
**añadirse** concesiones: retirarse una propia sigue siendo posible, y AU-024 es
lo que impide retirarse la que importa.

`CANNOT_DEMOTE_SELF` cubre las **tres** formas de dejar la instalación sin
administración, y las tres tienen prueba: desactivarse a uno mismo, quitarse el
propio `user:manage` editando las concesiones, y borrar o desactivar el último
rol activo que lo lleva —o vaciárselo—. La última la respalda además el
disparador de sentencia `trg_role_permission_keep_an_administrator`, que es lo
único que aguanta un `DELETE FROM role_permission` tecleado en `psql`.

Los de sesión —`INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `MFA_REQUIRED`,
`REFRESH_TOKEN_REUSE`— ya existen en `error-catalogue.ts` desde Fase 0 y no se
tocan.

## Notas de esquema

Todo lo que A2 necesita para cuentas, roles y concesiones **ya existía**:
`app_user`, `role`, `role_permission`, `user_role_grant` con su `site_id`, y el
índice único parcial `user_role_grant_active_unique`.

**La primera credencial sí necesitó tabla nueva**, en
`20260813145429_credential_invitation`: `credential_invitation` con `user_id`
(`ON DELETE CASCADE`, como `refresh_token`: es un artefacto de credencial, no
evidencia clínica), `token_hash` (`char(64)` único, **sólo el SHA-256**),
`expires_at`, `used_at`, `created_at` y `created_by_id`. Lleva el índice único
**parcial** `credential_invitation_one_live_per_user` sobre
`WHERE used_at IS NULL`, que es la garantía de AU-027 y que `schema.prisma` no
sabe expresar —está en la lista protegida de `scripts/check-migrations.mts`—, y
el CHECK `credential_invitation_expires_after_creation`.

`used_at` significa «ya no está viva» por sus **dos** caminos, a propósito: la
canjearon (AU-021) o la anularon al reenviar (AU-027). Los dos responden lo
mismo a quien presenta el enlace, que es lo único que el enlace debe poder
distinguir (AU-028), y qué invitación se canjeó de verdad se responde con
evidencia más fuerte: sólo un canje cambia `app_user.password_hash`.

**Variables de entorno nuevas:** `WEB_BASE_URL` (por defecto
`http://localhost:3001` en desarrollo), porque el enlace apunta a la
**interfaz** y no a esta API, que respondería JSON a una persona que espera un
formulario. `SMTP_HOST`, `SMTP_PORT` y `SMTP_FROM` ya estaban declaradas y
siguen siendo opcionales (AU-029).

Dos cosas comprobadas contra el código antes de escribir esto, para que nadie
las re-implemente:

- **Un rol desactivado ya no concede nada.** `role-permission.registry.ts`
  excluye `active: false` **en la consulta**, no filtrando después, y lo
  explica: filtrar a posteriori es un paso que alguien puede olvidarse.
- **Revocar surte efecto en segundos.** El token lleva sólo los roles y los
  permisos se resuelven por petición con caché corta, que es lo que hace
  cumplible AU-032 sin cerrar la sesión de nadie.

> **El matiz de AU-032, comprobado al construirlo (13-08-2026).** «Sin
> reiniciar la sesión» se cumple exactamente en la mitad que importa y conviene
> tenerlo escrito: **cambiar qué permisos lleva un rol** alcanza al token que ya
> está en el navegador, en la petición inmediatamente siguiente, porque el guard
> resuelve los permisos por petición y la administración invalida la caché al
> guardar. **Conceder un rol NUEVO** no, porque el token lleva *qué roles* tiene
> el portador: llega en cuanto la sesión rota —sin volver a teclear la
> contraseña, que es lo que «sin reiniciar la sesión» significa para quien lo
> usa— y como muy tarde al caducar el token de acceso. Hacerlo inmediato
> exigiría consultar las concesiones en cada petición, que es justo el coste que
> `role-permission.registry.ts` documenta haber evitado. Las dos mitades tienen
> prueba de integración con ese nombre.
