-- Personal auto-answers for application screening questions the AI must
-- never invent (vehículo propio, licencia, disponibilidad para viajar,
-- inglés, portafolio, etc.). JSON map of whitelisted keys -> the user's
-- own answer text, typed once in /account/preferences and auto-filled by
-- the extension exactly like expected_salary.
ALTER TABLE preferences ADD COLUMN personal_answers TEXT NOT NULL DEFAULT '{}';
