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
// City synonym helper — Mexican cities + common metro-area variants
// ============================================================================
//
// expandCitySynonyms takes a city name (any casing/diacritics) and returns
// a deduped list of normalized variants the user might see in a job
// listing's location field. Lookup is purely table-based — for the top-20
// Mexican cities — and silently falls back to just [normalizedInput] for
// anything not in the table, so a typo or an out-of-Mexico city doesn't
// crash the caller. Used by computeMatchScore for the city-match bonus.
const CITY_SYNONYMS = {
  // Mexico City + alternates. Drivers: users write "CDMX", "DF", or the
  // full name interchangeably; some listings still say "Mexico City".
  "ciudad de mexico": ["cdmx", "df", "mexico city", "mx city", "ciudad mexico"],
  "cdmx": ["ciudad de mexico", "df", "mexico city", "mx city"],
  "df": ["ciudad de mexico", "cdmx", "mexico city"],
  "mexico city": ["ciudad de mexico", "cdmx", "df"],
  // GDL metro area — most postings include suburbs as the location.
  "guadalajara": ["gdl", "zapopan", "tlaquepaque", "tonala"],
  "gdl": ["guadalajara", "zapopan", "tlaquepaque"],
  "zapopan": ["guadalajara", "gdl", "tlaquepaque"],
  // MTY metro area.
  "monterrey": ["mty", "san pedro garza garcia", "san nicolas", "san nicolas de los garza", "apodaca", "guadalupe"],
  "mty": ["monterrey", "san pedro garza garcia", "san nicolas"],
  "san pedro garza garcia": ["monterrey", "mty", "san pedro"],
  // Querétaro
  "queretaro": ["qro", "santiago de queretaro", "el marques", "corregidora"],
  "qro": ["queretaro", "santiago de queretaro"],
  // Puebla
  "puebla": ["pue", "cholula", "san andres cholula", "san pedro cholula"],
  "pue": ["puebla", "cholula"],
  // Tijuana
  "tijuana": ["tj", "tijuana baja california"],
  "tj": ["tijuana"],
  // Mérida / Yucatán
  "merida": ["yucatan", "merida yucatan"],
  // Chihuahua / Juárez
  "ciudad juarez": ["juarez", "cd juarez", "cd. juarez"],
  "juarez": ["ciudad juarez", "cd juarez"],
  "chihuahua": ["chih", "ciudad de chihuahua"],
  // León / Bajío
  "leon": ["leon guanajuato", "guanajuato", "lebn"],
  "guanajuato": ["leon", "irapuato"],
  // Cancún / QR
  "cancun": ["quintana roo", "qroo", "playa del carmen"],
  // Veracruz / Boca / Xalapa
  "veracruz": ["boca del rio", "boca", "ver"],
  "xalapa": ["jalapa", "veracruz"],
  // Toluca / Edomex
  "toluca": ["edomex", "estado de mexico", "metepec"],
  "estado de mexico": ["edomex", "toluca", "naucalpan", "tlalnepantla", "ecatepec", "satelite"],
  "edomex": ["estado de mexico", "toluca"],
  // Aguascalientes
  "aguascalientes": ["ags"],
  // San Luis Potosí
  "san luis potosi": ["slp", "slp."],
  "slp": ["san luis potosi"],
  // Saltillo / Coahuila
  "saltillo": ["coahuila", "ramos arizpe"],
  // Hermosillo / Sonora
  "hermosillo": ["sonora", "hmo"]
};

/**
 * Expand a city name into the list of normalized variants the user might
 * see in a vacancy's location string. Pure / no-throw / cheap.
 *
 *   expandCitySynonyms("CDMX")
 *     → ["cdmx", "ciudad de mexico", "df", "mexico city", "mx city"]
 *
 * Unknown inputs fall back to just the normalized form, so the caller can
 * still run a substring match against it without special-casing.
 *
 * @param {string} city
 * @returns {string[]} deduped, normalized list (always includes the input)
 */
export function expandCitySynonyms(city) {
  const norm = normalize(city || "");
  if (!norm) return [];
  const out = new Set([norm]);
  const direct = CITY_SYNONYMS[norm];
  if (Array.isArray(direct)) {
    for (const v of direct) {
      const n = normalize(v);
      if (n) out.add(n);
    }
  }
  return Array.from(out);
}

