-- Timeline of events per application — so the /account/historial detail
-- drawer can show "what actually happened" on each postulación:
-- which CV was used, when the cover letter was generated, what Q&A
-- the AI answered, when the quiz auto-answered, when the user clicked
-- Finalizar. Each event is a small JSON object appended in order.
--
-- Stored as a JSON array on the applications row instead of a separate
-- events table because:
--   1) Events are always read together with their parent application.
--   2) Volume is tiny (<10 events per application typically).
--   3) Avoids a JOIN on every /history list call.
--
-- Schema of each event entry (validated client-side + server-side):
--   { step: string, at: number (unix sec), label?: string, meta?: object }
-- step ∈ "starting" | "cv" | "cv_personalized" | "cover" | "questions"
--      | "quiz" | "ready" | "submitted" | "error" | "plan_limit"
--      | "closed" | "no_form" | "already_applied"

ALTER TABLE applications ADD COLUMN events_json TEXT NOT NULL DEFAULT '[]';
