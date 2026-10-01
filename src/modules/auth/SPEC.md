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

**Cubre:** AU-001 a AU-012, AU-039 a AU-041, AU-043, AU-044.

**Solo servidor:** AU-001, AU-003, AU-012, AU-039, AU-041, AU-043. Cómo se hashea una
contraseña no se ve; el bloqueo por intentos responde a la pantalla lo MISMO
que una contraseña incorrecta —eso es AU-002, y contarlo aparte lo delataría—;
«por petición y no dentro del token» es una propiedad del servidor que un
navegador no puede observar. La gracia de AU-039 es **transparente** para la
interfaz por diseño: el cliente reintenta con la cookie que tenga y la sesión
sigue, así que lo único que una pantalla puede enseñar es que no pasó nada.
AU-041 es el orden de dos transacciones de la base, y un inicio de sesión que
pierde esa carrera responde lo mismo que una contraseña incorrecta (AU-002). AU-043
es la hora a la que el servidor fija la caducidad: un recorrido no controla
el reloj de la API, así que se prueba contra PostgreSQL con el reloj de la
aplicación controlado; la pantalla de esa caducidad es la de AU-040.

### A2 — Administración de cuentas, roles y permisos _(P1)_

Un administrador da de alta a una persona, le asigna roles —con su sede— y
ajusta qué permisos lleva cada rol, sin desplegar código.

**Por qué es P1:** D-012 dejó la mitad del problema resuelto —un permiso nuevo
llega al administrador— pero moverlo a otro rol, o dar de alta a la recepcionista
que entra el lunes, sigue exigiendo tocar la base de datos a mano.
**Prueba independiente:** crear una cuenta, concederle un rol en una sede, y
comprobar que sus permisos efectivos cambian **sin reiniciar** y que la
concesión aparece en la bitácora.
**Cubre:** AU-020 a AU-034, AU-038, AU-042, AU-045.

**Solo servidor:** AU-025, AU-026, AU-027, AU-038 y AU-042. Los dos primeros son
bitácora y el plazo de caducidad definido en un único sitio; AU-027 es un
índice único parcial. La pantalla no puede enseñar ninguno: por AU-028, un
enlace caducado, gastado o inventado responden lo mismo. AU-038 es alcance por
sede sobre una escritura, y quien escala privilegios no usa la pantalla.
AU-042 ocurre al desplegar, no desde una pantalla.

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

### A4 — Recuperar el segundo factor _(P1, 13-08-2026)_

Quien pierde el teléfono vuelve a entrar: con sus códigos de respaldo si los
guardó, y si no, pidiéndole a alguien con permiso explícito que le retire el
segundo factor para volver a matricularlo.

**Por qué es P1:** hoy no hay ninguna de las dos salidas más que un administrador
tocando la base a mano, y eso sobre un sistema que un médico usa para firmar es
una interrupción asistencial, no una incidencia de soporte.
**Prueba independiente:** reiniciar el segundo factor de una cuenta desde otra
que tenga el permiso, comprobar que la primera puede volver a matricularlo, que
sus sesiones se cerraron, y que el reinicio aparece en la bitácora con autor y
sujeto. Y, para AU-037: cambiar el propio segundo factor presentando un código
del actual, comprobar que el lote de respaldo se renueva, que las sesiones
**siguen abiertas**, y que dejar el cambio a medias deja el factor viejo
funcionando.
**Cubre:** AU-035, AU-036, AU-037.

**Solo servidor:** AU-036. Cerrar las sesiones de OTRA persona no se observa
desde la pantalla de quien reinicia; se comprueba contra la base.

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
  refrescos de un solo uso que rotan en cada renovación; y SI se presenta un
  refresco ya usado fuera de la excepción de AU-039, ENTONCES DEBERÁ invalidar
  toda la familia de ese refresco —la sesión entera de la que desciende, con
  motivo `REUSE`— y responder `REFRESH_TOKEN_REUSE_DETECTED`.

  > **Afinado el 30-09-2026** (`fix/auth-refresh-gracia`). Decía «SI un
  > refresco se reutiliza», sin excepción, y el código lo cumplía al pie de la
  > letra: una renovación cuya respuesta se perdía —recarga en el peor
  > momento, red que se cae— dejaba al navegador con el refresco viejo y el
  > siguiente intento cerraba la sesión de alguien que no había hecho nada. La
  > excepción es AU-039 y está escrita ahí, no escondida en el código.
  > «La familia» es **la de ese refresco**, no todas las sesiones de la cuenta:
  > las otras sesiones de la persona no tienen ninguna copia comprometida.
