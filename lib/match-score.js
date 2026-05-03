/**
 * lib/match-score.js — Local profile↔job matching heuristic.
 *
 * Pure JS, zero deps, runs entirely in the content script. We use it to
 * score every vacancy card on a listing page (LaPieza first, the rest of
 * the portals next). Backend / Gemini are NOT involved: the math is cheap
 * and "good enough" for v1 — we only need to discriminate signal from
 * noise so the user can pre-select what's worth burning a quota slot on.
 *
 * Algorithm summary (computeMatchScore):
 *   1. Normalize both bags of text (lowercase, strip diacritics + non-alnum).
 *   2. Tokenize words ≥3 chars, drop a small Spanish/English stopword list.
 *   3. Cap each bag to ~500 tokens (Jaccard becomes meaningless past that).
 *   4. Base = Jaccard(profile, job) × 60  → caps overlap-only at 60.
 *   5. +4 per profile.skill that appears as substring in job text, max +20.
 *   6. +10 if 2-word phrase from job.title is in profile.experience.role,
 *      else +5 if profile.summary contains job.title (or 3-word substring).
 *   7. -15 / -5 if job demands more years than profile.experience covers.
 *   8. +3 if both sides mention "remoto"/"remote".
 *   9. Clamp to 0-100 and round.
 *
 * Why these weights: Jaccard alone undershoots — a perfect-fit role only
 * shares ~40% of tokens because the JD is full of company fluff. The
 * skill-match bonus handles the case where the profile has the exact
 * skills but phrased differently (e.g. "Python" vs "Python avanzado").
 * The title bonus rewards "Sales Ops" candidate seeing a "Sales Operations"
 * vacancy. The years penalty is the only negative — we'd rather over-show
 * mid-fits than discourage exploration.
 */

// ============================================================================
// Tokenization
// ============================================================================

// Trimmed-down stopword list. Bilingual because LaPieza JDs mix ES/EN freely.
const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "con", "para", "por", "que", "del",
  "una", "uno", "en", "y", "o", "a",
  "the", "and", "or", "for", "with", "to", "of"
]);

/**
 * Normalize text: lowercase + NFD-strip diacritics + drop non-alphanumeric.
 * Whitespace is preserved so tokenization can split cleanly.
 * @param {unknown} input
 * @returns {string}
 */
