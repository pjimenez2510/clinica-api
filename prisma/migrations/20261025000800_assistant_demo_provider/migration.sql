-- assistant_demo_provider
--
-- AS-029. The demonstration mode records its attempts like any other, with
-- the provider `fake`, so nobody takes an answer of the script for one of a
-- model. Only the script may be `fake`: its model, at no cost. A row that
-- named `fake` with a real model, or with a cost, would be a billed attempt
-- passing for a demonstration.

ALTER TABLE "ai_run" DROP CONSTRAINT "ai_run_provider_known";
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_provider_known"
  CHECK ("provider" IN ('gemini', 'anthropic', 'openai', 'fake'));

ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_fake_is_the_demonstration"
  CHECK (
    "provider" <> 'fake'
    OR (
      "model" = 'guion-de-demostracion'
      AND "cost_usd" IS NOT NULL
      AND "cost_usd" = 0
      AND "worst_case_usd" = 0
    )
  );