// ============================================================================
// Preferences-aware bonuses (city / modality / salary)
// ============================================================================
//
// These layer on top of the base scoring functions and only apply when the
// caller passes a non-null `preferences` object that has at least one of
// city / modality / salary set. The bonuses are intentionally additive and
// the penalties are modest — the user said "prioritize, don't filter".

/**
 * City-match bonus. Compares the job's location string against the user's
 * preferred city + synonyms (computed via expandCitySynonyms).
 *
 *   match (any synonym substring hit) → +12, reason "Ubicación: <city> ✓"
 *   no city set                       → 0
 *   set but mismatch                  → -5, reason "Ubicación distinta…"
 *
 * @param {{ city?: string, citySynonyms?: string[] }|null} preferences
 * @param {{ location?: string, title?: string }} jobLite
 * @returns {{ bonus: number, reason: string|null }}
 */
function preferenceCityBonus(preferences, jobLite) {
  const city = preferences?.city ? String(preferences.city).trim() : "";
  if (!city) return { bonus: 0, reason: null };
  // Build the search list. Prefer the persisted citySynonyms (computed by
  // options.js when the user saves) but fall back to a fresh expansion so
  // the function is correct even if the caller passed a half-built object.
  let synonyms = Array.isArray(preferences?.citySynonyms) && preferences.citySynonyms.length
    ? preferences.citySynonyms.slice()
    : expandCitySynonyms(city);
  // Normalize once.
  synonyms = synonyms.map((s) => normalize(s)).filter(Boolean);
  if (!synonyms.length) synonyms = [normalize(city)];
  // Look in the location field first — that's where listings put the city.
  // Fall back to the title because some listings put "(Remoto, CDMX)" or
  // "Ejecutivo Tech Lead — Guadalajara" in the title itself.
  const haystack = normalize(`${jobLite?.location || ""} ${jobLite?.title || ""}`);
  if (!haystack) return { bonus: 0, reason: null };
  for (const s of synonyms) {
    // Skip ultra-short synonyms that would false-positive (e.g. "tj"
    // would match "tj-test" inside a noisy title). Two-char codes still
    // pass when they're followed by a word boundary, which our
    // normalize() guarantees because punctuation becomes spaces.
    if (s.length < 2) continue;
    if (s.length === 2) {
      const re = new RegExp(`\\b${s}\\b`);
      if (re.test(haystack)) return { bonus: 12, reason: `Ubicación: ${city} ✓` };
      continue;
    }
    if (haystack.includes(s)) {
      return { bonus: 12, reason: `Ubicación: ${city} ✓` };
    }
  }
  return { bonus: -5, reason: "Ubicación distinta a tu preferencia" };
}

/**
 * Detect the modality of a job from its title + location text. We look for
 * remote / hybrid / on-site keywords; default to null (unknown).
 * @param {string} normalizedText
 * @returns {"remoto"|"hibrido"|"presencial"|null}
 */
function detectJobModality(normalizedText) {
  if (!normalizedText) return null;
  // Hybrid first — "hibrido" + "remoto" are commonly co-mentioned and we
  // want hybrid to win that match (it's the more specific signal).
  if (/\b(hibrido|hybrid|semipresencial)\b/.test(normalizedText)) return "hibrido";
  if (/\b(remoto|remote|home\s*office|teletrabajo|a\s*distancia)\b/.test(normalizedText)) return "remoto";
  if (/\b(presencial|en\s*sitio|on\s*site|onsite|in\s*office)\b/.test(normalizedText)) return "presencial";
  return null;
}

/**
 * Modality preference bonus. Compares the user's preferred modality to the
 * one detected in the job text.
 *
 *   any → no effect
 *   match → +8, reason "Modalidad: <m> ✓"
 *   mismatch → -4, reason "Modalidad: prefieres <pref> pero esta es <job>"
 *   no signal in job → no effect (don't penalize unknown)
 *
 * @param {{ modality?: string }|null} preferences
 * @param {{ title?: string, location?: string, description?: string }} jobLite
 * @returns {{ bonus: number, reason: string|null }}
 */
