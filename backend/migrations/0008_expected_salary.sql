-- Adds a free-text "expected salary" answer to user preferences.
--
-- Distinct from salary_min/salary_max (which are a MATCHING filter — vacancies
-- in that range score higher). expected_salary is what the extension types
-- into a vacancy's "¿expectativa salarial?" field during auto-postular, so the
-- bulk flow can answer salary questions automatically with the USER'S OWN
-- number (never invented) instead of skipping those vacancies.
--
-- Free text so the user can phrase it however they like ("$30,000 MXN brutos",
-- "30,000 - 35,000", "A convenir", etc.). Max length enforced at the API layer.

ALTER TABLE preferences ADD COLUMN expected_salary TEXT NOT NULL DEFAULT '';
