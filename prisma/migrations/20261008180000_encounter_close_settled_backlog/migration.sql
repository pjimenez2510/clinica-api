-- encounter_close_settled_backlog
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- EN-241, D-186 (aceptada por el autor el 08-10-2026): LAS ATENCIONES DE ALTA
-- CUYA CUENTA CAJA YA CERRÓ ANTES DE D-184
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `trg_patient_account_closes_its_encounter` (20261008160000) sólo actúa al
-- pasar una cuenta de OPEN a SETTLED. Las cuentas liquidadas antes dejaron su
-- atención `DISCHARGED` para siempre y a su paciente sin «Salió»; ninguna
-- lista las enseña (EN-146 sólo lista abiertas y en espera).
--
-- SE CIERRAN UNA VEZ, con la MISMA función que el cierre de caja
-- (`encounter_completes_when_settled`): el instante y el autor son los de la
-- última cuenta liquidada —quién y cuándo cerró caja de verdad—, la condición
-- de egreso es la que declaró el médico al firmar, y el paciente pasa a
-- `DEPARTED` con ese instante. No es el cierre automático que prohíbe EN-145:
-- no inventa ningún hecho. La función ya deja como están las que tienen una
-- cuenta abierta, una orden en borrador (D-189) o una cuenta sin sello.
--
-- Y UNA CONDICIÓN MÁS, la de D-186: si la última cuenta liquidada no tiene
-- nada facturado ni el motivo por el que no se cobró, se queda como está:
-- no consta por qué no se cobró (BI-237), y cerrar sería decir que no quedaba
-- nada.
--
-- En desarrollo y sin prueba sobre copia (decisión del autor). En la base del
-- autor, el 08-10-2026, cierra UNA atención (recuento de sólo lectura). La
-- función se queda en la base: es lo que ataca la prueba de integración, y
-- volver a llamarla no cierra nada que no cumpla lo mismo.
CREATE FUNCTION encounter_close_settled_backlog()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_id     UUID;
  v_closed INTEGER := 0;
BEGIN
  FOR v_id IN
    SELECT e."id"
      FROM "encounter" e
      JOIN LATERAL (
        SELECT a."id", a."no_charge_reason"
          FROM "patient_account" a
         WHERE a."encounter_id" = e."id" AND a."status" = 'SETTLED'
         ORDER BY a."closed_at" DESC  -- the same account the function reads
         LIMIT 1
      ) last_settled ON TRUE
     WHERE e."status" = 'DISCHARGED'
       AND (
         last_settled."no_charge_reason" IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM "charge_item" c
            WHERE c."account_id" = last_settled."id" AND c."status" = 'BILLED'
         )
       )
     ORDER BY e."id"
  LOOP
    PERFORM encounter_completes_when_settled(v_id);
    IF (SELECT "status" FROM "encounter" WHERE "id" = v_id) = 'COMPLETED' THEN
      v_closed := v_closed + 1;
    END IF;
  END LOOP;
  RETURN v_closed;
END;
$$;

COMMENT ON FUNCTION encounter_close_settled_backlog() IS
  'EN-241, D-186. Cierra las atenciones DISCHARGED cuya última cuenta liquidada '
  'tiene algo facturado o su motivo de no cobro, con el autor y el instante de '
  'esa cuenta (encounter_completes_when_settled). Devuelve cuántas cerró.';

SELECT encounter_close_settled_backlog();
