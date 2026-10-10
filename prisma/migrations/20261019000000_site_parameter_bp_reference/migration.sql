-- EN-272 (D-205 §6, D-207 §1). La línea de referencia de la tensión arterial
-- que dibuja la pestaña «Evolución» de la ficha.
--
-- UN PARÁMETRO DE SEDE Y NO UNA CONSTANTE: el valor no lo decide este sistema
-- (D-207 §1 está pendiente de un clínico), así que tiene que poder cambiarse
-- sin desplegar. Nace en 140/90, la etapa 2 del ACC/AHA 2017, que es la
-- recomendación registrada en D-207 §1.
--
-- LOS EXTREMOS SON NUESTROS Y EL VALOR NO: por fuera de 100–200 y 60–120 la
-- línea deja de ser un umbral que alguna guía use, y una diastólica igual o
-- mayor que la sistólica es una cifra imposible tecleada al revés.
ALTER TABLE "site_parameter"
  ADD COLUMN "bp_reference_systolic" SMALLINT NOT NULL DEFAULT 140,
  ADD COLUMN "bp_reference_diastolic" SMALLINT NOT NULL DEFAULT 90,
  ADD CONSTRAINT "site_parameter_bp_reference_systolic_range"
    CHECK ("bp_reference_systolic" BETWEEN 100 AND 200),
  ADD CONSTRAINT "site_parameter_bp_reference_diastolic_range"
    CHECK ("bp_reference_diastolic" BETWEEN 60 AND 120),
  ADD CONSTRAINT "site_parameter_bp_reference_coherent"
    CHECK ("bp_reference_diastolic" < "bp_reference_systolic");