function preferenceModalityBonus(preferences, jobLite) {
  const pref = preferences?.modality;
  if (!pref || pref === "any") return { bonus: 0, reason: null };
  const text = normalize(`${jobLite?.title || ""} ${jobLite?.location || ""} ${jobLite?.description || ""}`);
  const job = detectJobModality(text);
  if (!job) return { bonus: 0, reason: null };
  if (job === pref) {
    return { bonus: 8, reason: `Modalidad: ${pref} ✓` };
  }
  return { bonus: -4, reason: `Modalidad: prefieres ${pref} pero esta es ${job}` };
}

/**
 * Pull a (min, max) MXN tuple from a free-text salary blob. Tries:
 *   $20,000 - $30,000 MXN
 *   $20,000 a $30,000 mensuales
 *   20k-30k MXN
 *   $25,000 al mes  (single number → returned as { min: 25000, max: 25000 })
 *   25,000 - 30,000   (no $)
 * Returns null when nothing parses or the parsed numbers look implausible
 * (we cap to 1..1,000,000 to reject phone numbers / years / IDs).
 *
 * @param {string} text
 * @returns {{ min: number, max: number }|null}
 */
function parseSalaryRange(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();

  // First try: dollar-anchored ranges with explicit numbers.
  //   $20,000 - $30,000 MXN
  //   $20,000.00 a $30,000
  let m = lower.match(/\$\s*([\d.,]+)\s*(?:[-–—]|a|hasta|to)\s*\$?\s*([\d.,]+)/);
  if (m) {
    const lo = parseSalaryNumber(m[1]);
    const hi = parseSalaryNumber(m[2]);
    if (lo && hi && lo <= hi) return clampSalaryTuple(lo, hi);
  }
  // "20k - 30k" / "20k a 30k" — k-suffix shorthand.
  m = lower.match(/(\d{1,3}(?:[.,]\d{1,3})?)\s*k\s*(?:[-–—]|a|hasta|to)\s*(\d{1,3}(?:[.,]\d{1,3})?)\s*k/);
  if (m) {
    const lo = parseSalaryNumber(m[1]) * 1000;
    const hi = parseSalaryNumber(m[2]) * 1000;
    if (lo && hi && lo <= hi) return clampSalaryTuple(lo, hi);
  }
  // Single dollar amount — fall back to a degenerate range.
  //   "$25,000 al mes"
  m = lower.match(/\$\s*([\d.,]+)\s*(?:mxn|al\s*mes|mensuales|por\s*mes)/);
  if (m) {
    const v = parseSalaryNumber(m[1]);
    if (v) return clampSalaryTuple(v, v);
  }
  // Bare-number range that explicitly mentions MXN / al mes nearby.
  m = lower.match(/([\d.,]+)\s*(?:[-–—]|a)\s*([\d.,]+)\s*(?:mxn|al\s*mes|mensuales)/);
  if (m) {
    const lo = parseSalaryNumber(m[1]);
    const hi = parseSalaryNumber(m[2]);
    if (lo && hi && lo <= hi) return clampSalaryTuple(lo, hi);
  }
  return null;
}

function parseSalaryNumber(s) {
  if (!s) return 0;
  // Strip thousands separators (commas) and treat dots as decimals only
  // when the number ends in .NN (otherwise dot is also a thousands sep).
  let cleaned = String(s).replace(/,/g, "");
  // If "20.000" — Spanish style with dot as thousands — drop the dot.
  if (/^\d{1,3}\.\d{3}(\.\d{3})*$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "");
  }
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function clampSalaryTuple(lo, hi) {
  if (lo < 1 || hi > 1_000_000) return null;
  return { min: Math.round(lo), max: Math.round(hi) };
}

// ============================================================================
// Implicit preferences from CV
// ============================================================================
//
// Many users won't bother filling the preferences card in Options on first
// run. To still give them a useful filtered ranking, we derive sensible
// defaults from the profile they already uploaded:
//   - city           ← profile.personal.location (e.g. "CDMX, México")
//   - modality       ← scan summary + experience for "remoto"/"híbrido" hints
//   - salaryMin/Max  ← scan summary + rawText for explicit salary mentions
//                     ("expectativa salarial: $30,000 - $50,000 MXN")
//
// Saved preferences ALWAYS win — these are only used as the fallback when
// the user hasn't explicitly set anything yet. Returns the same shape the
// preference-aware bonus helpers expect, so the call site can substitute
// it directly into computeMatchScore's third argument.

