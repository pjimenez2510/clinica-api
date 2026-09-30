-- invoice_buyer_identification_valid
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA (BI-159): la regla ENTERA de `Ruc` y `Cedula` sobre el receptor
-- de la factura, no sólo su forma. Sustituye a `invoice_buyer_ruc_format` e
-- `invoice_buyer_cedula_format` (migración anterior), que se quedaban en la
-- longitud y el `000` con el argumento de que el resto «no cabía en un CHECK
-- legible». Era falso: `is_valid_cedula()` existe desde
-- `20260806022956_clinical_core_constraints` y ya la usan
-- `patient_identifier_cedula_valid` y el CHECK de `auth_user`. La cédula del
-- paciente la garantizaba la base; la de la factura, que es la que va al SRI,
-- no. Hallado en la revisión clínica de fix/receptor-identificacion.
--
--   - `05`: `is_valid_cedula(buyer_identification)`.
--   - `04`: `is_valid_ruc(buyer_identification)`, que es `Ruc.create` (OR-008,
--     OR-009): trece dígitos, provincia 01-24 o 30, establecimiento `001` o
--     más, tercer dígito 0-5 (persona natural, con los diez primeros como
--     cédula válida), 6 (sector público) o 9 (sociedad). Sin módulo 11 para
--     sociedades: el SRI lo abandonó en 2021 (D-057).
--   - `06`, `07` y `08` no se tocan: `07` lo gobierna
--     `invoice_final_consumer_identification`, y los otros dos los emite otro
--     país.
--
-- VALIDADOS, no `NOT VALID`: en la base de desarrollo hay una factura, a un
-- RUC que cumple (30-09-2026). Una base que tenga una que no cumple hace
-- fallar esta migración nombrando la restricción; una factura no se corrige
-- editándola (BI-084), así que esa base tiene que decidir qué hacer con ella
-- antes de seguir.

CREATE OR REPLACE FUNCTION is_valid_ruc(p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  province int;
  third int;
BEGIN
  IF p_value !~ '^\d{13}$' THEN RETURN false; END IF;

  province := substring(p_value, 1, 2)::int;
  IF NOT ((province BETWEEN 1 AND 24) OR province = 30) THEN RETURN false; END IF;

  -- A taxpayer always has at least one establishment: `000` is a truncation.
  IF right(p_value, 3)::int < 1 THEN RETURN false; END IF;

  third := substring(p_value, 3, 1)::int;
  IF third < 6 THEN RETURN is_valid_cedula(left(p_value, 10)); END IF;
  RETURN third IN (6, 9);
END;
$$;

ALTER TABLE invoice
  DROP CONSTRAINT invoice_buyer_ruc_format,
  DROP CONSTRAINT invoice_buyer_cedula_format,
  ADD CONSTRAINT invoice_buyer_ruc_valid
    CHECK (buyer_identification_type <> '04' OR is_valid_ruc(buyer_identification)),
  ADD CONSTRAINT invoice_buyer_cedula_valid
    CHECK (buyer_identification_type <> '05' OR is_valid_cedula(buyer_identification));
