-- Hace la bitácora de auditoría verdaderamente append-only.
--
-- POR QUÉ UN TRIGGER Y NO `REVOKE UPDATE, DELETE`:
-- el dueño de una tabla conserva sus privilegios aunque se los revoques, y la
-- aplicación se conecta como dueña. Un REVOKE daría una falsa sensación de
-- seguridad. El trigger aplica a todo el mundo salvo a un superusuario que lo
-- desactive explícitamente — y eso sí queda registrado en los logs del servidor.
--
-- Sin esto, la bitácora no es evidencia ante la SPDP: si el administrador de la
-- aplicación puede editarla, no prueba nada.

CREATE OR REPLACE FUNCTION auditoria_acceso_solo_insercion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'auditoria_acceso es append-only: la operación % está prohibida', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'La bitácora de auditoría es evidencia legal y no se puede alterar. '
                 'Para depurar en desarrollo, desactiva el trigger de forma explícita.';
END;
$$;

CREATE TRIGGER trg_auditoria_acceso_inmutable
  BEFORE UPDATE OR DELETE ON auditoria_acceso
  FOR EACH ROW
  EXECUTE FUNCTION auditoria_acceso_solo_insercion();

-- TRUNCATE no dispara triggers FOR EACH ROW: hay que bloquearlo aparte.
CREATE TRIGGER trg_auditoria_acceso_no_truncate
  BEFORE TRUNCATE ON auditoria_acceso
  FOR EACH STATEMENT
  EXECUTE FUNCTION auditoria_acceso_solo_insercion();

COMMENT ON TABLE auditoria_acceso IS
  'Bitácora append-only de acceso a datos personales y de salud (LOPDP). '
  'Protegida por trigger contra UPDATE, DELETE y TRUNCATE.';