/**
 * Pull implicit preferences out of a parsed profile. All fields are nullable:
 * if we can't find a confident value, we leave it null so the bonus helpers
 * skip that dimension instead of guessing.
 *
 * @param {Object|null} profile
 * @returns {{
 *   city: string|null,
 *   citySynonyms: string[],
 *   modality: "presencial"|"remoto"|"hibrido"|"any",
 *   salaryMin: number|null,
 *   salaryMax: number|null,
 *   source: "cv"
 * }}
 */
export function deriveImplicitPreferences(profile) {
  const empty = {
    city: null,
    citySynonyms: [],
    modality: "any",
    salaryMin: null,
    salaryMax: null,
    source: "cv"
  };
  if (!profile || typeof profile !== "object") return empty;

  // 1) City — straight from personal.location. We deliberately don't try
  //    to "clean" it ("CDMX, México" stays as the user wrote it) because
  //    expandCitySynonyms handles the variants downstream.
  const rawCity = profile.personal?.location || "";
  const city = rawCity.trim() || null;
  const citySynonyms = city ? expandCitySynonyms(city) : [];

  // 2) Modality — scan summary + experience descriptions for hints.
  //    We look for the strongest signal in this priority order: explicit
  //    expectation → recent experience modality → none.
  const blob = [
    profile.summary || "",
    ...(profile.experience || []).map((e) => `${e?.role || ""} ${e?.description || ""}`)
  ].join(" ").toLowerCase();
  let modality = "any";
  // Phrases like "busco trabajo remoto", "preferencia: remoto", "100%
  // remoto"  → strong signal. Generic mentions ("trabajé remoto en X") →
  // weaker, only used as fallback.
  if (/\b(busco|busqueda|preferencia|interes|interes(?:a|ado)|me interesa|deseo)\b[^.]{0,40}\bremoto\b/.test(blob)
      || /\b100\s*%?\s*remoto\b/.test(blob)) {
    modality = "remoto";
  } else if (/\b(busco|busqueda|preferencia)\b[^.]{0,40}\bhibrido\b/.test(blob)
      || /\b100\s*%?\s*hibrido\b/.test(blob)) {
    modality = "hibrido";
  } else if (/\b(remoto|home\s*office|teletrabajo|a\s*distancia)\b/.test(blob)) {
    // Soft fallback: any mention of remote work in the profile counts as
    // a mild preference. Users who don't want it tend to specify
    // "presencial" explicitly.
    modality = "remoto";
  } else if (/\bhibrido\b/.test(blob)) {
    modality = "hibrido";
  } else if (/\bpresencial\b/.test(blob)) {
    modality = "presencial";
  }

  // 3) Salary — look for an explicit expectation in summary + rawText.
  //    rawText (if Gemini stored the original CV text) often has lines
  //    like "Expectativa salarial: $35,000 - $45,000 MXN" that didn't
  //    make it into the structured fields.
  const salaryHaystack = [
    profile.summary || "",
    profile.rawText || ""
  ].join(" ");
  // Prefer expectation-tagged ranges first — they're the clearest signal
  // that the user told us what they want, vs. mentioning a range from a
  // previous job that we shouldn't treat as a current preference.
  const expectationRx =
    /(expectativa|pretensi[oó]n|sueldo deseado|salario deseado|ingreso esperado)\s*(?:salarial)?\s*[:\-–]?\s*([^\n.]{0,80})/i;
  const m = salaryHaystack.match(expectationRx);
  let salary = null;
  if (m && m[2]) salary = parseSalaryRange(m[2]);
  if (!salary) {
    // Fall back to a generic salary range anywhere in summary/rawText.
    salary = parseSalaryRange(salaryHaystack);
  }
  const salaryMin = salary ? salary.min : null;
  const salaryMax = salary ? salary.max : null;

  return { city, citySynonyms, modality, salaryMin, salaryMax, source: "cv" };
}