- **AU-039** — CUANDO se presente un refresco ya usado cuya familia siga
  abierta, que sea **el último usado de su familia**, que se usara hace
  **`JWT_REFRESH_REUSE_GRACE_SECONDS` segundos o menos** y que llegue con el
  **mismo agente de usuario** que lo recibió, el sistema DEBERÁ emitir un
  refresco nuevo de esa misma familia, **retirar con motivo `SUPERSEDED` el
  sucesor que emitió la renovación cuya respuesta se perdió**, y responder como
  una renovación normal; y NO DEBERÁ mover el instante de uso del refresco
  presentado, de modo que la ventana no se alargue repitiéndolo. SI falta
  cualquiera de esas cuatro condiciones, ENTONCES rige AU-004. SI después se
  presenta un sucesor retirado así, ENTONCES rige AU-004: la respuesta sí llegó
  a alguien, y hay dos portadores de la misma sesión. Una familia ya revocada
  —cierre de sesión, cambio de contraseña, AU-023, AU-036, o AU-004— NO DEBERÁ
  reabrirse por esta vía, **tampoco cuando la revocación y la renovación
  llegan a la vez**.

  > **QUÉ RESUELVE.** El servidor rota el refresco, la respuesta con la cookie
  > nueva no llega al navegador y éste vuelve a presentar el viejo. Visto desde
  > el servidor es idéntico a un robo; visto desde el mostrador es una
  > recepcionista a la que se le cierra la sesión sin motivo. La interfaz ya
  > comparte una sola renovación entre las peticiones que reciben 401 a la vez
  > (`clinica-web/app/shared/api/client.ts`), así que esto no es la carrera de
  > pestañas: es la respuesta perdida.
  >
  > **DE DÓNDE SALE, CON LA FUENTE.**
  > - *RFC 9700 (OAuth 2.0 Security BCP), §4.14.2*: para clientes públicos la
  >   rotación con detección de reúso es obligatoria —o el refresco atado al
  >   emisor— y, detectado el reúso, se revoca el refresco activo aunque eso
  >   obligue al cliente legítimo a autenticarse de nuevo. **No trata la
  >   respuesta perdida ni ninguna ventana de gracia**: ni la prohíbe ni la
  >   exige.
  > - *Auth0, «Configure Refresh Token Rotation»*: «Rotation Overlap Period»
  >   (`leeway`, en segundos), **desactivado por defecto**; dentro de él no se
  >   aplica la detección y **se emite un refresco rotatorio nuevo**, y **sólo
  >   vale el inmediatamente anterior**: presentar el penúltimo dispara la
  >   detección.
  > - *Okta, «Refresh access tokens and rotate refresh tokens»*: «Grace period
  >   for token rotation», **30 s por defecto, configurable de 0 a 60**, con el
  >   mismo caso como motivo: los tokens nuevos pueden no llegar al cliente.
  >
  > **QUÉ SE TOMÓ DE CADA UNO.** De Auth0, que dentro de la ventana se emite un
  > refresco **nuevo** —devolver «el mismo sucesor» es imposible aquí, porque
  > de cada refresco sólo se guarda su SHA-256— y que **sólo vale el último
  > usado**: si su sucesor ya se usó, alguien siguió adelante con la sesión y
  > el viejo vuelve a ser un incidente. De Okta, el tamaño: **30 s por
  > defecto, con techo de 60**, que es la única cifra con fuente de las tres;
  > `0` desactiva la gracia y deja AU-004 tal como era. Añadido aquí y en
  > ninguna de las tres fuentes: **el mismo agente de usuario**, para que el
  > viejo presentado desde otro cliente siga revocando. No es una atadura
  > criptográfica —un ladrón puede copiar la cabecera—; es lo que impide que un
  > script con la cookie robada caiga en la ventana por accidente. La IP no se
  > compara: cambia en un portátil que pasa de la wifi al cable, y el caso que
  > se arregla es justamente la red que falla.
  >
  > **POR QUÉ SE RETIRA EL SUCESOR, que ni Auth0 ni Okta dicen hacer.** Si la
  > gracia sólo emitiera otro refresco, la familia quedaría con **dos ramas
  > vivas**, y la detección de AU-004 depende de que alguien vuelva a
  > presentar un token gastado: con dos ramas, el ladrón que rotó primero con
  > la copia robada sigue por la suya, el dueño por la otra, y nadie vuelve a
  > presentar nada gastado nunca. La alarma no sonaría jamás. Retirando el
  > sucesor, la familia vuelve a tener **una sola cabeza** y el ladrón, la
  > próxima vez que use la suya, presenta un retirado: AU-004, familia
  > revocada. Identificarlo no necesita esquema nuevo: como el presentado es
  > el último usado de su familia, las filas de la familia sin usar y sin
  > revocar son exactamente sus sucesores.
  >
  > **LO QUE CUESTA, dicho.** Dentro de la ventana, una copia robada del
  > refresco recién usado con el mismo agente de usuario obtiene una sesión sin
  > disparar la alarma **en ese momento**; la dispara el primer uso del
  > sucesor que se le retire al otro portador, o cualquier reúso pasada la
  > ventana. Es la concesión de Auth0 y Okta. **Lo acotado a segundos es la
  > ventana para entrar, no la alarma**: si quien pierde su sucesor es el
  > dueño y cierra el navegador al acabar el turno, la alarma suena cuando
  > vuelva y renueve —puede ser días después—, y hasta entonces la otra rama
  > vive. **Como mucho hasta el tope de vida de la familia (AU-040).** Y si dos
  > pestañas renuevan a la vez con el mismo refresco y el navegador se queda
  > con la cookie del sucesor retirado —las respuestas llegaron en el orden
  > inverso—, la siguiente renovación es AU-004: el mismo cierre que hoy
  > ocurre **siempre** en esa carrera, ahora sólo en su peor orden.
  >
  > **UNA REVOCACIÓN SIMULTÁNEA NO SE ESCAPA.** Renovar es reclamar un refresco
  > y emitir su sucesor; si un cierre de sesión se confirmaba entre las dos
  > sentencias, el sucesor nacía vivo en una familia revocada y la reabría —el
  > guardia de AU-036 la daba por abierta—. Pasaba ya con la rotación normal y
  > la gracia es un camino más de emisión. Desde esta entrega, renovar
  > (normal o por gracia) es **una transacción**, y **los cinco caminos que
  > cierran sesiones** —cierre de sesión, desactivación (AU-023), cambio de
  > contraseña, reinicio del segundo factor (AU-036) y canje de una invitación
  > de credencial— pasan por una sola función, `revokeLiveSessions`, que
  > bloquea primero las filas vivas (de la más antigua a la más nueva) y
  > actualiza después, con una lectura nueva que ya ve cualquier sucesor
  > confirmado mientras esperaba. La revisión en contexto limpio encontró que
  > tres de esos cinco revocaban por su cuenta con un `UPDATE` único.
  >
  > **LA GRACIA BLOQUEA LA FAMILIA ANTES DE COMPROBAR NADA.** Si sólo
  > bloqueara el refresco presentado, una rotación de su sucesor en curso
  > seguiría invisible para la comprobación, el sucesor parecería sin usar y
  > la familia acabaría con dos cabezas. Bloqueando la familia en el mismo
  > orden que las revocaciones, las cuatro condiciones se leen después, con
  > todo lo confirmado a la vista, y no hay interbloqueo posible.
  >
  > **LA VENTANA SE MIDE CON EL RELOJ DE LA APLICACIÓN**, el mismo que escribe
  > `used_at`. Con una sola instancia es exacto; con varias, un desfase entre
  > relojes la estira o la acorta en esa medida.
  >
  > **CÓMO SE VE.** Una renovación por gracia deja un aviso en el registro
  > (`REFRESH_TOKEN_REUSE_GRACE`) con la cuenta y la familia —nunca el token—, para cruzarlo con un reúso posterior;
  > un reúso fuera de ella sigue siendo el error de prioridad alta de siempre,
  > **salvo que la familia ya estuviera cerrada** —cierre de sesión, cambio de
  > contraseña, un incidente anterior—: entonces no había nada abierto que
  > tomar y queda como aviso (`REFRESH_TOKEN_AFTER_CLOSE`), para no enseñar al
  > responsable de seguridad a ignorar la alarma. La respuesta al cliente es
  > la misma en los dos casos.
  >
  > **ES UNA DECISIÓN DE RIESGO Y ESTÁ REGISTRADA** en `DECISIONES-PENDIENTES.md`
  > (D-063): tenerla activa por defecto, el tamaño, el agente de usuario como
  > condición y el alcance de «la familia» en AU-004. Lo que tiene fuente es la
  > cifra; aceptar el riesgo es del autor.
