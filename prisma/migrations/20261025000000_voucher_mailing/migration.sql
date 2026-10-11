-- voucher_mailing
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio
-- (scripts/new-migration.mts).
--
-- SRI-100 (D-213 §1, D-223). A QUIÉN SE REENVIÓ UN COMPROBANTE.
--
-- «Reenviar a otro correo» (SRI-095) dejaba en `access_audit` quién lo
-- reenvió, no la dirección: ante una fuga no se podía decir al titular a quién
-- se comunicaron sus datos (nombre, cédula y servicios de salud en el RIDE).
-- Cada reenvío que SALE guarda aquí el comprobante, quién, cuándo, la
-- dirección y si era la del comprador. Un reenvío que el servidor de correo no
-- aceptó no se guarda: no hubo comunicación.
--
-- SÓLO INSERCIÓN, y con el plazo del comprobante: la clave foránea es
-- RESTRICT, así que no se borra mientras exista el comprobante, y el
-- disparador no deja cambiar ni borrar una fila. El plazo lo confirma el
-- asesor legal (D-213 §1).
--
-- El índice por quien envía y cuándo sirve al tope diario (SRI-101).

CREATE TABLE "electronic_voucher_mailing" (
  "id"          UUID         NOT NULL DEFAULT uuidv7(),
  "voucher_id"  UUID         NOT NULL,
  "sent_by_id"  UUID         NOT NULL,
  "sent_at"     TIMESTAMPTZ(6) NOT NULL,
  "recipient"   VARCHAR(320) NOT NULL,
  "to_buyer"    BOOLEAN      NOT NULL,
  CONSTRAINT "electronic_voucher_mailing_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "electronic_voucher_mailing_voucher_fk" FOREIGN KEY ("voucher_id")
    REFERENCES "electronic_voucher"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "electronic_voucher_mailing_sent_by_fk" FOREIGN KEY ("sent_by_id")
    REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "electronic_voucher_mailing_recipient_not_blank"
    CHECK (length(btrim("recipient")) > 0)
);

CREATE INDEX "electronic_voucher_mailing_by_voucher"
  ON "electronic_voucher_mailing" ("voucher_id", "sent_at");
CREATE INDEX "electronic_voucher_mailing_by_sender"
  ON "electronic_voucher_mailing" ("sent_by_id", "sent_at");

CREATE OR REPLACE FUNCTION electronic_voucher_mailing_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'electronic_voucher_mailing_append_only: a mailing is a fact; it is neither changed nor deleted'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'SRI-100.';
END;
$$;

CREATE TRIGGER "electronic_voucher_mailing_append_only"
  BEFORE UPDATE OR DELETE ON "electronic_voucher_mailing"
  FOR EACH ROW
  EXECUTE FUNCTION electronic_voucher_mailing_append_only();
