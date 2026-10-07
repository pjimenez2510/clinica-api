-- critical_notice_caller_and_orderer
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ORD-148 (D-116 e) · QUIÉN HIZO LA LLAMADA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La constancia guardaba quién la REGISTRA (`notified_by_id`, la cuenta de la
-- sesión) y no quién llamó: la llamada de las 03:00 se anota a las 08:00, y lo
-- típico es que la anote otra persona. `caller_name` es el nombre de quien
-- llamó cuando no es quien registra; vacío, llamó quien registra. Se edita con
-- la constancia (ORD-120): no es su origen, que sigue fijo.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ORD-146 (D-116 a) · EL AVISO AL MÉDICO QUE PIDIÓ, POR SU NOMBRE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Tras un autoaviso, un aviso al médico que pidió no cierra la cola de
-- críticos. «Al médico que pidió» es el tipo, o un destinatario que lleva su
-- nombre con otro tipo («Otro médico: Juan Pérez»): la aplicación lo juzga al
-- registrar o editar (ORD-147) y lo guarda aquí, para que la cola lo lea con
-- una consulta.
--
-- NO SE TOCA NINGUNA FILA GUARDADA. `ADD COLUMN` con un defecto constante no
-- reescribe la tabla ni dispara los disparadores de fila
-- (`trg_critical_result_notice_keeps_its_origin`, `record_version`): las
-- constancias que existan nacen con `caller_name` vacío —llamó quien registró,
-- lo único que se sabía— y `names_ordering_practitioner` en falso, y cuentan
-- por su tipo. Ninguna consulta de la cola cambia para ellas.

ALTER TABLE "critical_result_notice"
  ADD COLUMN "caller_name" VARCHAR(200),
  ADD COLUMN "names_ordering_practitioner" BOOLEAN NOT NULL DEFAULT false;

-- Un nombre vacío no dice quién llamó: o se nombra, o llamó quien registra.
ALTER TABLE "critical_result_notice"
  ADD CONSTRAINT "critical_result_notice_caller_named" CHECK (
    "caller_name" IS NULL OR btrim("caller_name") <> ''
  );