- **AU-040** — El sistema DEBERÁ fijar la caducidad de una familia de sesión
  al iniciar sesión, **`JWT_REFRESH_TTL_DAYS` días** después (7 por defecto,
  como mucho 7), y NO DEBERÁ alargarla al rotar un refresco, tampoco por
  AU-039. CUANDO se presente un refresco de una familia caducada, el sistema
  DEBERÁ responder `SESSION_EXPIRED` sin emitir ningún refresco, **también
  dentro de la ventana de AU-039**; y CUANDO llegue un token de acceso de una
  familia caducada, DEBERÁ responder `SESSION_EXPIRED` aunque el token no
  haya caducado. La interfaz DEBERÁ devolver a la persona a iniciar sesión
  diciéndole que su sesión caducó.

  > **DECIDIDO POR EL AUTOR** (D-063, punto 4, 30-09-2026): tope de vida
  > absoluto de **7 días desde el inicio de sesión**. Hasta aquí la caducidad
  > de 7 días se renovaba con cada rotación, así que una sesión usada a diario
  > no caducaba nunca, y la rama robada que AU-039 no detecta al momento vivía
  > lo mismo. Es lo que acota «lo acotado a segundos es la ventana para
  > entrar, no la alarma» de AU-039: como mucho vive hasta el tope.
  >
  > **CÓMO: EL SUCESOR HEREDA LA CADUCIDAD**, en vez de `ahora + 7 días`. Toda
  > la familia caduca a la vez y no hace falta columna: la reclamación
  > atómica y la gracia ya exigían `expires_at > ahora`, así que una familia
  > caducada no renueva **por construcción**.
  >
  > **CONFIGURABLE CON TECHO.** La misma variable, que ya valía 7, pasa a
  > significar vida absoluta. Una instalación puede **acortarla**, en días
  > enteros (1 como mínimo), y no alargar lo que decidió el autor: el esquema
  > de entorno rechaza más de 7 y no arranca. No hay además caducidad por inactividad:
  > con las dos en 7 días, la de inactividad no actuaría nunca.
  >
  > **EL GUARDIA TAMBIÉN LA VE.** Sin él, un token de acceso emitido el último
  > minuto seguiría valiendo `JWT_ACCESS_TTL` más allá del tope. El guardia de
  > AU-036 distingue ya tres estados de la familia —abierta, revocada,
  > **caducada** (la última caducidad de sus filas vivas ya pasó)— con la
  > misma consulta indexada.
  >
  > **`SESSION_EXPIRED` Y NO `INVALID_REFRESH_TOKEN` NI `SESSION_REVOKED`**:
  > la frase de éste («se cerró porque cambiaron su contraseña») sería
  > mentira, y la de aquél se lee como sistema roto. Decir «caducó» no filtra
  > nada: quien lo lee tiene el token en la mano. Una familia caducada **no se
  > revoca ni da la alarma de reúso** aunque el refresco presentado estuviera
  > usado: no queda nada abierto que tomar. Eso queda como aviso
  > (`REFRESH_TOKEN_AFTER_EXPIRY`, con su propio `error_code` para poder
  > alertar sobre él: el navegador legítimo no presenta un refresco usado de
  > una familia caducada), igual que `REFRESH_TOKEN_AFTER_CLOSE`.
  >
  > **«CADUCADA» SE DECIDE POR LA FAMILIA, NO POR LA FILA.** Las familias
  > anteriores a AU-040 tienen una caducidad por fila: un refresco usado puede
  > haber caducado con su sucesor aún vivo, y presentarlo es AU-004, no una
  > sesión caducada.
  >
  > **LA COOKIE DURA UN DÍA MÁS QUE LA FAMILIA.** Si caducaran a la vez, el
  > navegador dejaría de enviarla justo al llegar el tope, la API sólo podría
  > contestar «no hay cookie» y nadie sabría que la sesión caducó. El servidor
  > sigue rechazando por la fila; la cookie sólo le deja decir por qué. Cuando
  > se programe la purga de refrescos, tiene que conservar las filas ese mismo
  > día de margen.
  >
  > **LO QUE PASA EN PANTALLA.** Hasta AU-043 el corte caía a la misma hora
  > en que se inició sesión, así que a menudo en plena consulta; sigue
  > pudiendo caer con una pantalla abierta de madrugada. La interfaz **no saca a nadie
  > de la pantalla** por `SESSION_EXPIRED`: primero intenta una renovación
  > (otra pestaña puede haber vuelto a entrar ya) y, si no, pide volver a
  > entrar **en un diálogo encima**, con la misma cuenta, y reintenta lo que
  > se estaba guardando. El corte cae a las 03:00 de la clínica (AU-043) y el
  > diálogo no queda abierto más de 15 minutos (AU-044).
- **AU-041** — CUANDO se cierren todas las sesiones de una cuenta —cambio de
  contraseña, AU-023, AU-036 o canje de una invitación— mientras un inicio de
  sesión de esa cuenta está en curso, el sistema NO DEBERÁ dejar abierta la
  sesión que ese inicio emita: o no la emite y responde como AU-002, o la
  emite antes y el cierre la alcanza.

  > **LA CARRERA.** Iniciar sesión es leer la cuenta, gastar ~100 ms de
  > Argon2 y emitir la familia. Un cierre de todas las sesiones confirmado en
  > medio no veía la familia, porque aún no existía, y ésta nacía viva
  > **después** del acto que existía para cerrarla. La encontró la revisión
  > de `fix/auth-refresh-gracia`.
  >
  > **CÓMO: UNA ÉPOCA DE SESIONES EN `app_user`.** `revokeLiveSessions` la
  > incrementa **como primera sentencia** cada vez que cierra todas las
  > sesiones de una cuenta, así que ningún camino tiene que acordarse: los
  > cuatro pasan por ahí. El inicio de sesión lee la época con las
  > credenciales y emite la familia en una transacción que bloquea la cuenta
  > `FOR SHARE` y compara. Si cambió, no emite. Si no, el bloqueo compartido
  > hace esperar el incremento de una revocación que llegue después hasta que
  > la familia esté confirmada, y el `UPDATE` que revoca —que va detrás— la
  > ve. Incrementar después de revocar la dejaría viva: la prueba lo comprueba.
  >
  > **UN CONTADOR, NO UN INSTANTE**: la comparación es de igualdad, y un
  > contador no tiene empates de reloj ni depende de que `now()` sea el
  > inicio de la transacción.
  >
  > **EL DESAFÍO DEL SEGUNDO FACTOR LLEVA LA ÉPOCA.** Entre la contraseña y
  > el código pueden pasar minutos, y el desafío no tiene fila que revocar. La
  > época leída con la contraseña viaja en el token de desafío (`sep`), y la
  > sesión se emite contra ESA, no contra la que se lee al completar el
  > código: cerrar todas las sesiones en medio anula el desafío. Además, una
  > cuenta inactiva no completa el segundo factor. **Y el guardia lo comprueba
  > en cada ruta del desafío**, no sólo al completar el código: un desafío
  > anterior a un reinicio del segundo factor ya no llega a `mfa/enroll`, donde
  > quien tuviera la contraseña sin el teléfono podía matricular su propio
  > autenticador en la cuenta que soporte acababa de devolver. El código se
  > comprueba después: un desafío anulado no gasta un código de respaldo. La revisión en contexto
  > limpio encontró que, sin esto, una cuenta dada de baja con el desafío en
  > la mano obtenía una sesión completa con su propio teléfono.
  >
  > **EL REHASH NO PISA UNA CONTRASEÑA NUEVA.** El inicio de sesión que rehace
  > el hash con parámetros más fuertes sólo escribe si el hash sigue siendo el
  > que comprobó; sin condición, un cambio de contraseña confirmado en medio
  > se sobrescribía con un hash de la vieja, que volvía a valer.
