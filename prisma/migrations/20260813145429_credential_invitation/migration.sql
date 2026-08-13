-- credential_invitation
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA: que la primera credencial de una cuenta viaje como un enlace
-- de un solo uso, que caduca, que nunca se guarda en claro, y que una cuenta
-- no tenga jamás dos enlaces vivos a la vez.
--
-- POR QUÉ. AU-021 fija lo que NO puede pasar —el administrador no elige la
-- contraseña de otra persona, porque entonces la conoce y el no repudio de la
-- bitácora se desvanece— y hasta hoy el sistema sólo cumplía esa mitad: `POST
-- /auth/users` creaba la cuenta con el centinela `UNUSABLE_PASSWORD_HASH` y
-- ahí se acababa. Dar de alta a alguien no funcionaba de extremo a extremo.
-- D-013 se resolvió el 13-08-2026 por la opción A: el sistema envía al correo
-- institucional un enlace de un solo uso y la persona fija su propia
-- contraseña. Esta tabla es ese enlace.

-- ===========================================================================
-- La invitación
-- ===========================================================================

-- `token_hash` Y NUNCA EL TOKEN. Exactamente como `refresh_token`: se guarda
-- el SHA-256 y sólo el SHA-256, así que una copia robada de la base no
-- contiene ninguna credencial utilizable. SHA-256 y no Argon2 por la misma
-- razón que allí: el token lo genera el sistema con 256 bits de entropía, no
-- hay diccionario que atacar, y un hash lento sólo añadiría latencia a cada
-- comprobación de un enlace.
--
-- `char(64)` porque un SHA-256 en hexadecimal mide siempre 64 caracteres. Un
-- `varchar` sin límite habría admitido cualquier cosa escrita por otra vía.
--
-- ÚNICO, igual que en `refresh_token`. Dos filas con el mismo hash sólo
-- podrían venir de un fallo que reutiliza un token, y es preferible que la
-- base lo rechace a que dos cuentas compartan enlace. El índice único es
-- además el que sirve la búsqueda por hash, que es la única forma en que se
-- consulta esta tabla.
--
-- `ON DELETE CASCADE` hacia `app_user`, que es la excepción a la regla general
-- de `RESTRICT` y la misma que ya tienen `refresh_token` y `backup_code`: esto
-- no es evidencia clínica ni bitácora, es un artefacto de credencial. Si
-- alguna vez se borrara una cuenta, dejar viva una invitación suya sería dejar
-- viva una forma de fijar la contraseña de una cuenta que ya no existe.
-- (AU-022 prohíbe borrar cuentas desde la aplicación; esto es la red por
-- debajo, no una vía.)
--
-- `created_by_id` con `RESTRICT` y NULLABLE: es quién invitó, y la bitácora
-- pregunta por él. NULLABLE porque una semilla no tiene autor, igual que en
-- `user_role_grant`.
CREATE TABLE credential_invitation (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),

  user_id       uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,

  token_hash    char(64) NOT NULL,

  -- 72 horas desde la emisión (AU-026). El plazo vive en una constante del
  -- código, `CREDENTIAL_INVITATION_TTL_HOURS`, y no aquí: un DEFAULT en la
  -- base sería una segunda definición del mismo plazo, y la que se olvidaría
  -- de cambiar.
  expires_at    timestamptz(6) NOT NULL,

  -- NULL = viva. Deja de serlo por dos caminos y a propósito por los dos: la
  -- persona la canjeó (AU-021), o alguien reenvió la invitación y ésta quedó
  -- anulada (AU-027). Los dos significan lo mismo para quien presenta el
  -- enlace —ya no sirve— y es lo único que el enlace debe poder distinguir.
  used_at       timestamptz(6),

  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  created_by_id uuid REFERENCES app_user (id) ON DELETE RESTRICT
);

-- Una cuenta, como mucho UNA invitación viva.
--
-- POR QUÉ EN LA BASE. Reenviar es «anula la anterior y emite otra», y dos
-- administradores que reenvían a la vez leen los dos «no hay ninguna viva»
-- después de anular y escriben los dos. El resultado serían dos enlaces
-- válidos para la misma cuenta, que es justo lo que AU-027 existe para
-- impedir: un enlace enviado por error tiene que dejar de funcionar, y no deja
-- de funcionar si el reenvío se limita a añadir otro.
--
-- PARCIAL, sobre `WHERE used_at IS NULL`, para que las invitaciones ya
-- canjeadas o anuladas convivan con la nueva. Son el rastro de cuántas veces
-- hizo falta invitar a alguien, y borrarlas dejaría esa pregunta sin
-- respuesta. Mismo patrón que `user_role_grant_active_unique`.
--
-- INVISIBLE PARA PRISMA: `schema.prisma` no sabe expresar un índice único
-- parcial, así que `prisma migrate dev` lo leería como algo que sobra y
-- propondría borrarlo. Está en la lista de `scripts/check-migrations.mts`.
CREATE UNIQUE INDEX credential_invitation_one_live_per_user
  ON credential_invitation (user_id)
  WHERE used_at IS NULL;

-- La consulta que hace el enlace: llega un token, se calcula su hash y se
-- busca. Es un índice único porque el hash lo es (ver arriba).
CREATE UNIQUE INDEX credential_invitation_token_hash_key
  ON credential_invitation (token_hash);

-- El plazo tiene que ser posterior a la emisión. No es una comprobación
-- decorativa: una invitación con `expires_at` en el pasado nace muerta y
-- responde igual que un enlace desconocido, así que el fallo se vería como
-- «el correo llegó y el enlace no sirve» sin nada que lo explique.
ALTER TABLE credential_invitation
  ADD CONSTRAINT credential_invitation_expires_after_creation
  CHECK (expires_at > created_at);
