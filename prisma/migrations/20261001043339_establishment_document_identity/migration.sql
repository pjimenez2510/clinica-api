-- OR-010 a OR-012, DOC-080. Lo que la cabecera aprobada de los documentos
-- imprime y el establecimiento no guardaba (D-095): el nombre comercial, el
-- correo de contacto y el permiso de funcionamiento de la ACESS.
--
-- LOS TRES SON NULOS A PROPÓSITO. Ninguno es obligatorio para recetar el primer
-- día (DOC-059 dice lo mismo del logo): lo que falta no se imprime, nunca se
-- inventa. Los CHECK guardan la FORMA para el `psql` y la importación que no
-- pasan por el DTO; la regla entera vive en el DTO.

ALTER TABLE establishment
  ADD COLUMN trade_name VARCHAR(160),
  ADD COLUMN contact_email VARCHAR(254),
  ADD COLUMN operating_permit VARCHAR(40),
  ADD CONSTRAINT establishment_trade_name_not_blank
    CHECK (trade_name IS NULL OR btrim(trade_name) <> ''),
  ADD CONSTRAINT establishment_contact_email_format
    CHECK (contact_email IS NULL OR contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD CONSTRAINT establishment_operating_permit_not_blank
    CHECK (operating_permit IS NULL OR btrim(operating_permit) <> '');