- **AU-043** — CUANDO se inicie sesión, el sistema DEBERÁ fijar la caducidad
  de la familia en **la última vez que el reloj de `America/Guayaquil` marque
  las 03:00** no más tarde de `JWT_REFRESH_TTL_DAYS` días desde el inicio de
  sesión. NO DEBERÁ fijarla nunca después de esos días contados al segundo, y
  la caducidad así fijada es la de AU-040 a todos los efectos: se hereda, no se
  alarga y la ve el guardia.

  > **DECIDIDO POR EL AUTOR** (D-065, opción B, 30-09-2026; la hora, las
  > 03:00, el mismo día). Con el tope contado al segundo, quien entra el lunes
  > a las 08:10 perdía la sesión el lunes siguiente a las 08:10, en plena
  > consulta, cada semana. Alineado, la pierde ese lunes a las 03:00, con la
  > clínica cerrada.
  >
  > **SE ADELANTA, NUNCA SE RETRASA.** Se toma la madrugada anterior al tope,
  > no la siguiente: el tope de D-063 es un máximo y no se alarga. La vida real
  > queda entre `JWT_REFRESH_TTL_DAYS − 1` días y `JWT_REFRESH_TTL_DAYS` días
  > (con 7, entre 6 y 7). Quien entra a las 02:00 del lunes pierde la sesión el
  > domingo a las 03:00, seis días y una hora después. Exactamente a las 03:00
  > el corte cae a los 7 días justos.
  >
  > **LO QUE CUESTA CON UN TOPE CORTO.** Una instalación que acorte la variable
  > a 1 día obtiene sesiones de entre 0 y 24 horas: quien entra a las 02:59
  > la pierde al minuto. No hay ninguna configurada así; si alguna lo pide, el
  > mínimo útil es una decisión de operación, no de este requisito.
  >
  > **LA HORA, EN LA CLÍNICA Y NO EN EL SERVIDOR.** Se calcula con
  > `America/Guayaquil` sea cual sea el huso de la máquina (REQ-160). Ecuador
  > no cambia de hora; la conversión es la de `clinic-time.ts`, que lo
  > resolvería igual si cambiara.
  >
  > **LAS LLEGADAS DE LA MAÑANA DEL DÍA 7.** Todas las sesiones de la semana
  > caen a las 03:00, así que la mañana siguiente varias personas vuelven a
  > entrar casi a la vez desde la misma IP de la clínica. El tope de 10
  > intentos por minuto por IP no cambia aquí; queda anotado en la segunda
  > revisión de D-065, en `DECISIONES-PENDIENTES.md`.
  >
  > **LA HORA ES FIJA.** No mira el horario de cada sede: una con atención de
  > madrugada cortaría en consulta. Queda para el autor en D-094.
- **AU-044** — MIENTRAS el diálogo de volver a entrar de AU-040 esté abierto,
  CUANDO lleve **15 minutos** abierto sin que la misma persona haya vuelto a
  entrar, la interfaz DEBERÁ terminar la sesión, quitar de la pantalla todo lo
  cargado para esa persona y llevarla a iniciar sesión con el aviso «Su sesión
  se cerró por seguridad. Lo que no estaba guardado se perdió.».

  > **DECIDIDO POR EL AUTOR** (D-065, segunda revisión, 30-09-2026; el texto,
  > el mismo día). Detrás del diálogo la pantalla del paciente sigue visible,
  > desenfocada, sin límite de tiempo: en un consultorio vacío es la historia
  > clínica de alguien a la vista de quien entre.
  >
  > **SE MIDE CON EL RELOJ DE PARED, NO CON UN TEMPORIZADOR.** Un portátil
  > que se suspende detiene los temporizadores del navegador; al despertar
  > una hora después, un `setTimeout` de 15 minutos aún esperaría. Se fija el
  > instante límite al abrir el diálogo y se compara con la hora actual a
  > intervalos cortos y al volver la pestaña a primer plano.
  >
  > **LIMPIAR ES RECARGAR.** Termina igual que «Salir de todos modos»: el
  > mismo camino de AU-040 que borra la sesión y navega a `/acceso` con una
  > recarga completa, que tira la caché con el paciente en pantalla. Lo único
  > distinto es el aviso, que viaja como código (`motivo=sin-respuesta`),
  > nunca como frase.
  >
  > **SÓLO INTERFAZ.** La familia ya había caducado en el servidor; lo que
  > queda abierto es la pantalla.
  >
  > **LO QUE AU-044 NO CUBRE.** El diálogo lo abre una petición que recibe
  > `SESSION_EXPIRED`. Una pantalla que no consulta nada por sí sola —una
  > atención abierta en un consultorio vacío— no abre el diálogo hasta que
  > alguien la toque, así que el límite no empieza a contar. Cubrirlo exige
  > que la interfaz conozca la caducidad de la familia (cambio de contrato) o
  > un bloqueo por inactividad: decisión del autor, D-094.
  >
  > **UNA ENTRADA EN VUELO AL CUMPLIRSE LOS 15 MINUTOS.** Si la contraseña se
  > envió justo antes y la respuesta llega después, la pantalla ya se limpió;
  > la sesión nueva —de la misma cuenta, que acreditó su contraseña— queda y
  > la recarga entra con ella. Lo escrito se perdió igualmente, como dice el
  > aviso.
