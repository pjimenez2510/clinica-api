-- signing_certificate_holder_ruc
--
-- Escrito a mano (scripts/new-migration.mts).
--
-- SRI-102 (D-215 §2, D-223). El RUC del titular del certificado, tal como lo
-- dice el certificado: la extensión 1.3.6.1.4.1.37746.3.11 de Security Data
-- o un RUC de 13 dígitos en el sujeto. NULL si no lo dice o no se supo leer.
-- Lo escribe la carga; la pantalla avisa si no es el del establecimiento ni el
-- de ninguna sede, sin impedir firmar. Los ya cargados quedan en NULL («no se
-- pudo leer»): el contenido cifrado no se vuelve a abrir para esto.
ALTER TABLE "signing_certificate"
  ADD COLUMN "holder_ruc" VARCHAR(13);

ALTER TABLE "signing_certificate"
  ADD CONSTRAINT "signing_certificate_holder_ruc_is_a_ruc"
  CHECK ("holder_ruc" IS NULL OR "holder_ruc" ~ '^[0-9]{13}$');
