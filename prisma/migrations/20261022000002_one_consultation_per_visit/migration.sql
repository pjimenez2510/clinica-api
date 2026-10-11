-- ═══════════════════════════════════════════════════════════════════════════
-- BI-298 (ADR-013, revisión de producto del 11-10-2026). UNA consulta activa
-- por especialidad y visita.
--
-- Dos «Primera vez» de Medicina General devolvían la duda que ADR-013 vino a
-- quitar: cuál propone la agenda y cuál cobra caja. Lo garantiza la base, no
-- la pantalla: una importación o una semilla tampoco pueden crear la segunda.
-- Una consulta sin visita es su propio caso (`''`), y una desactivada no
-- cuenta: se puede retirar una y crear la que la sustituye.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX "service_one_consultation_per_visit"
  ON "service"("specialty_id", COALESCE("visit_kind", ''))
  WHERE "kind" = 'CONSULTATION' AND "active";