- **AU-005** — El sistema DEBERÁ permitir matricular un segundo factor TOTP con
  códigos de respaldo, y DEBERÁ cifrar el secreto en la aplicación (ADR-008 §3).

  > **Completo.** El TOTP —matrícula, confirmación, secreto cifrado con clave
  > propia, rechazo de un código repetido y de uno anterior al último
  > consumido— está probado en `totp.service.spec.ts` y
  > `mfa-enrolment.service.spec.ts`. Los **códigos de respaldo**, que faltaban
  > enteros, están en `domain/backup-code.ts` y probados en
  > `backup-code.spec.ts`, `auth.service.spec.ts` y, contra PostgreSQL, en
  > `test/integration/mfa-backup-codes.spec.ts`.
  >
  > Lo que el sistema entrega, para que la interfaz no lo adivine: **diez
  > códigos** de **diez símbolos** en alfabeto Crockford base32, mostrados como
  > `ABCDE-FGHJK`, **50 bits** cada uno. `POST /auth/mfa/confirm` responde
  > **200 con el lote** —antes 204— y es **la única vez que se envían**: solo
  > se guarda su hash Argon2id, como el de una contraseña, porque un código de
  > respaldo es una credencial. **Solo se confirma una vez**: habilitar el
  > factor y guardar el lote son una única operación condicional
  > (`UPDATE … WHERE mfa_enabled_at IS NULL`), así que un doble envío del
  > formulario —que llega con el mismo TOTP y lo supera dos veces— recibe
  > `MFA_ALREADY_ENROLLED` en la segunda y **nunca** deja dos lotes vivos.
  > `POST /auth/mfa/verify` acepta el TOTP o uno de
  > ellos, **de un solo uso** (`UPDATE … WHERE used_at IS NULL`: quien gana lo
  > decide la base), y un código de respaldo incorrecto responde y cuenta para
  > el bloqueo **exactamente igual** que un TOTP incorrecto — distinguirlos
  > diría si la cuenta tiene códigos vivos.
  >
  > **Sigue sin haber forma de regenerar el lote** sin volver a matricular el
  > segundo factor. Quien gaste los diez vuelve a depender de un
  > administrador; una ruta de regeneración es trabajo aparte, no AU-005.
  >
  > **LA SESIÓN DICE SI LA CUENTA YA TIENE UNO** (14-08-2026). Las tres
  > respuestas de sesión —`POST /auth/login`, `POST /auth/refresh` y
  > `POST /auth/mfa/verify`— llevan `mfaEnabled`. **Un booleano y nada más**:
  > ni el secreto, ni el instante de matrícula, ni el último paso consumido,
  > ni cuántos códigos de respaldo quedan — ese número diría lo cerca que está
  > esa cuenta de quedarse fuera del expediente. Vale `mfaEnabledAt IS NOT
  > NULL`, que es la misma condición con la que se guarda la matrícula, así
  > que «falso» significa que matricular será aceptado.
  >
  > **POR QUÉ NO BASTABA CON `UserAccountDto`.** Saber si la PROPIA cuenta tiene
  > segundo factor es un dato de uno mismo y no exige ningún permiso, pero el
  > único sitio donde viajaba era `GET /auth/users` —administración, con
  > `user:read` sobre toda la plantilla—. Sin el campo, `/mi-cuenta` tenía que
  > ofrecer «matricular» (AU-005) y «cambiar de dispositivo» (AU-037) a la vez
  > sin saber cuál de las dos correspondía, y **una de las dos estaba
  > garantizado que fallaba**: `MFA_ALREADY_ENROLLED` o `MFA_NOT_ENROLLED`.
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

- **AU-045** — CUANDO se guarden los permisos de un rol que lleve
  `prescription:write` o `record:write` y NO lleve `background:write`, el
  sistema DEBERÁ advertirlo sin impedirlo, con «Este rol receta o escribe en
  la historia clínica pero no puede registrar alergias ni antecedentes. Puede
  guardarlo igualmente.»; y la descripción de `background:write` en el
  catálogo DEBERÁ ser «Registrar alergias y antecedentes del paciente. Sin él
  no se registran alergias ni antecedentes».

  > **DECIDIDO POR EL AUTOR** (D-071, A con el texto de B, 30-09-2026; los
  > textos, el mismo día). AU-042 concedió `background:write` una sola vez a
  > los roles que ya existían. Un rol propio creado después —«MÉDICO
  > ESPECIALISTA» con `record:write` y `prescription:write`— receta
  > amoxicilina y recibe un 403 al anotar que el paciente es alérgico a la
  > penicilina.
  >
  > **COMO AU-034, EN EL MISMO SITIO.** La advertencia viaja en el 200 del
  > guardado y la pantalla la pinta después de confirmar que se guardó. No
  > se impide: una clínica puede tener un rol que recete y que no deba
  > registrar antecedentes, y la decisión es suya.
  >
  > **`record:sign` SOLO NO AVISA.** Firmar no escribe: el hueco es de quien
  > receta o escribe la nota, que es quien está delante de la alergia.
  > `nursing:write` tampoco, **por ahora**: D-071 nombra el caso de un rol
  > propio de enfermería sin el registro de alergias y su decisión no lo
  > resuelve. Si también debe advertir lo decide el autor (D-094); entretanto,
  > la descripción del permiso lo dice.

