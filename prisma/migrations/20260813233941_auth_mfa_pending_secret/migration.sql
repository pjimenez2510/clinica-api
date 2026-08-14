-- auth_mfa_pending_secret
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA: que cambiar el segundo factor (AU-037) no pueda dejar a nadie
-- sin ninguno.
--
-- POR QUÉ UNA COLUMNA NUEVA Y NO REUTILIZAR `mfa_secret_encrypted`. Cambiar de
-- teléfono es de dos pasos por naturaleza: se enseña un QR y después se
-- confirma un código que demuestra que se escaneó. Si el secreto nuevo se
-- escribiera encima del que está en uso, el intervalo entre los dos pasos
-- sería una cuenta cuyo segundo factor ya no vale y cuyo sustituto todavía no
-- está confirmado. Cerrar la pestaña ahí —o que falle el escaneo— deja a la
-- persona sin factor y sin sesión con la que arreglarlo, que es el mismo
-- fallo que la revisión adversarial encontró en AU-005 con la respuesta de
-- `mfa/confirm` perdida. Con dos columnas, una rematrícula abandonada no
-- cuesta nada: el factor viejo sigue exactamente donde estaba.
--
-- `text` y no `varchar(n)`: guarda el mismo formato que
-- `mfa_secret_encrypted` —AES-256-GCM con `iv | authTag | ciphertext` en
-- base64— y su longitud es un detalle del cifrado, no del dominio.
--
-- NULLABLE, y lo normal es que sea NULL: sólo tiene valor mientras hay un
-- cambio a medias. Se pone al empezar y se vacía en la MISMA sentencia que
-- instala el secreto nuevo, y esa reclamación —`WHERE
-- mfa_pending_secret_encrypted = <el que se acaba de verificar>`— es lo que
-- arbitra dos confirmaciones simultáneas, igual que `mfa_enabled_at IS NULL`
-- arbitra la primera matrícula.
--
-- SIN ÍNDICE. No se busca por esta columna: se lee y se escribe siempre por
-- `id` de la cuenta.

ALTER TABLE "app_user"
  ADD COLUMN "mfa_pending_secret_encrypted" text;

COMMENT ON COLUMN "app_user"."mfa_pending_secret_encrypted" IS
  'AU-037. Secreto TOTP de un cambio de segundo factor empezado y sin '
  'confirmar, cifrado con AES-256-GCM. Separado de mfa_secret_encrypted para '
  'que el factor en uso siga valiendo hasta que se confirme el nuevo: una '
  'rematrícula abandonada a la mitad no puede dejar a nadie sin segundo '
  'factor.';
