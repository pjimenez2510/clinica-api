-- El número de historia clínica se emite desde una SECUENCIA.
--
-- La alternativa —leer el máximo y sumar uno— parece obvia y está mal: dos
-- recepcionistas registrando a la vez leen el mismo máximo y emiten el mismo
-- número. El índice único lo rechazaría, pero el resultado es un error
-- incomprensible en el mostrador y un paciente esperando.
--
-- Una secuencia entrega valores sin bloquear y sin repetir. Que deje huecos al
-- revertir una transacción es DESEABLE aquí: un hueco es visible y auditable;
-- un número reutilizado apuntaría a dos historias distintas en documentos ya
-- impresos.
--
-- Arranca en 1: el formato `HC` + 10 dígitos lo produce la capa de dominio
-- (`formatMrn`), no la base. Aquí solo vive la unicidad, que es lo que la base
-- puede garantizar y el código no.
CREATE SEQUENCE IF NOT EXISTS patient_mrn_seq AS bigint START WITH 1 MINVALUE 1;

COMMENT ON SEQUENCE patient_mrn_seq IS
  'Fuente del número de historia clínica. El formato HC########## lo aplica '
  'formatMrn() en el dominio; aquí solo se garantiza que nadie reciba el '
  'mismo número dos veces.';

-- Deja la secuencia por delante de cualquier historia ya existente, para que
-- una base sembrada antes de esta migración no choque con el índice único.
SELECT setval(
  'patient_mrn_seq',
  greatest(
    (SELECT coalesce(max(substring(mrn from 3)::bigint), 0) FROM patient
      WHERE mrn ~ '^HC[0-9]{10}$'),
    0
  ) + 1,
  false
);