- **AU-038** — CUANDO se fijen los roles de una cuenta, el sistema NO DEBERÁ
  admitir ninguna concesión cuyo alcance esté fuera del alcance de quien llama
  —ni las que se fijan ni las que se reemplazan—; y MIENTRAS la concesión sea
  **global** (`siteId` nulo, que es toda sede presente y futura), sólo DEBERÁ
  admitirla de quien tenga `user:manage` concedido a nivel de clínica. SI no se
  cumple, ENTONCES DEBERÁ rechazarlo con `SITE_SCOPE_DENIED` sin escribir nada y
  sin nombrar ninguna sede.
  > **D-023, opción A, decidida por el usuario el 15-08-2026.** «Un administrador
  > acotado a una sede sólo concede roles dentro de su alcance; el rol global lo
  > concede quien tiene `user:manage` global», que es lo que el resto del sistema
  > ya hace con la sede. Se descartaron **B** (prohibir `user:manage` acotado,
  > que quita la delegación por ciudad) y **C** (dejarlo como estaba).
  >
  > **ESTO NO ERA UNA SEDE DE MÁS: ERA ESCALADA DE PRIVILEGIOS.** La ruta declara
  > `global` y `grants[].siteId` viaja **en el cuerpo**, donde el guard no mira
  > —sólo sabe leer `param:` y `query`, porque corre antes de los pipes—. Quien
  > tuviera `user:manage` acotado a una sede podía conceder a otra cuenta un rol
  > con `siteId: null`, y a partir de ahí el alcance por sede deja de significar
  > nada **en todo el sistema**: es la única dimensión que produce acceso
  > indebido en una clínica multisede, y se anulaba con un campo del cuerpo.
  > Concedérselo a sí mismo ya lo impedía `CANNOT_GRANT_TO_SELF`
  > (`user_role_grant_no_self_grant`); hacerlo a una segunda cuenta, no.
  >
  > **Los dos extremos, como ST-047.** El `PUT` fija el conjunto entero: enviar
  > sólo las concesiones de la sede propia **revocaría en silencio** las de otra
  > sede, y dejar sin rol a la recepción de otra ciudad es tan suyo como
  > dárselo. Por eso se juzgan las concesiones que se fijan y las que se
  > reemplazan, y la consecuencia deliberada es que un alcance de una sede no
  > administra los roles de quien también los tiene fuera de él: eso es de la
  > dirección.
  >
  > **La concesión global sigue pudiéndolo todo.** `user:manage` con
  > `site_id IS NULL` —lo que `DEFAULT_ROLES` da a ADMIN— concede cualquier rol
  > en cualquier sede y el rol global. Lo que esto cierra es exactamente el caso
  > que nadie había decidido.
  >
  > **Lo que NO cambia.** `GET /users/:id/roles` sigue siendo `global`: leer qué
  > roles tiene una cuenta no escala nada, y esconder la mitad de sus
  > concesiones haría que la pantalla guardara un conjunto incompleto — que es
  > justo el borrado silencioso que este requisito impide.

- **AU-042** — CUANDO se sincronicen los permisos (`syncAuthorisation`) y la
  base no haya recibido todavía esta concesión, el sistema DEBERÁ conceder
  `background:write` a **todo** rol que tenga `record:write` —del sistema o
  propio de la clínica—, y DEBERÁ hacerlo **una sola vez por base**: un rol al
  que después se le quite NO DEBERÁ recuperarlo en ninguna sincronización
  posterior. DEBERÁ informar en la salida de qué roles lo recibieron.
  > **D-062, punto 2, consecuencia técnica (resuelta el 30-09-2026).** Registrar
  > alergias y antecedentes pasó de `record:write` a `background:write` en
  > `feat/f03-preparacion` (EN-164). D-012 sólo reparte un código **nuevo**, y
  > sólo a los roles **del sistema**: un rol propio que registraba alergias
  > perdió ese registro al desplegar. El argumento de D-012 —«nadie pudo
  > revocar un código que no existía»— cubre también esto: tener
  > `record:write` ya era registrar alergias.
  >
  > **Por qué una fila y no la regla de D-012.** `background:write` ya existe
  > en toda base sincronizada desde aquella rama, así que para D-012 no es
  > nuevo. Y repartirlo en cada sincronización devolvería lo que una clínica
  > quitó, que es lo que D-012 prohíbe. «Una vez» lo recuerda
  > `authorisation_one_off`, escrita en la misma transacción que la concesión.
  >
  > **Lo que no cambia:** la tercera regla de D-012 sigue siendo estrecha; esto
  > no la amplía, es una concesión fechada con su propia memoria.
  >
  > **Lo que cuesta:** la **primera** sincronización no distingue «nunca lo
  > tuvo» de «se lo quitaron» antes de que existiera la fila. Un rol que
  > recibió `background:write` por D-012 y lo perdió a mano entre
  > `feat/f03-preparacion` y este despliegue lo recupera una vez. Ninguna
  > instalación fuera de desarrollo corrió aquella rama.
  >
  > **Lo que no cubre:** un rol propio creado **después** con `record:write` y
  > sin `background:write` no lo recibe: la concesión ya se hizo. Qué hacer con
  > él es D-071.

### Recuperación del segundo factor (REQ-154, D-014)

- **AU-035** — CUANDO quien tenga el permiso `user:reset-mfa` lo pida sobre otra
  cuenta, el sistema DEBERÁ retirarle el segundo factor y sus códigos de
  respaldo, de modo que pueda volver a matricularlo; y DEBERÁ registrarlo en la
  bitácora con autor, sujeto e instante. El permiso NO DEBERÁ venir concedido a
  ningún rol de fábrica.

  > **POR QUÉ ES UN PERMISO PROPIO Y NO PARTE DE `user:manage`.** Quien reinicia
  > el segundo factor de un médico le quita la única barrera que queda entre una
  > contraseña y su firma. Si además puede invitarle de nuevo (AU-021), puede
  > entrar como él y firmar en su nombre: el no repudio de la bitácora —que es
  > la evidencia principal ante la SPDP (REQ-110)— se apoya en que eso no ocurra
  > por herencia. Por eso la instalación tiene que **concederlo explícitamente a
  > alguien**, como cualquier permiso de riesgo, en vez de que aparezca
  > encendido dentro del rol de administración (decisión del usuario, D-014).
  >
  > **POR QUÉ EXISTE.** Sin él, quien pierde el teléfono y los códigos depende
  > de un administrador tocando la base a mano. La revisión adversarial del
  > 13-08-2026 lo agravó: como los códigos se entregan una sola vez y no hay
  > regeneración, **perder la respuesta HTTP de `mfa/confirm` deja la cuenta con
  > segundo factor y diez códigos que nadie vio**. Un corte de red bastaba para
  > dejar fuera a un médico.
  >
  > **NO ES UN CAMBIO DE CONTRASEÑA.** Retira el factor y nada más: la persona
  > sigue necesitando su contraseña para entrar, y vuelve a matricular el
  > segundo factor ella misma. Quien reinicia nunca conoce ninguna credencial.
