-- auth_user_cedula_check
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA: que `app_user.cedula` sea una cédula ecuatoriana de verdad
-- —diez dígitos, provincia existente, tercer dígito menor que 6 y dígito
-- verificador correcto— o NULL.
--
-- POR QUÉ. `is_valid_cedula()` existía desde
-- `20260806022956_clinical_core_constraints`, pero colgaba únicamente de
-- `patient_identifier`. La cédula del PERSONAL no la comprobaba nadie: el DTO
-- de administración de cuentas sólo limitaba la longitud, y `PATCH
-- /auth/users/:id {"cedula":"abc"}` respondía 2xx. Esa columna es la que el
-- RDACAA exige en cada atención (REQ-021) y la que `staff` sirve en la ficha
-- profesional, así que un error de tecleo aquí se descubre meses después, en
-- un reporte que el Ministerio rechaza.
--
-- El DTO ya valida con el value object `Cedula` —mismo algoritmo, mismo
-- resultado—, y esto es lo que aguanta cuando la escritura llega por otro
-- camino: una importación de datos, una semilla, un `psql` a las dos de la
-- mañana.

-- NULL SIGUE SIENDO LEGÍTIMO, y es el caso mayoritario: recepción, caja y
-- administración tienen cuenta y no son profesionales. Sólo quien firma o
-- prescribe necesita cédula.
--
-- `NOT VALID` A PROPÓSITO, y no por comodidad. La restricción se comprueba en
-- cada INSERT y en cada UPDATE desde este momento —que es lo que protege—, y
-- no obliga a que las filas ya escritas la cumplan. Una instalación que
-- guardó una cédula mal tecleada antes de hoy no puede quedarse sin poder
-- desplegar: la corrige desde la pantalla, y ese UPDATE sí pasa por aquí.
-- Cuando no quede ninguna, `VALIDATE CONSTRAINT` la promueve sin bloquear
-- escrituras.
ALTER TABLE app_user
  ADD CONSTRAINT app_user_cedula_valid CHECK (
    cedula IS NULL OR is_valid_cedula(cedula)
  ) NOT VALID;
