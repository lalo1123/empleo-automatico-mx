-- Adds the "auto-submit" toggle to user preferences.
--
-- Product decision (2026-06-14): an INDIVIDUAL ⚡ Postular auto-fills AND
-- auto-sends by default ("Automático total"). Users who want to review the
-- application before it's sent flip this OFF in their account ("Revisar antes
-- de enviar"), which makes the extension STOP at the final submit button (HITL)
-- instead of clicking it. Bulk auto-postular always auto-sends regardless of
-- this flag (the user already opted into batch automation there).
--
-- 1 = auto-send (default), 0 = stop for manual review.

ALTER TABLE preferences ADD COLUMN auto_submit INTEGER NOT NULL DEFAULT 1;
