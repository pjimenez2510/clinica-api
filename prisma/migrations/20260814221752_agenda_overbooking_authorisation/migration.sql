-- agenda_overbooking_authorisation (E4: AG-035, AG-036, AG-039, AG-094, AG-101)
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA, Y POR QUÉ ESTO Y NO MÁS:
--
-- La entrega E4 es «las dos vías documentadas de romper la rejilla»: el
-- sobrecupo y el bloqueo. El bloqueo NO necesita esquema —los tres
-- `EXCLUDE USING gist` no miran `kind`, así que un bloqueo que ocupa
-- calendario ya compite igual que una cita (AG-037)—. El sobrecupo sí, y son
-- exactamente los dos campos que el `SPEC.md` marcaba con `Falta esquema`:
--
--   * AG-035: QUIÉN AUTORIZÓ. `created_by_id` no sirve y ése es justo el
--     control: quien reserva y quien autoriza son personas distintas
--     (D-005, AG-103). Una sola columna para los dos papeles haría AG-103
--     incomprobable desde la fila.
--   * AG-036: el MOTIVO del sobrecupo, en columna propia. NO se reutiliza
--     `reason`, que es el texto libre donde recepción escribe el motivo de
--     consulta —dato de salud— y que el listado del día dejó de exponer a
--     propósito (AG-072, AG-074). Exponer `reason` «sólo cuando es sobrecupo»
--     sería exposición condicional de PHI: nada impide escribir lo mismo en
--     un sobrecupo, y una condición en el serializador no es una garantía.
--     Con dos columnas, la que se sirve nunca tuvo dentro un dato clínico.
--
-- Y los dos parámetros de sede que D-018 dejó para esta entrega (AG-094): si
-- el sobrecupo está habilitado y qué permiso lo autoriza. El tope
-- (`overbooking_cap`) ya existía desde C3.

-- ─── AG-035, AG-036: la constancia del sobrecupo ────────────────────────────
--
-- `RESTRICT` en el autorizador, como en toda la evidencia de este esquema: la
-- cuenta de quien autorizó una excepción no se borra dejando la excepción sin
-- autor. Las cuentas se desactivan, no se borran (ADR-007), así que esto no
-- bloquea ninguna operación real.
--
-- ANULABLES LAS DOS, porque la inmensa mayoría de las citas no son sobrecupo.
-- Lo que las ata es el CHECK de abajo, que es lo que convierte «hay que
-- rellenarlas» en una garantía en vez de una costumbre del servicio.
ALTER TABLE agenda_entry
  ADD COLUMN overbooking_authorised_by_id uuid
    REFERENCES app_user (id) ON DELETE RESTRICT,
  ADD COLUMN overbooking_reason varchar(512);

COMMENT ON COLUMN agenda_entry.overbooking_authorised_by_id IS
  'AG-035. Quién autorizó el sobrecupo. Distinto de created_by_id a propósito: la separación entre quien reserva y quien autoriza ES el control (D-005, AG-103).';
COMMENT ON COLUMN agenda_entry.overbooking_reason IS
  'AG-036. Por qué se rompió la rejilla. Dato ADMINISTRATIVO, y por eso es servible: `reason` es el motivo de consulta y no sale en ningún listado (AG-072).';

-- LA BICONDICIONAL, Y NO DOS CHECKS SUELTOS. Un sobrecupo sin motivo ni
-- autorizador es una excepción sin constancia —exactamente lo que D-005 dice
-- que pasa cuando la regla se rompe fuera del sistema—, y una cita que ocupa
-- calendario con un autorizador escrito afirma que alguien autorizó algo que
-- no hizo falta autorizar. Las dos direcciones importan, así que se exigen las
-- dos en una sola expresión: leerla dice el invariante entero.
--
-- `btrim(...) <> ''` porque un motivo en blanco cumple `IS NOT NULL` y no
-- informa de nada. La aplicación lo recorta antes (AG-035,
-- `OVERBOOKING_REASON_REQUIRED`); esto es lo que queda cuando la escritura
-- llega por `psql` o por una importación.
ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_overbooking_coherence CHECK (
    CASE WHEN blocks_calendar
      THEN overbooking_authorised_by_id IS NULL
       AND overbooking_reason IS NULL
      ELSE overbooking_authorised_by_id IS NOT NULL
       AND overbooking_reason IS NOT NULL
       AND btrim(overbooking_reason) <> ''
    END
  );

-- El listado del día (AG-017) ya está servido por `agenda_entry_daily_agenda`,
-- y AG-100 cuenta los sobrecupos de UN profesional en UN día: son pocas filas
-- dentro de un rango de instantes que `agenda_entry_practitioner_id_starts_at_idx`
-- ya acota. No se añade índice: uno que no cambia ningún plan es mantenimiento
-- sin beneficio, y el sobrecupo es, por definición, la excepción.

-- ─── AG-094, AG-039, AG-101: los dos parámetros que D-018 difirió ───────────
--
-- HABILITADO DE FÁBRICA, y es la decisión contraria a la de
-- `allow_past_booking` — a propósito, decidida por el usuario el 14-08-2026.
-- El sobrecupo ES la vía documentada de romper la rejilla (D-005): una sede
-- que lo tuviera cerrado de fábrica no dejaría de tener urgencias, las
-- resolvería en papel, anulando la cita de otro o atendiendo a alguien que
-- nunca aparece en la agenda. Lo que evita que sea la vía normal no es tenerlo
-- cerrado, es el tope de D-001 —dos por profesional y día— que ya está en
-- `overbooking_cap`, y la constancia por cita que exige el CHECK de arriba.
ALTER TABLE site_parameter
  ADD COLUMN overbooking_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN site_parameter.overbooking_enabled IS
  'AG-039, AG-094. La sede admite sobrecupos. Nace en true: el sobrecupo es la vía documentada de la excepción (D-005) y lo que lo limita es overbooking_cap.';

