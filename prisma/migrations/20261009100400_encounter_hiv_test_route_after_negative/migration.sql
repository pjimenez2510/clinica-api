-- encounter_hiv_test_route_after_negative
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio.
--
-- Revisión clínica de `feat/f04-bloques-programa`. EN-094: la vía de
-- transmisión es la vía «por la cual el usuario se contagió de VIH»
-- (instructivo, p. 61 del PDF). Con la prueba de confirmación NO REACTIVA no
-- hay contagio que atribuir, así que la vía no se registra. Con la segunda
-- prueba reactiva o todavía sin resultado sí —el ejemplo del propio
-- instructivo registra la vía con la columna 79 en blanco—.
-- Responde CONFIRMATORY_TEST_WITHOUT_SCREENING, como la regla hermana.
-- Después: pnpm migrations:check && pnpm db:deploy

ALTER TABLE "encounter_hiv_test"
  ADD CONSTRAINT "encounter_hiv_test_route_needs_infection" CHECK (
    "transmission_route" IS NULL
    OR "confirmation_result" IS DISTINCT FROM 'NON_REACTIVE'
  );