/**
 * Merge saved preferences with implicit defaults from the CV. Saved values
 * always win when set; implicit values fill the gaps. Returns null if both
 * sources are empty (so callers can short-circuit the bonus pass entirely).
 *
 * @param {Object|null} saved — chrome.storage.local["eamx:preferences"]
 * @param {Object|null} profile — chrome.storage.local["userProfile"]
 * @returns {Object|null}
 */
export function effectivePreferences(saved, profile) {
  const implicit = deriveImplicitPreferences(profile);
  // Treat empty-strings / "any" as "not set" so they don't clobber implicit.
  const haveSavedCity = saved?.city && String(saved.city).trim();
  const haveSavedModality = saved?.modality && saved.modality !== "any";
  const haveSavedMin = Number.isFinite(saved?.salaryMin) && saved.salaryMin > 0;
  const haveSavedMax = Number.isFinite(saved?.salaryMax) && saved.salaryMax > 0;
  const merged = {
    city: haveSavedCity ? saved.city : implicit.city,
    citySynonyms: haveSavedCity ? (saved.citySynonyms || expandCitySynonyms(saved.city)) : implicit.citySynonyms,
    modality: haveSavedModality ? saved.modality : implicit.modality,
    salaryMin: haveSavedMin ? saved.salaryMin : implicit.salaryMin,
    salaryMax: haveSavedMax ? saved.salaryMax : implicit.salaryMax,
    source: (haveSavedCity || haveSavedModality || haveSavedMin || haveSavedMax) ? "merged" : "cv"
  };
  // If nothing at all is set on either side, return null so the scorer
  // skips the preference-bonus pass altogether.
  if (!merged.city && (merged.modality === "any" || !merged.modality)
      && !merged.salaryMin && !merged.salaryMax) {
    return null;
  }
  return merged;
}

/**
 * Salary preference bonus. Looks for any salary text inside the job and
 * compares to the user's preferred range.
 *
 *   no salary visible → no effect (most listings hide it)
 *   overlap with prefs → +10, reason "Salario en rango: …"
 *   below prefs.salaryMin → -5
 *   above prefs.salaryMax → no effect (always good news)
 *
 * @param {{ salaryMin?: number, salaryMax?: number }|null} preferences
 * @param {{ description?: string, title?: string, salary?: string }} jobLite
 * @returns {{ bonus: number, reason: string|null }}
 */
function preferenceSalaryBonus(preferences, jobLite) {
  const minPref = Number.isFinite(preferences?.salaryMin) ? preferences.salaryMin : null;
  const maxPref = Number.isFinite(preferences?.salaryMax) ? preferences.salaryMax : null;
  if (minPref == null && maxPref == null) return { bonus: 0, reason: null };
  // Aggregate every textual field that might mention a number — listing
  // cards rarely have a dedicated salary slot, so we glob title + desc.
  const blob = `${jobLite?.salary || ""} ${jobLite?.description || ""} ${jobLite?.title || ""}`;
  const range = parseSalaryRange(blob);
  if (!range) return { bonus: 0, reason: null };
  const lo = minPref ?? 0;
  const hi = maxPref ?? Infinity;
  // Overlap test: ranges overlap if max >= prefMin && min <= prefMax.
  const overlaps = range.max >= lo && range.min <= hi;
  if (overlaps) {
    return {
      bonus: 10,
      reason: `Salario en rango: ${range.min.toLocaleString("es-MX")}-${range.max.toLocaleString("es-MX")} MXN`
    };
  }
  // Below the user's floor — small penalty.
  if (range.max < lo) return { bonus: -5, reason: null };
  // Above ceiling — that's fine, no penalty.
  return { bonus: 0, reason: null };
}

// True iff at least one preference dimension is meaningfully set.
function preferencesHaveAnyFilter(preferences) {
  if (!preferences || typeof preferences !== "object") return false;
  if (preferences.city && String(preferences.city).trim()) return true;
  if (preferences.modality && preferences.modality !== "any") return true;
  if (Number.isFinite(preferences.salaryMin)) return true;
  if (Number.isFinite(preferences.salaryMax)) return true;
  return false;
}