- **AU-036** — CUANDO se reinicie el segundo factor de una cuenta, el sistema
  DEBERÁ invalidar sus sesiones abiertas, por la misma razón que AU-023: si el
  factor deja de valer, las sesiones que se abrieron gracias a él tampoco.

  > **UNA SESIÓN ABIERTA SON DOS COSAS, Y AL PRINCIPIO SÓLO SE CERRABA UNA.**
  > La revisión adversarial del 13-08-2026 encontró que revocar la cadena de
  > refresco dejaba vivo el token de acceso —quince minutos por defecto— y que
  > `mfa/enroll` y `mfa/confirm` son alcanzables con él, porque por diseño no
  > comprueban permiso: quien no ha terminado de autenticarse es justo quien
  > está matriculando un factor. Como el reinicio deja la cuenta **sin
  > matricular a propósito**, quien tuviera la sesión anterior podía matricular
  > su propio autenticador en la cuenta recién devuelta y llevarse el lote de
  > códigos de respaldo. Desde entonces el guardia comprueba en cada petición
  > que la familia del token siga viva, así que la revocación cierra las dos
  > mitades; un token de una sesión cerrada responde `SESSION_REVOKED`.
  >
  > **VALE PARA TODA REVOCACIÓN, no sólo para ésta.** `PASSWORD_CHANGE` y
  > `ACCOUNT_DEACTIVATED` (AU-023) tenían la misma cola y la pierden por el
  > mismo cambio. La única excepción es el token de reto de segundo factor, que
  > no tiene fila de refresco por construcción: sólo abre el flujo de MFA y sólo
  > se obtiene presentando la contraseña.
- **AU-037** — CUANDO alguien con sesión completa pida cambiar su segundo factor
  y presente un código válido del factor **ACTUAL** —un TOTP o un código de
  respaldo, que se gasta—, el sistema DEBERÁ dejarle matricular uno nuevo; y
  CUANDO confirme el nuevo, DEBERÁ sustituir el secreto anterior y **emitir un
  lote de códigos de respaldo nuevo**, invalidando el viejo. Un intento con un
  código inválido DEBERÁ contar para el bloqueo igual que cualquier otro fallo
  del segundo factor (AU-003).

  > **NO ES UN REINICIO, Y POR ESO ES SEGURO.** Reiniciarse a uno mismo está
  > prohibido (`CANNOT_RESET_OWN_MFA`) porque la sesión completa ya prueba que
  > el factor funcionó: sólo serviría para que alguien con un portátil ajeno
  > desbloqueado retirase la protección. Esto exige **poseer justo lo que se va
  > a sustituir**, así que quien robó la sesión no puede hacerlo, y quien perdió
  > el teléfono tampoco — ése tiene AU-005 y AU-035.
  >
  > **POR QUÉ HACE FALTA.** Sin este camino, cambiar de teléfono —una tarea
  > rutinaria— obliga a pedirle a alguien el permiso `user:reset-mfa`. Y un
  > permiso de riesgo que se necesita a diario acaba concedido a media clínica,
  > que es exactamente lo que AU-035 existe para evitar (D-015).
  >
  > **EL SECRETO VIEJO SIGUE VALIENDO HASTA QUE SE CONFIRME EL NUEVO.** Si se
  > retirase al empezar, una rematrícula abandonada a la mitad —se cierra la
  > pestaña, falla el escaneo— dejaría a la persona sin ningún factor y sin
  > sesión con la que arreglarlo. Es el mismo fallo que la revisión adversarial
  > encontró en AU-005 con la respuesta perdida, y aquí se evita por diseño.
  >
  > **NO CIERRA LAS SESIONES**, a diferencia de AU-035: no hay nadie de quien
  > desconfiar — la persona acaba de demostrar que es ella.
  >
  > **CUÁNDO SE OFRECE ESTE CAMINO Y NO EL DE AU-005** lo decide el `mfaEnabled`
  > de la sesión, descrito en la nota de AU-005. La pantalla enseña **una sola**
  > de las dos acciones, nunca las dos.

---

## Códigos de error

| Código                     | HTTP | Cuándo                                                       |
| -------------------------- | ---- | ------------------------------------------------------------- |
| `EMAIL_ALREADY_REGISTERED` | 409  | Correo repetido al crear una cuenta (AU-020)                  |
| `USER_NOT_FOUND`           | 404  | La cuenta indicada no existe                                  |
| `CANNOT_DEMOTE_SELF`       | 422  | Un administrador se desactiva o se despoja a sí mismo (AU-024) |
| `CANNOT_GRANT_TO_SELF`     | 422  | Alguien se concede a sí mismo un rol                          |
| `CANNOT_RESET_OWN_MFA`     | 422  | Alguien reinicia su propio segundo factor (AU-035)            |
| `ROLE_CODE_DUPLICATE`      | 409  | Código de rol repetido (AU-030)                               |
| `ROLE_NOT_FOUND`           | 404  | El rol indicado no existe                                     |
| `ROLE_IN_USE`              | 409  | Borrar un rol con concesiones vivas (AU-031)                  |
| `SYSTEM_ROLE_PROTECTED`    | 422  | Borrar un rol del sistema (AU-031)                            |
| `UNKNOWN_PERMISSION`       | 422  | Conceder un permiso que el código no declara (AU-033)         |
| `PERMISSION_NOT_INSTALLED` | 409  | Conceder un permiso que el código SÍ declara y la tabla `permission` de esta instalación aún no tiene (AU-033) |
| `INVALID_CEDULA`           | 422  | Cédula del personal que no supera su dígito verificador (AU-020) |
| `INVALID_CREDENTIAL_TOKEN` | 422  | Enlace de primera credencial desconocido, usado o caducado (AU-028) |
| `MAIL_NOT_CONFIGURED`      | 502  | La instalación no tiene `SMTP_HOST` (AU-029)                  |
| `MAIL_DELIVERY_FAILED`     | 503  | El servidor de correo no aceptó el mensaje (AU-029)           |
| `MFA_CHANGE_NOT_STARTED`   | 409  | Confirmar un cambio de segundo factor que ya no está a medias (AU-037) |
| `SESSION_REVOKED`          | 401  | El token de acceso es de una sesión ya cerrada (AU-036, AU-023)        |
| `SESSION_EXPIRED`          | 401  | La sesión llegó a su tope de vida desde que se inició (AU-040)         |
| `SITE_SCOPE_DENIED`        | 403  | Conceder o revocar un rol fuera del alcance de quien llama, o uno global sin `user:manage` de clínica (AU-038, ADR-007) |

`INVALID_CREDENTIAL_TOKEN` es **uno solo para tres situaciones**, y eso es el
requisito y no una simplificación (AU-028). Es 422 y no 404 porque un 404 diría
«este token no existe», que es exactamente lo que no puede decirse; y porque
nada se buscó por cuenta de quien llama.