function normalize(input) {
  if (input == null) return "";
  let s = String(input).toLowerCase();
  // NFD splits "á" into "a" + combining acute; the regex strips combiners.
  try { s = s.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (_) {}
  // Keep alphanumerics + whitespace; replace everything else with a space so
  // adjacent tokens don't fuse together (e.g. "Node.js" → "node js").
  return s.replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Split normalized text into tokens ≥3 chars, drop stopwords, cap length.
 * @param {string} normalized
 * @param {number} cap
 * @returns {string[]}
 */
function tokenize(normalized, cap = 500) {
  if (!normalized) return [];
  const out = [];
  for (const t of normalized.split(/\s+/)) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Jaccard similarity between two token lists (treated as sets).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0..1
 */
function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const uni = sa.size + sb.size - inter;
  if (uni === 0) return 0;
  return inter / uni;
}

// ============================================================================
// Years-of-experience helper (mirrors yearsOfExperience() in options.js).
// Duplicated here to keep this module dep-free; if it drifts, options.js is
// the source of truth — both compute via interval merging so overlapping
// roles aren't double-counted.
// ============================================================================
function computeYearsOfExperience(experience) {
  if (!Array.isArray(experience) || !experience.length) return 0;
  const ranges = [];
  for (const e of experience) {
    const s = e?.startDate ? new Date(e.startDate) : null;
    const f = e?.endDate ? new Date(e.endDate) : new Date();
    if (!s || Number.isNaN(s.getTime()) || Number.isNaN(f.getTime())) continue;
    if (f.getTime() < s.getTime()) continue;
    ranges.push([s.getTime(), f.getTime()]);
  }
  if (!ranges.length) return 0;
  ranges.sort((a, b) => a[0] - b[0]);
  let totalMs = 0;
  let curStart = ranges[0][0];
  let curEnd = ranges[0][1];
  for (let i = 1; i < ranges.length; i++) {
    const [s, f] = ranges[i];
    if (s <= curEnd) {
      if (f > curEnd) curEnd = f;
    } else {
      totalMs += curEnd - curStart;
      curStart = s;
      curEnd = f;
    }
  }
  totalMs += curEnd - curStart;
  return totalMs / (1000 * 60 * 60 * 24 * 365.25);
}

// ============================================================================
// Bag builders
// ============================================================================

function buildProfileBag(profile) {
  const parts = [];
  parts.push(profile?.summary || "");
  if (Array.isArray(profile?.skills)) parts.push(profile.skills.join(" "));
  if (Array.isArray(profile?.experience)) {
    for (const e of profile.experience) {
      parts.push(e?.role || "");
      parts.push(e?.description || "");
      if (Array.isArray(e?.achievements)) parts.push(e.achievements.join(" "));
    }
  }
  return parts.join(" ");
}

function buildJobBag(jobLite) {
  const parts = [];
  parts.push(jobLite?.title || "");
  if (Array.isArray(jobLite?.requirements)) parts.push(jobLite.requirements.join(" "));
  parts.push(jobLite?.description || "");
  parts.push(jobLite?.company || "");
  return parts.join(" ");
}

// ============================================================================
// Bonus / penalty helpers
// ============================================================================

/**
 * For each skill in profile.skills, check if it appears as a substring of
 * the normalized job text. +4 each, max +20. Returns { bonus, matched }.
 */
function skillBonus(skills, normalizedJobText) {
  if (!Array.isArray(skills) || !skills.length) return { bonus: 0, matched: [] };
  const matched = [];
  for (const skillRaw of skills) {
    const s = normalize(skillRaw);
    if (!s || s.length < 2) continue;
    if (normalizedJobText.includes(s)) matched.push(skillRaw);
  }
  const bonus = Math.min(matched.length * 4, 20);
  return { bonus, matched };
}

/**
 * Title-match bonus. We try, in order:
 *   1) Any 2-word phrase from job.title appears in any profile.experience.role → +10
 *   2) profile.summary contains job.title verbatim → +5
 *   3) profile.summary contains any 3-word substring of job.title → +5
 * Returns { bonus, reason }. reason is null when no bonus applied.
 */
function titleBonus(profile, jobLite) {
  const jobTitle = normalize(jobLite?.title || "");
  if (!jobTitle) return { bonus: 0, reason: null };
  const summary = normalize(profile?.summary || "");
  const roles = (profile?.experience || [])
    .map((e) => normalize(e?.role || ""))
    .filter(Boolean);

  // 1) 2-word phrases in any role string
  const tokens = jobTitle.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2 && roles.length) {
    for (let i = 0; i < tokens.length - 1; i++) {
      const phrase = `${tokens[i]} ${tokens[i + 1]}`;
      if (phrase.length < 5) continue; // skip "qa qa"-style noise
      for (const role of roles) {
        if (role.includes(phrase)) {
          return { bonus: 10, reason: `Experiencia previa en ${tokens[i]} ${tokens[i + 1]}` };
        }
      }
    }
  }
  // 2) full title in summary
  if (summary && jobTitle.length >= 4 && summary.includes(jobTitle)) {
    return { bonus: 5, reason: "Tu resumen menciona este puesto" };
  }
  // 3) 3-word substring in summary
  if (summary && tokens.length >= 3) {
    for (let i = 0; i <= tokens.length - 3; i++) {
      const phrase = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
      if (summary.includes(phrase)) {
        return { bonus: 5, reason: `Tu resumen alinea con "${phrase}"` };
      }
    }
  }
  return { bonus: 0, reason: null };
}

/**
 * Years-of-experience penalty.
 * If the JD says "5+ años" / "5 years", and profile experience covers < 5y:
 *   shortfall ≥ 2 → -15
 *   shortfall = 1 → -5
 *   shortfall < 1 → no penalty
 * Returns { penalty, reason } where penalty is ≤ 0.
 */
function yearsPenalty(profile, normalizedJobText) {
  // Match the FIRST plausible "N años" / "N years" we can find, ignoring
  // sub-1y mentions. We deliberately look at the original lowercase text
  // (passed in as already-normalized) so we keep word boundaries.
  const m = normalizedJobText.match(/(\d{1,2})\s*\+?\s*(?:anos|years)/);
  if (!m) return { penalty: 0, reason: null };
  const required = parseInt(m[1], 10);
  if (!Number.isFinite(required) || required < 1) return { penalty: 0, reason: null };
  const have = computeYearsOfExperience(profile?.experience || []);
  const shortfall = required - have;
  if (shortfall < 1) return { penalty: 0, reason: null };
  const haveDisplay = Math.round(have);
  if (shortfall >= 2) {
    return { penalty: -15, reason: `Pide ${required}+ años, tienes ${haveDisplay}` };
  }
  return { penalty: -5, reason: `Pide ${required} años, tienes ${haveDisplay}` };
}

/**
 * Modality bonus: both sides mention "remoto" / "remote" → +3.
 * Cheap signal but worth surfacing as a reason since it's a top filter
 * for our target users.
 */
function modalityBonus(profile, normalizedJobText) {
  const profileText = normalize(
    `${profile?.summary || ""} ${(profile?.experience || []).map((e) => `${e?.role || ""} ${e?.description || ""}`).join(" ")}`
  );
  const profileWantsRemote = /\b(remoto|remote|home\s*office|teletrabajo|a\s*distancia)\b/.test(profileText);
  const jobIsRemote = /\b(remoto|remote|home\s*office|teletrabajo|a\s*distancia)\b/.test(normalizedJobText);
  if (profileWantsRemote && jobIsRemote) return { bonus: 3, reason: "Ambos mencionan remoto" };
  return { bonus: 0, reason: null };
}

// ============================================================================
// Public entrypoint
// ============================================================================

/**
 * Compute a 0-100 match score between a user profile and a vacancy card.
 * Pure function — never throws. Missing fields are tolerated.
 *
 * @param {Object|null} profile — UserProfile from chrome.storage.local.userProfile
 * @param {Object} jobLite — { title, company, requirements?, description? }
 * @returns {{ score: number, reasons: string[] }}
 */
export function computeMatchScore(profile, jobLite) {
  const reasons = [];
  if (!profile || typeof profile !== "object") {
    return { score: 0, reasons: ["Sube tu CV en Opciones para ver match scores"] };
  }
  if (!jobLite || typeof jobLite !== "object") {
    return { score: 0, reasons: [] };
  }

  // Normalize once + reuse. The job bag is what skill/year/modality bonuses
  // search against (not just the title) so partial cards still find matches.
  const profileText = normalize(buildProfileBag(profile));
  const jobText = normalize(buildJobBag(jobLite));
  const profileTokens = tokenize(profileText, 500);
  const jobTokens = tokenize(jobText, 500);

  // 1) Jaccard base, capped at 60.
  const jac = jaccard(profileTokens, jobTokens);
  const base = jac * 60;

  // 2) Skill exact-match bonus.
  const { bonus: sBonus, matched } = skillBonus(profile.skills, jobText);
  if (matched.length) {
    const top = matched.slice(0, 3).join(", ");
    reasons.push(`${matched.length} skill${matched.length === 1 ? "" : "s"} coinciden: ${top}`);
  }

  // 3) Title bonus.
  const tBonus = titleBonus(profile, jobLite);
  if (tBonus.reason) reasons.push(tBonus.reason);

  // 4) Years penalty.
  const yPen = yearsPenalty(profile, jobText);
  if (yPen.reason) reasons.push(yPen.reason);

  // 5) Modality bonus.
  const mBonus = modalityBonus(profile, jobText);
  if (mBonus.reason) reasons.push(mBonus.reason);

  // 6) Combine + clamp.
  let raw = base + sBonus + tBonus.bonus + yPen.penalty + mBonus.bonus;
  if (!Number.isFinite(raw)) raw = 0;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return { score, reasons };
}

/**
 * Map a numeric score to a level token used by the listing CSS.
 *   80-100 → "high"   (green)
 *   60-79  → "mid"    (cyan)
 *   40-59  → "low"    (amber)
 *   <40    → "poor"   (gray)
 * @param {number} score
 * @returns {"high"|"mid"|"low"|"poor"}
 */
export function levelForScore(score) {
  const n = Number(score) | 0;
  if (n >= 80) return "high";
  if (n >= 60) return "mid";
  if (n >= 40) return "low";
  return "poor";
}