-- ─── El permiso que autoriza: un CÓDIGO DE PERMISO GUARDADO COMO DATO ───────
--
-- ESTO ES LO ÚNICO DELICADO DE ESTA MIGRACIÓN. Qué permisos EXISTEN es código
-- —cada uno corresponde a una comprobación en el sistema, así que uno
-- inventado en una fila no protege nada— y aquí una columna de texto va a
-- decidir quién puede autorizar una excepción a la garantía más fuerte del
-- módulo. Si guarda `agenda:overbok`, la comprobación de AG-101 no la pasa
-- NADIE y la sede se queda sin sobrecupos sin que nada lo diga; si guarda
-- `agenda:read`, la autoriza cualquiera que vea la agenda.
--
-- Se cierra en tres capas, que es el mismo reparto que ya usa la pantalla de
-- roles (AU-033):
--
--   1. El CATÁLOGO del código es la enumeración: `configuration` rechaza con
--      `UNKNOWN_PERMISSION` (422) lo que `permission.catalogue.ts` no declara.
--   2. Y con `PERMISSION_NOT_INSTALLED` (409) lo que el código sí declara y
--      esta instalación aún no ha sembrado — el par de códigos que distingue
--      «eso no existe» de «eso todavía no está en esta base».
--   3. El disparador de abajo es la garantía de la base para lo que llegue por
--      otro camino: un `UPDATE` desde `psql` o una migración de datos.
--
-- ⚠️ POR QUÉ UN DISPARADOR SOBRE `UPDATE` Y NO UNA CLAVE FORÁNEA, que es lo
-- que uno escribiría primero (y lo que se escribió primero aquí). Una FK
-- contra `permission (code)` se valida también en el INSERT, y la fila de
-- `site_parameter` NO la inserta nadie a mano: la escribe
-- `trg_site_parameter_defaults` en el instante en que se crea la sede
-- (CF-062), con el valor por defecto de esta columna. Eso ata CREAR UNA SEDE a
-- que el espejo `permission` ya esté sembrado — y no lo está: `pnpm db:seed`
-- sincroniza la autorización, pero una importación de datos, una restauración
-- parcial o una prueba que crea una sede antes de sembrar permisos fallarían
-- con un error de clave foránea que no tiene nada que ver con lo que estaban
-- haciendo. El precio de la FK lo paga el camino normal; el disparador lo
-- cobra sólo a quien cambia el valor, que es el único que puede equivocarse.
--
-- LO QUE ESTO NO CUBRE, dicho en voz alta: un INSERT que traiga un permiso
-- inventado explícitamente. Hoy no existe ninguno —la fila la crea el
-- disparador de CF-062 y nadie más— y cubrirlo obligaría a distinguir en un
-- BEFORE INSERT el valor por defecto de uno escrito a mano, que PostgreSQL no
-- permite.
CREATE OR REPLACE FUNCTION site_parameter_overbooking_permission_exists()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permission WHERE code = NEW.overbooking_permission
  ) THEN
    RAISE EXCEPTION
      'overbooking_permission % is not a permission of this installation',
      NEW.overbooking_permission
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Use a code declared by permission.catalogue.ts and run pnpm db:seed:auth.';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE site_parameter
  ADD COLUMN overbooking_permission varchar(64) NOT NULL
    DEFAULT 'agenda:overbook';

-- `OF overbooking_permission` y `WHEN … IS DISTINCT FROM …`: el disparador no
-- corre al guardar las antelaciones ni el tope, que es la mayoría de los
-- guardados de esa pantalla.
CREATE TRIGGER trg_site_parameter_overbooking_permission
  BEFORE UPDATE OF overbooking_permission ON site_parameter
  FOR EACH ROW
  WHEN (NEW.overbooking_permission IS DISTINCT FROM OLD.overbooking_permission)
  EXECUTE FUNCTION site_parameter_overbooking_permission_exists();

-- Las dos filas del catálogo se siembran aquí para que el defecto de la
-- columna nombre desde el primer momento un permiso que existe. No es
-- adelantarse a `pnpm db:seed:auth`: `ON CONFLICT DO NOTHING` deja que la
-- semilla siga siendo la dueña de la descripción y la reescriba en cuanto
-- corre.
INSERT INTO permission (code, resource, description) VALUES
  ('agenda:overbook', 'agenda',
   'Autorizar un sobrecupo: una cita fuera de la rejilla, con motivo y constancia de quién la autorizó'),
  ('agenda:overbook:self', 'agenda',
   'Autorizar el propio sobrecupo, sin que otra persona lo autorice. Es la excepción para el médico de guardia: quien lo tiene puede saltarse la separación entre quien reserva y quien autoriza')
ON CONFLICT (code) DO NOTHING;

COMMENT ON COLUMN site_parameter.overbooking_permission IS
  'AG-101, AG-094. Qué permiso hay que tener para autorizar un sobrecupo en esta sede. Es un código del catálogo, y la clave foránea es lo que impide que sea cualquier texto.';
