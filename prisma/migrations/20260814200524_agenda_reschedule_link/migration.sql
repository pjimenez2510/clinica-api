-- agenda_reschedule_link (E3: AG-051)
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA, Y POR QUÉ ASÍ:
--
-- AG-051 pide que, al reprogramar, «el historial de ambas entradas» lleve la
-- referencia a la otra. Hoy no hay dónde ponerla: `agenda_entry` no se
-- referencia a sí misma y `agenda_status_history` sólo ofrece `note`, un
-- VARCHAR(512) donde recepción escribe prosa. Escribir «se reprogramó a la
-- cita 0193…» en ese texto NO es guardar el enlace: ningún cliente puede
-- recorrerlo, ninguna clave foránea lo protege de apuntar a nada, y la
-- primera pregunta que se le hace —«¿a qué hora quedó?»— se contesta leyendo
-- castellano con una expresión regular.
--
-- UNA COLUMNA Y NO UNA TABLA DE ENLACE. La relación es 1:1 y de una sola
-- naturaleza: esta cita procede de aquélla. Una tabla de enlace serviría para
-- muchos-a-muchos o para calificar el vínculo con atributos propios, y aquí no
-- hay ni lo uno ni lo otro — el CUÁNDO y el QUIÉN de la reprogramación ya los
-- guarda la fila de `agenda_status_history` que la anulación escribe en la
-- misma transacción (AG-004). Sería una tabla con dos columnas, ambas claves
-- foráneas, y un JOIN de más en cada lectura.
--
-- LOS DOS SENTIDOS SE RECORREN CON ESTA SOLA COLUMNA. Hacia atrás es la
-- columna misma (`rescheduled_from_id`); hacia adelante es el índice único de
-- abajo, que responde «¿en qué acabó esta cita?» sin recorrer la tabla. Una
-- segunda columna `rescheduled_to_id` diría lo mismo dos veces y admitiría que
-- las dos se contradigan.
--
-- POR QUÉ NO ES UN ESTADO NUEVO. «Reprogramada» parece un estado y no lo es:
-- SPEC §5 no lo tiene, la cita original queda ANULADA (AG-044: con motivo,
-- `cancelled_at` y el cupo liberado) y lo único que la distingue de cualquier
-- otra anulación es que existe otra entrada que procede de ella. Eso es
-- exactamente lo que esta columna dice. Añadir un estado obligaría además a
-- rehacer `agenda_entry_kind_status_coherence` y el índice GiST de los tres
-- `EXCLUDE`, que es lo que el comentario de `released_at` en schema.prisma
-- lleva desde el principio pidiendo que no se haga.

ALTER TABLE agenda_entry
  ADD COLUMN rescheduled_from_id uuid;

-- `RESTRICT` y no `CASCADE`, que es la regla de la casa y aquí además la
-- consecuencia de §5: una cita NO SE BORRA —se anula, se libera o se marca—,
-- así que un borrado en cascada sólo puede ocurrir por accidente, y llevarse
-- por delante la cita a la que se reprogramó a alguien es la clase de daño que
-- nadie descubre hasta que el paciente se presenta.
ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_rescheduled_from_fkey
  FOREIGN KEY (rescheduled_from_id) REFERENCES agenda_entry (id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Una cita procede de sí misma en ninguna lectura posible, y sin esto un
-- `UPDATE` equivocado crearía un ciclo de longitud uno que toda travesía de la
-- cadena tendría que aprender a esquivar.
ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_reschedule_not_self
  CHECK (rescheduled_from_id IS NULL OR rescheduled_from_id <> id);

-- ÍNDICE ÚNICO PARCIAL, y las dos mitades del nombre son deliberadas:
--
--   * ÚNICO porque una cita se reprograma UNA VEZ. Reprogramar la anula
--     (AG-050) y `CANCELLED` es terminal (§5), así que una segunda entrada que
--     dijera proceder de la misma original describiría una historia que la
--     máquina de estados no admite. El `UPDATE` condicional del adaptador ya
--     hace que sólo una transacción gane la anulación; esto lo garantiza
--     también contra cualquier escritura que no pase por ahí.
--   * PARCIAL porque la inmensa mayoría de las citas no proceden de ninguna:
--     sin el `WHERE`, el índice guardaría una entrada por cada fila de
--     `agenda_entry` para no responder nunca nada sobre ellas.
--
-- Y ES TAMBIÉN EL ÍNDICE DE LA TRAVESÍA HACIA ADELANTE: «¿a qué cita se
-- reprogramó ésta?» es una búsqueda por igualdad sobre esta misma columna.
CREATE UNIQUE INDEX agenda_entry_one_reschedule_per_entry
  ON agenda_entry (rescheduled_from_id)
  WHERE rescheduled_from_id IS NOT NULL;

COMMENT ON COLUMN agenda_entry.rescheduled_from_id IS
  'AG-050, AG-051. La cita de la que ésta procede al reprogramar. NULL en toda cita que nace por reserva directa.';