/**
 * Compute and apply preference bonuses to a base score. Mutates `reasons`
 * in place by appending any new explanation lines. Returns the delta to
 * add to the raw score (can be positive or negative). When `preferences`
 * is null/empty this returns 0 and leaves reasons untouched — i.e. the
 * scoring is byte-for-byte identical to the pre-preferences code path.
 *
 * @param {Object|null} preferences
 * @param {Object} jobLite
 * @param {string[]} reasons   in/out
 * @returns {number}
 */
function applyPreferenceBonuses(preferences, jobLite, reasons) {
  if (!preferencesHaveAnyFilter(preferences)) return 0;
  let delta = 0;
  const c = preferenceCityBonus(preferences, jobLite);
  if (c.reason) reasons.push(c.reason);
  delta += c.bonus;
  const m = preferenceModalityBonus(preferences, jobLite);
  if (m.reason) reasons.push(m.reason);
  delta += m.bonus;
  const sal = preferenceSalaryBonus(preferences, jobLite);
  if (sal.reason) reasons.push(sal.reason);
  delta += sal.bonus;
  return delta;
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
 * @param {Object|null} [preferences] — UserPreferences with optional
 *   { city, citySynonyms, modality, salaryMin, salaryMax }. When present
 *   and at least one dimension is set, layers city/modality/salary
 *   bonuses on top of the base score. Pass null for the legacy behavior.
 * @returns {{ score: number, reasons: string[] }}
 */
export function computeMatchScore(profile, jobLite, preferences = null) {
  const reasons = [];
  if (!profile || typeof profile !== "object") {
    // Even without a profile we can still apply preferences (e.g. the user
    // set a city but hasn't uploaded a CV yet) — but the listing CTA reads
    // 0% match, which is meaningless. Keep the guidance message and bail.
    return { score: 0, reasons: ["Sube tu CV en Opciones para ver match scores"] };
  }
  if (!jobLite || typeof jobLite !== "object") {
    return { score: 0, reasons: [] };
  }

  // Listing cards (LaPieza /vacantes, OCC search results, etc.) only expose
  // title + company + maybe location. Descriptions and requirements live on
  // the detail page. The original Jaccard-based algorithm undershot heavily
  // on these thin payloads — every score landed at 0-1% — because the JD
  // bag had ~3 tokens vs the profile's ~500. Detect that case and switch to
  // a title-anchored model that the user can reasonably trust.
  const hasRichJob =
    (typeof jobLite.description === "string" && jobLite.description.length > 80) ||
    (Array.isArray(jobLite.requirements) && jobLite.requirements.length >= 2);

  if (!hasRichJob) {
    return computeListingMatchScore(profile, jobLite, preferences);
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

  // 5) Modality bonus (profile↔job remote co-mention — separate from the
  // user's explicit modality preference handled below).
  const mBonus = modalityBonus(profile, jobText);
  if (mBonus.reason) reasons.push(mBonus.reason);

  // 6) Preference bonuses (city / modality preference / salary). No-op
  // when preferences arg is missing or has no filters set.
  const prefDelta = applyPreferenceBonuses(preferences, jobLite, reasons);

  // 7) Combine + clamp.
  let raw = base + sBonus + tBonus.bonus + yPen.penalty + mBonus.bonus + prefDelta;
  if (!Number.isFinite(raw)) raw = 0;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return { score, reasons };
}

// ============================================================================
// Listing-mode scoring — thin data path
// ============================================================================
//
// When we only have title + company + maybe location, the full algorithm
// undershoots because the Jaccard between a 500-token profile and a 4-token
// title is essentially 0. This path uses a different shape:
//
//   Base 35 (we have so little data, default to "potential fit")
//   +14 per skill that appears in the title    (max +28)
//   +18 per profile.experience.role token that overlaps job.title  (max +30)
//   +8 per profile.summary token that overlaps job.title  (max +16)
//   +3 modality bonus when both mention remote
//
// Reasons reported are keyed off the strongest signal first so the panel
// shows useful explanations even on title-only matches. We deliberately
// don't apply the years penalty here — the listing card never says "5
// años" so it would always be 0 anyway.
/**
 * Listing-mode scoring path. Same shape as computeMatchScore but optimized
 * for thin payloads (title-only cards). `preferences` is honored exactly
 * as in the rich path — bonuses layer on top of the listing base score.
 *
 * @param {Object} profile
 * @param {Object} jobLite
 * @param {Object|null} [preferences]
 * @returns {{ score: number, reasons: string[] }}
 */
export function computeListingMatchScore(profile, jobLite, preferences = null) {
  const reasons = [];
  const titleNorm = normalize(jobLite?.title || "");
  if (!titleNorm) return { score: 0, reasons: [] };
  const titleTokens = tokenize(titleNorm, 50);

  // 1) Skill matches against the title — strong signal because if the
  // title literally says "Python Developer" and you have Python, that's
  // about as good as it gets on a listing card.
  const skillMatches = [];
  for (const skillRaw of profile.skills || []) {
    const s = normalize(skillRaw);
    if (!s || s.length < 2) continue;
    if (titleNorm.includes(s)) skillMatches.push(skillRaw);
  }
  const skillBonus = Math.min(skillMatches.length * 14, 28);
  if (skillMatches.length) {
    const top = skillMatches.slice(0, 3).join(", ");
    reasons.push(
      `${skillMatches.length} skill${skillMatches.length === 1 ? "" : "s"} en el título: ${top}`
    );
  }

  // 2) Role overlap — tokens from past roles that show up in the title.
  // Strongest signal for "you've done this exact kind of work before".
  const roleTokens = new Set();
  for (const e of profile?.experience || []) {
    for (const t of tokenize(normalize(e?.role || ""), 50)) roleTokens.add(t);
  }
  const titleTokenSet = new Set(titleTokens);
  let roleOverlap = 0;
  const roleMatches = [];
  for (const t of titleTokens) {
    if (roleTokens.has(t)) {
      roleOverlap++;
      if (roleMatches.length < 3) roleMatches.push(t);
    }
  }
  const roleBonusPts = Math.min(roleOverlap * 18, 30);
  if (roleMatches.length) {
    reasons.push(
      `Tu experiencia incluye: ${roleMatches.join(", ")}`
    );
  }

  // 3) Summary overlap — tokens from the user's summary that show up in
  // the title. Captures "I'm a sales ops person" → "Sales Operations" job.
  const summaryTokens = new Set(tokenize(normalize(profile?.summary || ""), 200));
  let summaryOverlap = 0;
  const summaryMatches = [];
  for (const t of titleTokens) {
    if (summaryTokens.has(t) && !roleTokens.has(t)) {
      summaryOverlap++;
      if (summaryMatches.length < 3) summaryMatches.push(t);
    }
  }
  const summaryBonusPts = Math.min(summaryOverlap * 8, 16);
  if (summaryMatches.length) {
    reasons.push(`Alinea con tu resumen: ${summaryMatches.join(", ")}`);
  }

  // 4) Modality — listing cards often say "Remoto en …" / "Híbrido en …".
  const locationText = normalize(`${jobLite?.location || ""} ${jobLite?.title || ""}`);
  const profileText = normalize(
    `${profile?.summary || ""} ${(profile?.experience || []).map((e) => e?.role || "").join(" ")}`
  );
  const wantsRemote = /\b(remoto|remote|home\s*office|teletrabajo|a\s*distancia)\b/.test(profileText);
  const isRemote = /\b(remoto|remote|home\s*office|teletrabajo|a\s*distancia)\b/.test(locationText);
  const modalityPts = wantsRemote && isRemote ? 3 : 0;
  if (modalityPts) reasons.push("Ambos mencionan remoto");

  const base = 35;
  // Preference bonuses (city / modality / salary). Applied AFTER the base
  // listing math so the layering is identical to the rich-job path. No-op
  // when preferences arg is null or has no filters set.
  const prefDelta = applyPreferenceBonuses(preferences, jobLite, reasons);
  const raw = base + skillBonus + roleBonusPts + summaryBonusPts + modalityPts + prefDelta;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  // If we got nothing at all, leave a single explanatory line so the user
  // knows why the score is low (rather than thinking the algorithm is broken).
  if (!reasons.length) {
    reasons.push("Sin coincidencias claras con el título — abre la vacante para ver detalles");
  }
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