`UNKNOWN_PERMISSION` y `PERMISSION_NOT_INSTALLED` son **fallos opuestos y hay
que distinguirlos**. El primero es un código que el programa no declara: la
pantalla está desfasada y hay que recargarla. El segundo es un código que el
programa sí declara y que la tabla `permission` de esta instalación todavía no
tiene, porque la sincronización de autorización (`pnpm db:seed:auth`) no ha
corrido desde el despliegue que lo introdujo. Quien está en la pantalla no puede
arreglar el segundo, así que la frase le dice a quién avisar; salía como un
error genérico de base —«Datos inválidos», sobre un formulario donde nada era
inválido— y no nombraba el permiso.

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

Los de sesión —`INVALID_CREDENTIALS`, `ACCOUNT_INACTIVE`, `MFA_REQUIRED`,
`REFRESH_TOKEN_REUSE_DETECTED`— ya existen en `error-catalogue.ts` desde Fase 0
y no se tocan.

> **Dos de esos cuatro nombres estaban mal escritos aquí** (corregido el
> 18-08-2026). No es un detalle de redacción: un `code` es contrato público, y
> un documento que nombra `ACCOUNT_LOCKED` y `REFRESH_TOKEN_REUSE` describe dos
> códigos que **no existen** — el catálogo declara `ACCOUNT_INACTIVE` y
> `REFRESH_TOKEN_REUSE_DETECTED`. Peor en el primer caso: `ACCOUNT_LOCKED` **se
> retiró a propósito**, porque distinguir «bloqueada» de «inexistente» o
> «inactiva» enumera al personal de la clínica (AU-002). Escribirlo aquí como
> algo que «ya existe» es una invitación a devolverlo.

`MFA_CHANGE_NOT_STARTED` **lo fijó la implementación de AU-037**: es lo que se
responde a quien confirma un cambio de segundo factor que ya no está a medias.
**Un solo código para dos situaciones**, y a propósito: o nadie lo empezó —o el
secreto pendiente ya se canjeó— o se empezó otro cambio y esta confirmación
lleva un secreto que ya no existe. Para quien está delante son el mismo hecho y
tienen la misma salida: empezar de nuevo. No es `MFA_NOT_ENROLLED`, porque la
cuenta sí tiene un segundo factor —el viejo, que sigue funcionando, que es todo
el sentido de AU-037— y mandar al cliente a la pantalla de matrícula lo dejaría
entre dos errores, porque allí responde `MFA_ALREADY_ENROLLED`.

`SESSION_REVOKED` **lo fijó la revisión adversarial de A4** y es de sesión, no
de administración: es lo que responde cualquier ruta a un token de acceso cuya
familia ya se revocó —por AU-036, por un cambio de contraseña o por AU-023—
antes de que caduque solo. **No es `INVALID_TOKEN`**, y la diferencia importa en
las dos direcciones: aquél oculta su motivo porque separaría «caducado» de
«falsificado», y éste no oculta nada a quien tiene el token en la mano. Lo que
gana es que la interfaz mande a esa persona a iniciar sesión con la frase que
corresponde en lugar de un «no autenticado» que se lee como sistema roto.

`CANNOT_RESET_OWN_MFA` **lo fijó la implementación de A4**; AU-035 dice «sobre
otra cuenta» y esto es lo que se responde a quien lo pide sobre la suya. **No es
simetría con AU-024**, y el porqué está escrito junto a la clase: la ruta exige
una sesión completa, y una sesión completa significa que el segundo factor ya
funcionó, así que reiniciarse el propio nunca podría ser un camino de
recuperación —quien perdió el teléfono no llega hasta aquí—. Lo único que
permitiría es que quien tenga una sesión viva de esa cuenta le retire el factor
y a partir de ahí entre con la contraseña sola, dejando además al autor y al
sujeto siendo la misma persona: justo lo que hace inútil la entrada de bitácora
que AU-035 exige. No se pierde nada al prohibirlo, porque tampoco existe hoy
ninguna forma de rematricular el segundo factor por cuenta propia
(`MFA_ALREADY_ENROLLED` rechaza una segunda matrícula).

> **Resuelto por AU-037 (D-015).** El Cambiar de teléfono sin perderlo —el caso legítimo
> que queda sin salida— exigiría un camino de auto-servicio que hoy no existe en
> ningún requisito: rematricular el propio segundo factor probando el actual.
> Queda **fuera de A4**, que trata de quien ya no puede entrar.

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

**AU-037 sí necesitó columna nueva**, en `20260813233941_auth_mfa_pending_secret`:
`app_user.mfa_pending_secret_encrypted`, el secreto TOTP de un cambio empezado y
sin confirmar. **Es una columna aparte y eso es el requisito, no una comodidad**:
cambiar de teléfono es de dos pasos —se enseña un QR y después se confirma un
código que demuestra que se escaneó—, y si el secreto nuevo se escribiera encima
del que está en uso, el intervalo entre los dos pasos sería una cuenta cuyo
segundo factor ya no vale y cuyo sustituto todavía no está confirmado. Se pone al
empezar y se vacía en la **misma sentencia** que instala el secreto nuevo; esa
reclamación —`WHERE mfa_pending_secret_encrypted = <el que se acaba de
verificar>`— es lo que arbitra dos cambios simultáneos, porque la de la primera
matrícula (`mfa_enabled_at IS NULL`) aquí la cumplen todos y no arbitra nada.
Se vacía también al reiniciar el segundo factor (AU-035).

**AU-041 necesitó columna nueva**, en `20260930192201_auth_session_epoch`:
`app_user.session_epoch integer NOT NULL DEFAULT 0`, cuántas veces se han
cerrado todas las sesiones de la cuenta. Sólo la escribe `revokeLiveSessions`
(alcance de cuenta) y sólo la compara la emisión de una familia nueva. AU-040
**no** necesitó columna: la caducidad de la familia es la `expires_at` que
heredan todas sus filas.

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

**AU-042 necesitó tabla nueva**, en `20260930221225_authorisation_one_off`:
`authorisation_one_off (name varchar(64) PRIMARY KEY, applied_at timestamptz)`,
las concesiones únicas que `syncAuthorisation` ya hizo en esta base. La clave
primaria es la reclamación: la fila se inserta con `ON CONFLICT DO NOTHING` en la
misma transacción que concede, así que dos sincronizaciones a la vez conceden
una vez, y si la fila existe no se concede nada aunque al rol le falte el
permiso —que entonces es porque la clínica se lo quitó—. `granted text[]`
guarda qué concedió (`ROL → permiso`): cambia quién escribe en la historia
clínica, y la auditoría no puede depender de la consola de un despliegue.
