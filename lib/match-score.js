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
// Generic role-suffix tokens that should NOT count as role-overlap on
// their own. A user with "Business Developer" in their CV shouldn't be
// matched to "IT Solution Developer" just because both contain "developer".
// We require the overlap to include at least one NON-suffix anchor token
// (the "discipline" of the role).
const ROLE_GENERIC_SUFFIXES = new Set([
  "developer", "manager", "specialist", "analyst", "coordinator",
  "executive", "director", "engineer", "lead", "senior", "junior",
  "associate", "partner", "consultant", "advisor", "owner", "head",
  "chief", "officer", "supervisor", "assistant", "trainee", "intern",
  "professional", "agent", "representative",
  // English/Spanish length variants
  "ejecutivo", "gerente", "lider", "jefe", "asesor", "asistente",
  "responsable", "encargado", "auxiliar", "becario", "practicante",
  "analista", "coordinador", "especialista",
  // common abbreviations
  "sr", "jr", "ii", "iii", "iv"
]);

// Domain buckets for sanity-checking role matches. If the profile is
// dominantly "sales/marketing" and the job title is dominantly "tech", a
// shared "developer" token is almost certainly a false positive — we
// apply a penalty instead of a bonus.
//
// Each bucket has 30-100 normalized tokens (ES + EN + Mexican market
// abbreviations + common variants). Tokens are matched as exact set
// membership against the title/profile token bag — no substring fuzzy
// matching here, that lives in the skill/role passes.
//
// Expansion priorities:
//   - Mexican-market specific terms (kam, pdv, sucursal, promotor)
//   - English/Spanish doublets (sales/ventas, finance/finanzas)
//   - Singular/plural variants
//   - Common abbreviations (rrhh, tic, ehs, gpm, sla, kpi)
//   - Tools/platforms that signal a domain (hubspot → marketing/sales,
//     sap → ops/finance, salesforce → sales/crm)
const DOMAIN_BUCKETS = {
  // Ventas comerciales
  sales: [
    "sales", "ventas", "vendedor", "vendedora", "vendedores", "comercial",
    "comerciales", "business", "negocios", "negocio", "client", "cliente",
    "clientes", "account", "cuenta", "cuentas", "kam", "growth", "revenue",
    "ingresos", "channel", "canal", "canales", "cierre", "cierres",
    "prospect", "prospeccion", "lead", "leads", "demand", "demanda",
    "key", "executive", "ejecutivo", "ejecutiva", "asesor", "asesora",
    "agente", "representante", "promotor", "promotora", "telemarketing",
    "telesales", "televenta", "televentas", "hunter", "farmer", "b2b",
    "b2c", "ecommerce", "salesforce", "hubspot", "crm", "pipeline",
    "quota", "cuota", "comision", "comisiones", "bdr", "sdr", "outbound",
    "inbound", "outside", "inside", "field", "campo", "kams", "acquisition",
    "adquisicion", "wholesale", "mayoreo", "menudeo", "retail",
    "consultor", "asesoramiento", "negociacion", "negociar", "closer",
    "presupuesto", "cotizacion", "cotizaciones", "sucursal", "sucursales",
    "preventa", "postventa",
    // Pre/post-sales + sales engineering
    "presales", "postsales", "preventas", "postventas", "sales-engineer",
    "sales", "engineer", "ingeniero-de-ventas", "ingeniero-comercial",
    "solutions", "solution", "consulting", "consultivo", "consultiva",
    // Channel / partners
    "partner", "partners", "channel-partner", "distribuidor", "distribuidora",
    "distribuidores", "mayorista", "minorista", "indirecta", "directa",
    "ditribucion", "distribucion", "reseller", "var", "msp", "isv",
    // Roles & acronyms
    "csm", "ksm", "ksam", "isr", "ase", "fse", "rsm", "nsm",
    "vp-sales", "cro", "chief-revenue", "head-of-sales",
    "customer-success", "customer-success-manager", "exito-cliente",
    // ABM & lead methodologies
    "abm", "account-based", "lead-qualification", "calificacion-leads",
    "bant", "meddic", "meddpicc", "spin", "challenger", "sandler",
    "spiced", "ariba", "linkedin-sales-navigator", "sales-navigator",
    // Sales ops & enablement
    "sales-ops", "salesops", "sales-operations", "operaciones-comerciales",
    "comp-plans", "compplans", "plan-de-compensacion", "comisionado",
    "sales-enablement", "enablement", "habilitacion-comercial",
    "outreach", "salesloft", "gong", "chorus", "apollo", "zoominfo",
    "lusha", "clay",
    // Deal cycle / artifacts
    "demo", "demos", "presentacion", "pitch", "rfp", "rfq", "rfi",
    "propuesta", "propuestas", "contrato", "contratos", "kit",
    "kit-comercial", "deal", "deals", "won", "lost", "ganado", "perdido",
    "forecasting-comercial", "pronostico", "pronosticos", "renewal",
    "renovacion", "renovaciones", "upsell", "cross-sell", "cross",
    "expansion", "land-and-expand", "logo", "logos", "logo-acquisition",
    // Mexican slang / common roles
    "chamba", "jale", "vendetodo", "puerta-puerta", "tocapuertas",
    "vendedor-foraneo", "viajero", "ruta", "route-sales",
    "promotoria", "promotoras", "demostradora", "impulsador",
    "impulsadora", "edecan", "edecanes",
    // Industries hiring sales
    "trade-marketing", "trade", "horeca", "on-premise", "off-premise",
    "moderno", "tradicional", "consumo", "consumo-masivo", "fmcg",
    "cpg", "industrial-sales", "tecnico-comercial"
  ],
  // Marketing y comunicación
  marketing: [
    "marketing", "mercadotecnia", "mercadologo", "mercadologa", "mkt",
    "brand", "branding", "marca", "marcas", "campaign", "campaña",
    "campañas", "content", "contenido", "contenidos", "seo", "sem",
    "performance", "social", "media", "medios", "publicidad", "publicista",
    "advertising", "ads", "ad", "anuncios", "anuncio", "creative",
    "creativo", "creativa", "comms", "communications", "comunicacion",
    "comunicaciones", "comunicador", "comunicadora", "digital",
    "demand", "generation", "ppc", "cpa", "ctr", "roas",
    "email", "newsletter", "hubspot", "mailchimp", "marketo",
    "google", "facebook", "meta", "instagram", "tiktok",
    "youtube", "linkedin", "influencer", "influencers", "community",
    "cm", "copywriter", "copywriting", "redactor", "redaccion",
    "storytelling", "endomarketing", "trade", "atl", "btl", "ooh",
    "merchandising", "shopper", "consumer", "consumidor",
    "insights", "messaging", "posicionamiento",
    "lanzamiento", "lanzamientos", "evento", "eventos", "activacion",
    "activaciones", "patrocinio", "patrocinios", "pr", "rp", "relaciones",
    "publicas",
    // Lifecycle / retention / growth
    "lifecycle", "lifecycle-marketing", "retention-marketing", "retencion",
    "growth-marketing", "growth-hacking", "viral", "k-factor", "loops",
    "pmf", "product-market-fit", "ajuste-producto-mercado",
    // Attribution / analytics
    "attribution", "atribucion", "mta", "mmm", "marketing-mix",
    "last-touch", "first-touch", "multitouch", "ultima-interaccion",
    "data-driven-attribution", "ga4", "google-analytics",
    "analytics-marketing", "looker", "datastudio", "looker-studio",
    "tag-manager", "gtm", "segment", "cdp", "rudderstack",
    // Funnel
    "conversion", "conversiones", "conversión", "funnel", "embudo",
    "tofu", "mofu", "bofu", "top-of-funnel", "bottom-of-funnel",
    "direct-response", "respuesta-directa",
    // Brand / awareness / research
    "awareness", "recall", "top-of-mind", "tom", "share-of-voice", "sov",
    "share-of-market", "som", "tracking-de-marca", "u&a", "usage",
    "research", "investigacion", "estudios-de-mercado", "estudios",
    "kantar", "ipsos", "nielsen", "gfk",
    // Briefs & process
    "brief", "brief-creativo", "briefing", "debriefing", "creative-brief",
    "agencia", "agency-side", "client-side", "agencia-de-publicidad",
    // Channel acronyms
    "ttl", "dooh", "vooh",
    // Programmatic & paid media
    "programmatic", "programatica", "rtb", "dsp", "ssp",
    "header-bidding", "trafico", "traffic-manager", "media-buying",
    "media-planner", "planeacion-de-medios", "compra-de-medios",
    // Audiences
    "segmentacion", "targeting", "lookalike", "audience", "audiencia",
    "audiencias", "first-party", "second-party", "third-party",
    "primero", "second", "third", "party", "data",
    // Modern marketing platforms
    "klaviyo", "iterable", "braze", "customer-io", "sendgrid",
    "intercom", "drift", "activecampaign", "convertkit",
    "zapier", "make", "n8n",
    // SEO content
    "ahrefs", "semrush", "moz", "screaming-frog", "search-console",
    "backlinks", "linkbuilding", "blog", "blogger", "podcast-marketing",
    // UGC / influencer
    "ugc", "creator", "creator-economy", "ambassador", "embajador",
    "embajadores", "tiktoker", "instagrammer", "youtuber",
    // Mexican market
    "endomarca", "marca-pais", "kantar-worldpanel"
  ],
  // Tecnología / software / IT
  tech: [
    "developer", "developers", "dev", "engineer", "engineers", "engineering",
    "ingeniero", "ingeniera", "ingenieros", "software", "hardware",
    "frontend", "front", "backend", "back", "fullstack", "full",
    "stack", "devops", "sre", "platform", "cloud", "data", "datos",
    "ml", "ai", "ia", "machine", "learning", "deep", "scientist",
    "scientists", "analytics", "analytic", "qa", "qc", "tester",
    "testing", "tests", "test", "automation", "automatizacion", "tech",
    "tecnologia", "tecnologias", "tic", "tics", "systems", "sistema",
    "sistemas", "infra", "infrastructure", "infraestructura",
    "interface", "interfaz", "api", "apis", "rest",
    "graphql", "microservicios", "microservices", "javascript", "js",
    "typescript", "ts", "python", "java", "kotlin", "swift", "csharp",
    "dotnet", "ruby", "go", "rust", "php", "scala", "react", "angular",
    "vue", "node", "nodejs", "django", "flask", "rails", "spring",
    "laravel", "azure", "aws", "gcp", "kubernetes", "k8s", "docker",
    "terraform", "ansible", "jenkins", "gitlab", "github", "ti", "it",
    "programador", "programadora", "programacion", "coding", "code",
    "redes", "network", "networking", "ciberseguridad", "cyber",
    "cybersecurity", "informatica", "informatico",
    "blockchain", "web3", "nft", "iot", "embedded",
    "android", "ios", "mobile", "movil", "abap",
    "oracle", "sql", "nosql", "mongodb", "postgres", "mysql", "redis",
    "kafka", "spark", "hadoop", "etl", "elt", "dba",
    "scrum", "agile", "kanban", "sysadmin", "sap",
    // AI / LLM stack (2025-2026)
    "ai-engineer", "llm", "llms", "prompt", "prompt-engineer",
    "prompt-engineering", "rag", "retrieval-augmented", "retrieval",
    "vector", "vector-database", "vectordb", "pinecone", "weaviate",
    "chroma", "qdrant", "milvus", "embeddings", "embedding",
    "agent", "agents", "ai-agents", "langchain", "langgraph",
    "llamaindex", "openai", "anthropic", "claude", "gpt", "gpt-4",
    "gpt-5", "gemini", "mistral", "qwen", "deepseek",
    "huggingface", "hugging-face", "transformers", "transformer",
    "fine-tuning", "finetuning", "training", "lora", "adapters", "peft",
    "rlhf", "dpo", "ppo", "instruction-tuning", "instruct",
    "mlops", "llmops", "model-ops",
    // Modern web runtimes/frameworks
    "edge", "edge-computing", "edge-runtime", "deno", "bun",
    "server-components", "rsc", "server-actions", "nextjs", "next",
    "nuxt", "nuxtjs", "remix", "astro", "svelte", "sveltekit",
    "htmx", "alpine", "alpinejs", "solid", "solidjs", "qwik",
    "t3-stack", "trpc", "tanstack",
    // ORMs / dbs
    "prisma", "drizzle", "supabase", "firebase", "planetscale",
    "neon", "cockroachdb", "duckdb", "clickhouse", "snowflake",
    "bigquery", "databricks", "dbt", "airflow", "dagster", "prefect",
    // Hosting / serverless
    "vercel", "netlify", "cloudflare", "workers", "durable-objects",
    "fly", "fly-io", "railway", "render",
    "heroku", "digitalocean",
    // Observability
    "observability", "observabilidad", "opentelemetry", "otel",
    "datadog", "newrelic", "new-relic", "dynatrace", "sentry",
    "splunk", "elastic", "elasticsearch", "kibana", "logstash",
    "fluentd", "prometheus", "grafana", "jaeger", "zipkin",
    "tempo", "loki", "mimir",
    // GitOps / k8s ecosystem
    "gitops", "argocd", "argo", "flux", "helm", "lens", "k9s",
    "rancher", "openshift", "istio", "linkerd", "envoy", "consul",
    "vault", "nomad",
    // Sysadmin / networking
    "linux", "ubuntu", "centos", "rhel", "debian", "windows-server",
    "active-directory", "ad", "ldap", "vpn", "sd-wan", "mfa",
    "sso", "oauth", "oauth2", "oidc", "saml", "jwt", "scim",
    "encryption", "cifrado", "pki", "certificate", "certificado",
    "ssl", "tls", "https", "x509",
    // Languages / runtimes (additional)
    "elixir", "erlang", "haskell", "ocaml", "clojure", "fsharp",
    "perl", "lua", "dart", "flutter", "react-native", "expo",
    "ionic", "xamarin", "maui", "unity", "unreal", "godot",
    "wasm", "webassembly",
    // Data / ML libs
    "pandas", "numpy", "scipy", "sklearn", "scikit-learn", "tensorflow",
    "pytorch", "keras", "jax", "xgboost", "lightgbm", "catboost",
    "spark-ml", "mlflow", "weights-and-biases", "wandb", "comet",
    // Testing
    "jest", "vitest", "mocha", "cypress", "playwright", "selenium",
    "puppeteer", "appium", "junit", "pytest", "unittest", "rspec",
    // Build / package
    "webpack", "vite", "rollup", "esbuild", "swc", "turbo", "turbopack",
    "lerna", "pnpm", "yarn", "npm", "maven", "gradle",
    // Mexican slang for tech
    "chambeador-tech", "developer-junior", "developer-senior"
  ],
  // Operaciones / logística / supply chain
  ops: [
    "operations", "operation", "operaciones", "operacion", "operativo",
    "operativa", "logistics", "logistica", "logisticas", "supply", "cadena",
    "cadenas", "scm", "warehouse", "almacen", "almacenes", "almacenista",
    "procurement", "compras", "comprador", "compradora", "purchasing",
    "sourcing", "abastecimiento", "abasto", "planning", "planeacion",
    "scheduling", "scheduler", "process", "procesos",
    "proceso", "transporte", "transportes", "transportista",
    "shipping", "envios", "envio", "inventory", "inventario", "inventarios",
    "stock", "stocks", "wms", "tms", "erp", "manufacturing",
    "manufactura", "production", "produccion", "fabrica", "factory",
    "plant", "planta", "plantas", "lean", "kaizen", "six",
    "sigma", "kpi", "kpis", "sla", "ehs", "calidad", "quality",
    "control", "logistico", "delivery", "deliveries",
    "entregas", "entrega", "fulfillment", "outbound", "inbound",
    "trafico", "ruta", "rutas", "monitoreo",
    // System acronyms
    "mes", "scada", "oee", "otif", "slm",
    // Demand / S&OP
    "demand-planning", "planeacion-demanda", "sop", "s-op",
    "ibp", "demand-sensing", "sensing-de-demanda",
    "abc", "abc-analysis", "analisis-abc", "eoq", "lote-economico",
    "jit", "just-in-time", "justo-a-tiempo",
    "push", "pull", "mrp", "mrp2", "mrpii",
    "vmi", "vendor-managed-inventory", "consignacion",
    // Freight / customs
    "freight", "freight-forwarder", "agente-carga", "carga",
    "custom-broker", "agente-aduanal", "aduana", "aduanas",
    "customs", "immex", "importacion", "exportacion", "import",
    "export", "incoterms", "exw", "fob", "cif", "ddp", "dap",
    "fca", "cpt", "cip", "fas", "cfr",
    // Last-mile
    "last-mile", "ultimo-kilometro", "ultima-milla", "first-mile",
    "primera-milla", "cross-docking", "cross-dock", "drop-shipping",
    "dropshipping", "3pl", "4pl", "five-pl",
    // ERP / SAP modules
    "sap-mm", "sap-sd", "sap-pp", "sap-wm", "sap-ewm",
    "oracle-ebs", "netsuite", "dynamics", "dynamics-365",
    "infor", "epicor",
    // KPIs
    "fill-rate", "perfect-order", "lead-time", "ciclo-pedido",
    "inventory-turnover", "rotacion", "vueltas-inventario",
    "dso", "dpo", "ccc", "cash-conversion",
    // People / mexican slang
    "chofer-repartidor", "repartidor", "checador", "patiero",
    "operador-montacargas", "montacarguista", "estibador",
    "cuadrilla", "lider-de-cuadrilla", "supervisor-piso",
    // Last-mile platforms
    "rappi-ops", "didi-food", "uber-direct", "shopify-fulfillment",
    "skydropx", "sendero", "envia",
    // Industrial engineering
    "ingenieria-industrial", "industrial-engineer", "process-engineer",
    "mejora-continua", "continuous-improvement", "value-stream",
    "vsm"
  ],
  // Finanzas / contabilidad
  finance: [
    "finance", "financial", "financiera", "financiero", "finanzas",
    "accounting", "contabilidad", "contable", "contables", "contador",
    "contadora", "tax", "taxes", "fiscal", "fiscales", "treasury",
    "tesoreria", "tesorero", "tesorera", "audit", "auditor", "auditora",
    "auditoria", "auditorias", "controller", "contralor", "contralora",
    "controlling", "fp", "fpa", "investment", "investments", "inversion",
    "inversiones", "banking", "banca", "bancario", "bancaria", "credit",
    "credito", "creditos", "risk", "riesgo", "riesgos", "fintech",
    "trading", "trader", "broker", "brokers", "actuario", "actuarial",
    "ifrs", "nif", "gaap", "csox", "sox", "compliance",
    "regulatory", "cfo", "ceo", "cobranza",
    "cobranzas", "facturacion", "facturas", "factura", "presupuesto",
    "presupuestos", "budget", "budgeting", "forecast", "forecasting",
    "modelo", "modelado", "valuacion", "appraisal", "due", "diligence",
    "ma", "fusiones", "adquisiciones",
    // Statements
    "general-ledger", "mayor", "libro-mayor",
    "libro-diario", "asiento", "asientos", "polizas", "poliza",
    "balance", "balance-sheet", "balance-general", "estado-financiero",
    "estados-financieros", "p-l", "pyl", "profit-and-loss",
    "estado-de-resultados", "cash-flow", "flujo-de-efectivo",
    "flujo-caja", "working-capital", "capital-de-trabajo",
    // Profitability
    "ebitda", "ebit", "ebt", "margen", "margin", "margenes",
    "gross-margin", "margen-bruto", "margen-operativo",
    "margen-neto", "contribucion", "contribution-margin",
    // Returns
    "roic", "roce", "roa", "roe", "roi", "npv", "vpn", "irr", "tir",
    "wacc", "tasa-descuento",
    // Valuation
    "p-e", "ev-ebitda", "multiples", "multiplos", "comparables",
    "comps", "dcf", "discounted-cash-flow", "lbo",
    "equity", "deuda", "debt", "leverage", "apalancamiento",
    "ratios", "razones-financieras",
    // Modeling
    "financial-modeling", "modelado-financiero", "modelos-financieros",
    "three-statement", "tres-estados", "monte-carlo", "sensitivity",
    "sensibilidad", "scenario", "escenarios",
    // Reporting
    "dashboards-financieros", "board-pack", "comite", "comite-ejecutivo",
    "comex", "consejo", "consejo-de-administracion", "presentacion-cfo",
    // Mexican fiscal stack
    "sat", "cfdi", "facturacion-electronica", "complemento-pago",
    "complemento-nomina", "rfc", "iva", "isr", "ieps", "deducciones",
    "deducible", "deducibles", "csd", "buzon-tributario",
    "contpaqi", "aspel", "aspel-coi", "contabilidad-electronica",
    // Banking MX
    "spei", "speinet", "clabe", "transferencia", "deposito", "domiciliacion",
    // Crypto / fintech
    "crypto", "bitcoin", "ethereum", "stablecoin", "defi",
    "lending", "prestamos", "credito-revolvente",
    // Investment
    "ifc", "ipo", "spac", "private-equity", "pe-fund", "venture",
    "venture-capital", "capital-riesgo", "fondos",
    "asset-management", "wealth-management", "patrimonial",
    "family-office", "hedge-fund",
    "afore", "siefore", "pensiones", "pension",
    // Costs
    "costing", "costeo", "costos", "costo-de-ventas", "abc-costing",
    "standard-costing", "variance", "variaciones"
  ],
  // Recursos humanos
  hr: [
    "hr", "rrhh", "rh", "human", "humans", "humanos", "humano", "talent",
    "talento", "talentos", "recruiting", "recruitment", "recruiter",
    "reclutador", "reclutadora", "reclutamiento", "people", "personas",
    "personal", "compensation", "compensacion", "compensaciones", "comp",
    "benefits", "beneficios", "nomina", "payroll", "headhunter", "head",
    "hunter", "selection", "seleccion", "onboarding", "offboarding",
    "training", "capacitacion", "desarrollo", "ld", "ohse", "ehs",
    "clima", "engagement", "encuesta", "encuestas", "cultura", "culture",
    "employer",
    "atraccion", "retencion", "retention",
    "succession", "sucesion", "sst", "labor", "laboral",
    "hcm", "workday", "successfactors", "diversity", "diversidad",
    "inclusion", "dei",
    // Payroll software
    "contpaqi-nominas", "aspel-noi", "noi", "sap-successfactors",
    "oracle-hcm", "bamboohr", "bamboo", "adp", "kronos", "paylocity",
    "gusto", "rippling", "deel", "remote-com", "papaya", "factorial",
    "people-cloud", "buk", "runa", "worky",
    // Comp & ben
    "comp-ben", "comp-and-ben", "compensation-and-benefits",
    "salario", "sueldo", "sueldos", "bonos", "bonus", "bonificaciones",
    "prestaciones", "imss", "infonavit", "fonacot", "vales",
    "vales-despensa", "despensa", "fondo-de-ahorro", "ahorro",
    "vacaciones", "aguinaldo", "prima-vacacional", "ptu", "utilidades",
    "finiquito", "indemnizacion", "severance", "exit-interview",
    "entrevista-de-salida", "outplacement",
    // KPIs
    "kpis-rh", "headcount", "plantilla", "plantillas", "organigrama",
    "ratio-de-rotacion", "turnover", "rotacion", "absentismo",
    "ausentismo", "gpm", "gph", "hoshin",
    "organizational-design", "diseno-organizacional",
    "change-management", "gestion-del-cambio", "transformacion",
    "talent-acquisition", "tam", "employer-branding",
    "marca-empleadora", "candidate-experience",
    // Sourcing platforms
    "linkedin-recruiter", "ats", "greenhouse", "lever", "smartrecruiters",
    "iCIMS", "icims", "taleo", "jobvite", "manatal", "jobylon",
    "occmundial", "occ", "computrabajo", "indeed",
    "bumeran", "lapieza",
    // Mexican HR specific
    "sindicato", "sindicatos", "ctm", "cnt", "conciliador",
    "conciliacion", "junta-laboral", "centro-conciliacion",
    "stps", "subdelegacion-imss", "delegacion-infonavit",
    "lft", "ley-federal-del-trabajo",
    // L&D
    "linkedin-learning", "udemy-business", "coursera", "coursera-business",
    "edx-business", "platzi-empresas", "iaapa", "elearning-corporativo"
  ],
  // Diseño
  design: [
    "design", "designer", "designers", "diseno", "diseño", "diseñador",
    "diseñadora", "disenador", "disenadora", "graphic", "grafico", "grafica",
    "art", "arte", "artistic", "artistico",
    "visual", "industrial", "fashion", "moda", "interior", "interiores",
    "ux", "ui", "uxui", "prototype", "prototyping",
    "figma", "sketch", "adobe", "photoshop", "illustrator", "indesign",
    "wireframe", "wireframing", "mockup", "identidad",
    "identity", "tipografia", "typography", "ilustracion", "illustration",
    "animation", "animacion", "motion", "video", "videografia",
    "estudio",
    // Design systems
    "design-system", "design-systems", "sistema-de-diseno",
    "design-token", "tokens", "design-ops", "designops",
    "atomic-design", "atomic", "atomos", "moleculas", "organismos",
    // Brand
    "brand-guidelines", "manual-de-marca", "manual-de-identidad",
    "brand-book", "brandbook", "lookbook", "moodboard",
    "paleta", "palette", "paleta-de-color",
    // Typography
    "kerning", "leading", "tracking", "baseline", "grid", "reticula",
    "tipografica", "tipografias", "fuentes", "fonts",
    // Layout / pixel
    "pixel-perfect", "pixel", "responsive", "mobile-first",
    "desktop-first", "fluid", "adaptable",
    // Accessibility
    "accessibility", "accesibilidad", "a11y", "wcag", "contrast",
    "contraste", "aaa", "screen-reader", "lectores-pantalla",
    "axe", "lighthouse",
    // Tools (modern)
    "framer", "principle", "protopie", "lottie",
    "after-effects", "aftereffects", "premiere", "davinci",
    "blender", "cinema-4d", "c4d", "cinema4d", "houdini", "maya",
    "zbrush", "substance", "spline", "rive",
    // Other design tools
    "miro", "mural", "whimsical", "balsamiq", "axure", "invision",
    "abstract", "zeplin", "dribbble", "behance",
    // Specializations
    "service-design", "diseno-de-servicio", "experiencia-de-usuario",
    "interaction-design", "diseno-de-interaccion", "ixd",
    "product-designer", "diseno-de-producto", "industrial-designer",
    "diseno-industrial", "ui-engineer", "design-engineer",
    "editorial-designer", "packaging-designer", "diseno-empaque",
    "tipografo", "letterer", "letrista"
  ],
  // Producto digital / project management
  product: [
    "product", "products", "producto", "productos", "owner", "po",
    "scrum", "agile", "agilidad", "roadmap",
    "pm", "ppm", "program", "programa", "portfolio", "portafolio",
    "feature", "features", "user", "stories", "backlog", "sprint",
    "kanban", "lean", "ux", "research", "discovery", "delivery",
    "metric", "metricas", "metrics", "okr", "okrs", "kpi", "growth",
    "experimentacion", "experimentation", "abtesting", "ab", "amplitude",
    "mixpanel", "analytics",
    // Strategy
    "product-strategy", "estrategia-de-producto", "vision-de-producto",
    "north-star", "north-star-metric", "nsm", "metrica-norte",
    "input-metric", "output-metric",
    // Retention
    "retention-curve", "churn", "attrition", "abandono",
    "stickiness", "dau-mau", "dau", "mau", "wau",
    // Analytics tools
    "posthog", "heap", "pendo", "fullstory", "hotjar", "smartlook",
    "logrocket", "june", "june-so", "rudderstack-product",
    // Discovery
    "user-interview", "entrevista-de-usuario", "entrevistas",
    "usability-test", "prueba-de-usabilidad", "usabilidad",
    "card-sorting", "tree-testing", "ethnography", "etnografia",
    "diary-study", "diario",
    // Frameworks
    "jtbd", "jobs-to-be-done", "trabajos-a-realizar",
    "lean-startup", "design-sprint", "double-diamond", "diamante",
    "mvp", "prototype", "prototipo", "rapid-prototyping",
    "product-discovery", "descubrimiento", "opportunity-solution-tree",
    "ost", "now-next-later", "rice", "moscow", "kano",
    // Roles
    "cpo", "vpp", "vp-product", "head-of-product", "group-pm", "gpm",
    "principal-pm", "staff-pm", "associate-pm", "apm",
    // Project management
    "project-management", "gestion-de-proyectos", "asana", "trello",
    "jira", "monday", "clickup", "linear", "notion", "shortcut",
    "azure-devops", "rally", "pivotal-tracker",
    "pmp", "pmi", "prince2", "csm", "cspo", "safe", "less"
  ],
  // Legal y cumplimiento
  legal: [
    "legal", "legales", "abogado", "abogada", "abogados", "compliance",
    "cumplimiento", "contract", "contracts", "contrato", "contratos",
    "contractual", "regulatory", "regulatorio", "regulatoria", "policy",
    "policies", "politica", "politicas", "privacy", "privacidad",
    "lopd", "gdpr", "lfpdppp", "litigio", "litigation", "demanda",
    "demandas", "demandar", "ip", "intellectual", "property", "propiedad",
    "intelectual", "patent", "patente", "patentes", "trademark",
    "lawyer", "lawyers", "counsel", "in", "house",
    "corporate", "corporativo", "corporativa", "juridico",
    "juridica", "judicial", "ministerio", "publico", "notario",
    // Branches of law
    "contract-law", "derecho-civil", "derecho-mercantil",
    "derecho-laboral", "derecho-fiscal", "derecho-corporativo",
    "derecho-financiero", "derecho-bursatil", "derecho-de-amparo",
    "amparo", "amparos", "amparista", "derecho-internacional",
    "derecho-administrativo", "derecho-aduanero", "aduanal-juridico",
    "derecho-energetico", "derecho-ambiental", "derecho-de-competencia",
    "derecho-de-la-competencia", "derecho-economico",
    // Documents
    "nda", "msa", "sow", "statement-of-work", "tos",
    "terms-of-service", "terminos", "terminos-y-condiciones",
    "privacy-policy", "politica-de-privacidad", "tyc", "t-c",
    "convenio", "convenios", "carta-intencion", "loi",
    "memorandum", "term-sheet",
    // Regulators
    "arco", "derecho-arco", "inai", "ift", "cofece", "cnbv",
    "condusef", "cre", "asea", "profeco", "comer", "secretaria-economia",
    "shcp-juridico", "sat-juridico",
    // Antitrust / corporate
    "antitrust", "competencia-economica", "concentraciones",
    "due-diligence", "m-a", "joint-venture", "offshore", "holding", "fideicomiso", "fideicomisos",
    "trust", "shell-company", "spv", "vehiculo-proposito-especial",
    // Compliance specializations
    "fcpa", "ofac", "sanctions", "sanciones", "kyc", "aml",
    "lavado-dinero", "anti-corrupcion", "anticorrupcion",
    "soborno", "compliance-officer", "ethics-officer",
    // Litigation
    "arbitraje", "arbitration", "mediacion", "mediation",
    "alternative-dispute", "adr", "panel-arbitral",
    "primera-instancia", "segunda-instancia", "casacion"
  ],
  // Salud / medicina
  healthcare: [
    "medical", "medico", "medica", "medicos", "medicas", "medicine",
    "medicina", "doctor", "doctora", "doctores", "nurse", "nurses",
    "enfermero", "enfermera", "enfermeria", "salud", "health",
    "healthcare", "pharma", "farmaceutica", "farmaceutico", "pharmacy",
    "farmacia", "hospital", "hospitales", "clinica", "clinicas",
    "clinical", "clinico", "patient", "patients", "paciente", "pacientes",
    "dental", "odontologo", "odontologa", "dentist", "dentista",
    "veterinaria", "veterinario", "veterinarian", "epidemiology",
    "epidemiologo", "biotech", "biotecnologia", "biotecnologico",
    // Specializations
    "cardiologia", "cardiologo", "cardiologa", "cardiologist",
    "neurologia", "neurologo", "neuróloga", "neurologa", "neurologist",
    "oncologia", "oncologo", "oncologa", "oncologist",
    "pediatra", "pediatria", "pediatrician",
    "ginecologia", "ginecologo", "ginecologa", "gynecologist",
    "obstetra", "obstetricia",
    "traumatologo", "traumatologia", "ortopedista", "ortopedia",
    "dermatologo", "dermatologia", "dermatologist",
    "psiquiatra", "psiquiatria", "psychiatrist",
    "psicologo", "psicologa", "psicologia", "psychologist",
    "psicoterapeuta", "psicoterapia", "psychotherapist",
    "terapia", "terapeuta", "therapist",
    "fisioterapeuta", "fisioterapia", "physical-therapist",
    "kinesio", "kinesiologo", "kinesiologia",
    "nutriologo", "nutriologa", "nutricion", "nutritionist",
    "dietista", "dietitian",
    "anestesiologo", "anestesia", "anesthesiologist",
    "radiologo", "radiologia", "radiologist",
    "patologo", "patologia", "pathologist",
    "internista", "internal-medicine", "medico-internista",
    "geriatra", "geriatria", "geriatrician",
    "urologo", "urologia", "urologist",
    "oftalmologo", "oftalmologia", "ophthalmologist",
    "otorrino", "otorrinolaringologia", "otolaryngologist",
    "endocrinologo", "endocrinologia", "endocrinologist",
    "reumatologo", "reumatologia", "rheumatologist",
    // Mexican health institutions
    "imss", "issste", "insabi", "imss-bienestar", "issemym",
    "pemex-salud", "sedena-salud",
    "sector-salud", "ssa", "secretaria-de-salud", "cofepris",
    "cenetec", "csg", "consejo-salubridad",
    // Health tech
    "healthtech", "health-tech", "telemedicina", "telemedicine",
    "telesalud", "telehealth", "ehr", "emr", "expediente-clinico",
    "expediente-electronico", "his", "ris", "pacs", "lis",
    "epic", "cerner", "athena", "doctoralia", "doctoranytime",
    // Pharma specifics
    "farmacovigilancia", "pharmacovigilance", "ensayos-clinicos",
    "clinical-trials", "fase-1", "fase-2", "fase-3", "fase-4",
    "regulacion-sanitaria", "registro-sanitario", "cofepris-registros"
  ],
  // Educación
  education: [
    "education", "educacion", "educativo", "educativa", "academic",
    "academico", "academica", "teacher", "teachers", "profesor",
    "profesora", "profesores", "docente", "docentes", "instructor",
    "instructora", "tutor", "tutora", "mentor", "mentora", "mentoring",
    "school", "escuela", "escuelas", "colegio", "colegios", "university",
    "universidad", "universidades", "universitario", "universitaria",
    "preparatoria", "secundaria", "primaria", "kinder", "preescolar",
    "training", "capacitacion", "ld", "elearning", "moodle", "lms",
    "curriculum", "curricular", "pedagogia", "pedagogo", "pedagoga",
    "investigador", "investigadora", "researcher",
    // EdTech
    "edtech", "ed-tech", "blackboard", "canvas-lms", "canvas",
    "kahoot", "classroom", "google-classroom", "microsoft-teams",
    "teams-education", "zoom-education", "zoom",
    "instructional-design", "diseno-instruccional", "instructional",
    "curriculum-design", "diseno-curricular", "syllabus",
    "plan-de-estudios", "programa-academico", "programa-de-estudios",
    // Mexican institutions
    "anuies", "sep", "rvoe", "conacyt", "cinvestav", "ipn",
    "unam", "uam", "udg", "tec-monterrey", "tecmonterrey", "itam",
    "ibero", "anahuac", "lasalle", "uvm", "unitec",
    // Levels
    "posgrado", "maestria", "doctorado", "phd", "msc", "mba",
    "executive-education", "diplomado", "diplomados",
    "especialidad", "especialidades", "licenciatura", "ingenieria-academica",
    "tecnico-superior", "tsu", "carrera-tecnica",
    // Bootcamps / online ed
    "platzi", "hackbright", "ironhack", "lambda", "general-assembly",
    "nucamp", "henry", "coderhouse", "domestika",
    // Roles
    "rector", "rectora", "decano", "decana", "director-academico",
    "coordinador-academico", "jefe-de-academia", "academia",
    "investigador-titular", "profesor-investigador", "fellow",
    "becario-academico", "auxiliar-investigacion",
    // K-12
    "maestro-grupo", "preescolar-educadora", "educadora",
    "auxiliar-educativa", "asistente-educativa",
    // Adult learning
    "andragogia", "educacion-continua", "aprendizaje-adulto",
    "capacitacion-corporativa", "corporate-training",
    "facilitador", "facilitadora"
  ],
  // Hospitalidad / restaurantes / turismo
  hospitality: [
    "hospitality", "hospitalidad", "hotel", "hotels", "hoteles",
    "hotelero", "hotelera", "hosteleria", "restaurant", "restaurants",
    "restaurante", "restaurantes", "chef", "chefs", "cocinero",
    "cocinera", "cocina", "kitchen", "mesero", "mesera",
    "meseros", "waiter", "waitress", "bartender", "bar", "bares",
    "barra", "barista", "tourism", "turismo", "turistico", "turistica",
    "viajes", "travel", "agencia", "guest", "guests", "huesped",
    "huespedes", "front", "desk", "recepcion", "concierge", "valet",
    "spa", "wellness", "resort", "resorts", "all", "inclusive",
    "amenities", "tours", "excursion", "excursiones", "cruise",
    "crucero", "airline", "aerolinea", "aerolineas",
    // Hotel systems
    "pms", "opera", "opera-pms", "sabre", "amadeus", "galileo",
    "worldspan", "gds", "channel-manager", "ota", "otas",
    "booking-com", "booking", "expedia", "airbnb", "vrbo",
    "hotelbeds", "trivago", "agoda", "tripadvisor", "kayak",
    // F&B
    "f-b", "food-and-beverage", "a-b", "ab", "alimentos-y-bebidas",
    "room-service", "minibar", "ama-de-llaves", "housekeeping",
    "mucama", "camarista", "lavanderia", "laundry",
    "conserjeria", "botones", "bell-boy", "bell-staff",
    "animador", "animadora", "entretenimiento-hotelero",
    // Roles
    "gerente-de-alimentos-bebidas", "fb-manager", "rooms-division",
    "habitaciones", "housekeeper", "supervisor-de-piso",
    "captain", "capitan-de-meseros", "maitre", "sommelier",
    "head-chef", "sous-chef", "chef-de-partie", "saucier",
    "pastry-chef", "pastelero", "panadero", "panaderia", "reposteria",
    // Travel agencies / tour
    "tour-operator", "operador-turistico", "guia-de-turistas",
    "tour-guide", "guia-canopy", "guia-aventura",
    "ecoturismo", "turismo-rural", "turismo-medico",
    "turismo-de-negocios", "mice", "incentive-travel",
    // Mexican destinations
    "cancun-hospitality", "playa-del-carmen-hospitality",
    "los-cabos-hospitality", "puerto-vallarta-hospitality",
    "riviera-maya", "tulum-hospitality"
  ],
  // Retail / comercio minorista
  retail: [
    "retail", "tienda", "tiendas", "store", "stores", "sucursal",
    "sucursales", "punto", "puntos", "venta", "ventas", "pdv", "pos",
    "cajero", "cajera", "cashier", "vendedor", "vendedora", "piso",
    "supervisor", "supervisora", "gerente", "gerencia",
    "supermercado", "supermercados", "self", "service", "autoservicio",
    "departamento", "departamental", "boutique", "moda", "fashion",
    "footwear", "calzado", "ropa", "perfumeria", "abarrotes", "convenience",
    "conveniencia", "merchandiser", "merchandising", "shopper", "category",
    "categoria", "buyer", "comprador",
    // Omnichannel
    "omnichannel", "omnicanal", "click-and-collect", "click",
    "collect", "bopis", "ship-from-store", "envio-desde-tienda",
    "last-mile-retail", "store-fulfillment",
    // Layout
    "planograma", "planogram", "layout", "shelf-management",
    "anaquel", "anaqueles", "exhibicion", "exhibiciones",
    "endcap", "punta-de-gondola", "gondola", "gondolas",
    // Analytics
    "retail-analytics", "sell-out", "sell-in", "sell-thru",
    "sell-through", "rotacion-inventario", "stockout",
    "gmv", "gross-merchandise-value", "lfl", "like-for-like",
    "comparable-store-sales", "mismas-tiendas", "aforo",
    "trafico-tienda", "footfall", "tasa-conversion-tienda",
    // Roles & ops
    "store-manager", "gerente-de-tienda", "subgerente", "asistente-de-tienda",
    "encargado-de-tienda", "encargada-de-tienda",
    "visual-merchandiser", "merchandising-visual", "loss-prevention", "prevencion-de-perdidas",
    "inventory-control", "control-inventario",
    // E-commerce retail
    "marketplace", "marketplaces", "amazon-vendor", "amazon-seller",
    "mercadolibre", "mercado-libre", "meli", "linio",
    "shopify-merchant", "shopify", "vtex", "magento", "woocommerce",
    "tiendanube", "kioskea",
    // Categories
    "departamento-cosmeticos", "departamento-electrodomesticos",
    "departamento-electronica", "white-goods", "linea-blanca",
    "category-management", "category-captain"
  ],
  // Manufactura / producción
  manufacturing: [
    "manufacturing", "manufactura", "manufacturero", "manufacturera",
    "production", "produccion", "productivo", "productiva", "fabrica",
    "fabricas", "fabricacion", "factory", "factories", "plant", "planta",
    "plantas", "ensamble", "ensambladora", "maquila",
    "maquiladora", "calidad", "quality", "qa", "qc",
    "iso", "lean", "kaizen", "six", "sigma", "tpm",
    "smed", "tps", "industrial", "industrias", "industria", "cnc",
    "torno", "tornero", "soldador", "soldadora", "soldadura", "welding",
    "welder", "metalurgia", "metalurgico", "metalmecanica", "automotriz",
    "aeroespacial", "alimentos", "alimentaria", "envases", "packaging",
    "ehs", "process", "operario", "operaria", "tecnico",
    "tecnica", "tecnicos", "mantenimiento", "maintenance",
    // TPM / Lean tools
    "total-productive-maintenance", "oee", "takt", "takt-time",
    "tiempo-takt", "value-stream-mapping", "vsm", "gemba", "gemba-walks", "andon", "poka-yoke", "pokayoke",
    "just-in-time-mfg", "jidoka", "heijunka",
    "mes-mfg", "manufacturing-execution-system", "mes-platform",
    // Standards
    "iso-9001", "iso9001", "iso-14001", "iso14001",
    "iso-45001", "iso45001", "iso-13485", "iso-22000",
    "iatf", "iatf-16949", "as9100", "as-9100",
    "fmea", "amef", "ppap", "apqp",
    "control-plan", "plan-de-control", "control-de-procesos",
    "mttr", "mtbf", "rcm",
    // Capability
    "capacidad", "capability", "cpk", "ppk",
    "spc", "control-estadistico", "msa", "gage-r-r", "gageR-r",
    // Loss
    "scrap", "rework", "retrabajo", "yield", "rendimiento",
    "first-pass-yield", "fpy", "downtime", "tiempo-muerto",
    "uptime", "availability", "disponibilidad",
    // Industries
    "automotive-mfg", "tier-1", "tier-2", "tier1", "tier2",
    "ev-manufacturing", "battery-manufacturing", "electronica-mfg",
    "semiconductores", "semiconductor", "pcb", "smt",
    "aerospace-mfg", "aeropartes", "aviacion-mfg",
    "appliance", "white-goods-mfg",
    "food-mfg", "alimentos-mfg", "bebidas-mfg", "beverage-mfg",
    "pharma-mfg", "farma-mfg",
    "textil", "textiles", "confeccion", "garment",
    // Roles
    "ingeniero-de-procesos", "ingeniero-calidad", "supervisor-produccion",
    "lider-de-linea", "ingeniero-de-manufactura", "ingeniero-industrial",
    "tecnico-en-mantenimiento", "operador-de-maquina",
    "auxiliar-produccion", "auxiliar-de-produccion",
    "ingeniero-de-mejora-continua", "kaizen-engineer",
    // Mexican border / IMMEX
    "immex-mfg", "shelter", "shelter-mfg", "ramos-arizpe", "saltillo-mfg",
    "queretaro-mfg", "monterrey-mfg", "guanajuato-mfg"
  ],
  // Customer support / atención al cliente
  customer: [
    "customer", "service", "servicio", "servicios",
    "support", "soporte", "atencion", "csr", "agent", "agente", "agentes",
    "helpdesk", "help", "desk", "callcenter", "call", "center", "centro",
    "contacto", "contact", "experiencia", "experience", "satisfaction",
    "satisfaccion", "queja", "quejas", "complaint", "complaints",
    "ticket", "tickets", "zendesk", "freshdesk",
    "csat", "nps", "ces", "telefonica", "telefonico",
    "mesa", "ayuda", "first", "level", "second", "leader",
    // KPIs
    "fcr", "first-contact-resolution", "aht", "average-handle-time",
    "tiempo-promedio-llamada", "frt", "first-response-time",
    "tiempo-primera-respuesta", "queue", "cola", "colas",
    "escalation", "escalacion", "escalada", "escalamiento",
    "tier-1-support", "tier-2-support", "tier-3-support",
    // Tech / channels
    "ivr", "acd", "callbacks", "callback", "rellamada",
    "omnichannel-support", "soporte-omnicanal",
    "chat-support", "chat", "live-chat", "chat-en-vivo",
    "whatsapp-business", "whatsapp", "messenger-support",
    "redes-sociales-soporte", "social-customer-service",
    // Tools
    "gorgias", "kustomer", "helpscout", "drift",
    "ada", "dialogflow", "voiceflow", "chatbot", "voicebot",
    "twilio", "twilio-flex", "five9", "genesys", "avaya",
    "talkdesk", "ringcentral", "nice-cxone", "nice", "cxone",
    // Roles
    "agente-bilingue", "agente-trilingue", "supervisor-de-call",
    "subgerente-call", "team-lead-soporte", "qa-monitoreo",
    "qa-call-center", "training-call-center", "wfm",
    "workforce-management", "planeacion-de-turnos", "scheduling-call",
    // Industries
    "soporte-tecnico", "tier-tecnico", "soporte-l1", "soporte-l2",
    "soporte-l3", "support-engineer", "ingeniero-de-soporte",
    "implementation-specialist", "onboarding-cliente",
    "renewal-specialist", "csm-soporte"
  ],
  // Construcción / arquitectura / ingeniería civil
  construction: [
    "construccion", "construction", "obra", "obras", "civil", "civiles",
    "arquitecto", "arquitecta", "architect", "arquitectura", "arquitectonico",
    "arquitectonica", "edificacion", "edificaciones", "estructural",
    "ingeniero", "ingeniera", "ingenieros", "ingenieria",
    "constructora", "constructoras", "residente", "residentes",
    "supervision", "topografo", "topografa",
    "topografia", "geotecnia", "geotecnico", "concreto", "acero",
    "albañileria", "albañil", "carpintero", "carpinteria", "plomero",
    "plomeria", "instalaciones", "hvac",
    "remodelacion", "remodelaciones", "demolicion",
    "demoliciones", "infraestructura", "infrastructure",
    // BIM / CAD
    "bim", "building-information-modeling", "modelado-bim",
    "autocad", "auto-cad", "cad", "revit", "sketchup", "sketch-up",
    "civil-3d", "civil3d", "tekla", "navisworks", "lumion",
    "rhino", "grasshopper", "archicad",
    // MEP & systems
    "mep", "mechanical-electrical-plumbing", "mecanicas-electricas",
    "ingenieria-estructural", "structural-engineering",
    "residente-de-obra", "supervisor-de-obra", "gerente-de-obra",
    "project-manager-construccion", "construction-pm",
    "master-plan", "plan-maestro", "plot-plan", "diseno-de-sitio",
    "cimentacion", "foundation", "cimentaciones",
    "cimbra", "encofrado", "formwork",
    "pilotes", "pilas", "muros-pantalla",
    "plumbing", "tuberia", "tuberias",
    "electrical", "electrica-construccion", "instalacion-electrica",
    "sistemas-hidraulicos", "sistemas-sanitarios", "sanitarios",
    "voz-y-datos", "cableado-estructurado",
    "bms", "building-management-system", "gestion-de-edificios",
    "domotica", "smart-building", "edificios-inteligentes",
    // Estimating / costs
    "presupuestador-obra", "presupuestos-obra", "cuantificador",
    "estimador-de-obra", "neodata", "opus-software", "opus",
    "campeon-presupuestos",
    // Roles
    "gerente-construccion", "director-de-obra", "lider-de-proyecto-obra",
    "coordinador-de-obra", "auxiliar-de-residencia",
    "perito-en-construccion", "perito-corresponsable", "drro",
    "duro", "supervisor-seguridad-obra", "hse-obra",
    // Heavy civil
    "obra-civil", "obra-pesada", "puentes", "carreteras",
    "vias", "tuneles", "tunneling", "presas", "hidraulica",
    "movimientos-de-tierra", "earthworks",
    // Mexican certifications
    "fonatur", "infonavit-vivienda", "conavi", "fovissste",
    "indaabin", "sct-construccion"
  ],
  // Inmobiliaria
  realestate: [
    "real", "estate", "realtor", "realtors", "inmobiliaria",
    "inmobiliarias", "inmobiliario", "valuacion", "valuador", "valuadora",
    "appraisal", "leasing", "renta", "rentas",
    "patrimonio", "patrimonial", "property", "properties", "propiedad",
    "propiedades", "tasacion", "tasador",
    // Investment vehicles
    "reit", "reits", "fibra", "fibras", "fibra-uno", "funo",
    "fibra-macquarie", "fmty", "fibra-monterrey",
    "fibrahd", "fibra-prologis", "terrafina", "fibra-terrafina",
    // Metrics
    "mexcap", "cap-rate", "tasa-de-capitalizacion",
    "noi", "net-operating-income", "ingreso-operativo-neto",
    "gla", "gross-leasable-area", "abr", "area-bruta-rentable",
    "abro", "absorcion", "absorption-rate",
    // Building grades
    "edificio-corporativo", "oficinas-premium", "oficinas-aaa",
    "clase-aaa", "clase-aa", "clase-a", "clase-a+", "clase-b",
    "clase-c", "edificio-clase",
    // Lease types
    "sublease", "subarrendamiento", "subarriendo",
    "build-to-suit", "bts", "spec", "spec-building",
    "triple-net", "nnn", "lease-master", "master-lease",
    // Roles
    "agente-inmobiliario", "asesor-inmobiliario", "broker-inmobiliario",
    "broker-comercial", "broker-residencial", "intermediario-inmobiliario",
    "perito-valuador", "perito-en-bienes-raices",
    "developer-inmobiliario", "promotor-inmobiliario", "desarrollador-inmobiliario",
    // Segments
    "comercial", "industrial-real-estate", "industrial-rs",
    "logistico-real-estate", "centro-comercial", "centros-comerciales",
    "office-real-estate", "oficinas", "edificio-de-oficinas",
    "residencial", "vertical", "horizontal", "vivienda-vertical",
    "vivienda-horizontal", "casa-habitacion", "departamento",
    "departamentos-en-renta", "renta-vacacional", "vrbo-rs",
    // Platforms
    "easybroker", "lamudi", "vivanuncios", "metroscubicos",
    "inmuebles24", "icasas", "trovit", "remax", "century-21",
    "coldwell-banker", "keller-williams"
  ],
  // Gobierno / sector público
  government: [
    "gobierno", "government", "publico", "public", "publica", "federal",
    "estatal", "municipal", "municipio", "estado", "secretaria",
    "secretarias", "secretario", "subsecretario", "director",
    "general", "subdirector", "subdirectora", "regulatorio",
    "regulatoria", "ministerio", "ministerios", "ayuntamiento", "alcalde",
    "alcaldesa", "diputado", "diputada", "senador", "senadora", "congreso",
    "politicas", "politico", "politica",
    // Mexican federal entities
    "shcp", "sat", "imss-gov", "infonavit-gov", "issste-gov",
    "sedatu", "sedesol", "bienestar", "secretaria-de-bienestar",
    "insabi-gov", "conagua", "inpi", "ine", "inegi",
    "asf", "auditoria-superior-de-la-federacion",
    "transparencia", "plataforma-nacional-de-transparencia",
    "fideicomiso-publico", "programa-social", "programas-sociales",
    "secretaria-de-salud-gov", "secretaria-de-educacion-gov",
    "sep-gov", "ssa-gov",
    "secretaria-economia", "se-gov", "secretaria-relaciones-exteriores",
    "sre", "sct", "secretaria-de-comunicaciones-y-transportes",
    "semarnat", "secretaria-medio-ambiente",
    "sener", "secretaria-energia",
    "sader", "secretaria-agricultura", "sagarpa",
    "stps", "secretaria-trabajo",
    "sedena", "secretaria-defensa", "marina", "semar",
    "guardia-nacional", "policia-federal",
    // Procurement / contracting
    "compranet", "compranet-mx", "compranet5", "licitacion",
    "licitaciones", "concurso-publico", "convocatoria",
    "adjudicacion-directa", "invitacion-a-cuando-menos-tres",
    "obra-publica", "lop", "lopsrm", "ley-de-obras-publicas",
    "lasoap", "ley-adquisiciones",
    // Local government
    "delegacion", "alcaldia", "alcaldias-cdmx", "subdelegacion",
    "regidor", "regidora", "regidores", "sindico", "sindica",
    // International / multilateral
    "onu", "un-mexico", "pnud", "undp", "banco-mundial", "world-bank",
    "bid", "iadb", "ocde", "oecd", "fmi", "imf", "cepal",
    // Public policy roles
    "policy-analyst", "analista-de-politicas-publicas",
    "asesor-legislativo", "asesora-legislativa", "asesor-de-gabinete",
    "consultor-gobierno", "gestor-publico"
  ],
  // Atención administrativa / oficina
  admin: [
    "admin", "administrativo", "administrativa", "administracion",
    "secretaria", "secretarias", "secretario",
    "asistente", "asistentes", "assistant", "executive", "ejecutivo",
    "ejecutiva", "ejecutivos", "recepcion", "recepcionista",
    "receptionist", "office", "oficina", "oficinas",
    "auxiliar", "auxiliares", "agenda", "viajes",
    "travel", "calendar",
    // Office software
    "ofimatica", "microsoft-office", "ms-office", "excel-avanzado",
    "excel", "word", "word-avanzado", "powerpoint", "ppt", "outlook",
    "google-workspace", "g-suite", "gmail", "calendar-google",
    "drive", "docs", "sheets", "slides", "google-docs",
    "google-sheets", "google-slides", "google-drive",
    // Executive tasks
    "agenda-ejecutiva", "calendarizacion", "viajes-corporativos",
    "expense-reports", "gastos", "reembolsos", "viaticos",
    "viatico", "comprobacion-de-gastos", "concur", "expensify",
    "rydoo", "fyle", "ramp",
    // Roles
    "coordinador-administrativo", "coordinadora-administrativa",
    "auxiliar-administrativo", "auxiliar-administrativa",
    "auxiliar-contable", "auxiliar-de-oficina",
    "secretaria-ejecutiva", "secretaria-bilingue",
    "secretaria-administrativa", "secretaria-direccion",
    "asistente-de-direccion", "asistente-de-presidencia",
    "ejecutiva-de-direccion", "executive-assistant",
    "personal-assistant", "asistente-personal",
    "office-manager", "gerente-de-oficina", "facility-manager",
    "facilities", "servicios-generales",
    // Clerical
    "captura-de-datos", "data-entry", "captura", "documentacion",
    "archivo", "archivista", "archivero", "archivero-fisico",
    "expediente", "expedientes", "papeleria",
    "mensajeria", "mensajero", "courier", "correspondencia",
    // Reception
    "front-desk-corporate", "lobby", "concierge-corporate",
    // Tools
    "calendly", "doodle", "fellow", "trello-admin", "notion-admin",
    "monday-admin", "airtable", "smartsheet"
  ],
  // Medios / periodismo / editorial
  media: [
    "media", "medios", "periodista", "periodistas", "journalist",
    "journalism", "periodismo", "reportero", "reportera", "redactor",
    "redactora", "redaccion", "editorial", "editor", "editora", "editores",
    "publicacion", "publicaciones", "publishing", "publisher",
    "noticias", "news", "noticiero", "noticiera", "broadcast",
    "broadcasting", "tv", "television", "radio", "podcast",
    "fotografia", "fotografo", "fotografa", "camarografo", "camarografa",
    // CMS
    "wordpress", "drupal", "wix", "squarespace",
    "content-management-system", "cms", "ghost", "webflow",
    "joomla", "contentful", "sanity", "strapi", "prismic", "storyblok",
    // Podcast hosting
    "podcast-hosting", "anchor", "spotify-for-podcasters",
    "libsyn", "buzzsprout", "transistor", "captivate", "podbean",
    // Video editing
    "video-editing", "edicion-de-video",
    "premiere-pro", "davinci-resolve", "final-cut", "fcpx",
    "final-cut-pro", "avid", "media-composer", "edius",
    // Streaming / OTT
    "twitch", "youtube-creator", "vimeo", "streaming", "ott",
    "vod", "subscription-vod", "svod", "avod",
    "broadcast-tv", "hd-broadcast", "uhd", "4k-broadcast",
    // Newsroom
    "telediario", "noticiero-tv", "sala-de-redaccion", "newsroom",
    "redactor-jefe", "jefe-de-informacion", "editor-de-mesa",
    "editor-noche", "guardia-editorial", "editor-de-fin-de-semana",
    "cobertura-en-vivo", "live-coverage", "transmision-en-vivo",
    "stand-up", "enlace-en-vivo",
    // Roles
    "corresponsal", "corresponsales", "enviado-especial",
    "fotoperiodista", "videografo", "videografa",
    "camarografa-noticiero", "operador-camara",
    "audio-broadcast", "operador-audio", "ingeniero-broadcast",
    "switcher", "director-tecnico-broadcast",
    "guionista-noticiero", "presentador", "presentadora",
    "conductor-tv", "conductora-tv", "anchor-tv",
    // Print / digital
    "diseno-editorial", "editorial-designer", "diagramador",
    "diagramacion", "maquetacion", "layout-editorial",
    "corrector-de-estilo", "correccion-de-estilo", "proofreader",
    "fact-checker", "fact-checking", "verificacion-datos",
    // Mexican media outlets
    "televisa", "tv-azteca", "imagen-tv", "milenio-tv", "foro-tv",
    "el-universal", "reforma", "milenio", "el-financiero",
    "expansion", "el-economista", "la-jornada",
    "animal-politico", "aristegui-noticias", "sinembargo"
  ],
  // Inseguridad / seguridad física + cibernética
  security: [
    "security", "seguridad", "guardia", "guardias", "guardian", "vigilante",
    "vigilancia", "watchman", "patrol", "patrullaje", "policia", "policial",
    "investigador", "investigadora", "investigation", "investigaciones",
    "private", "patrulla", "fraude", "fraud", "loss", "prevention",
    "prevencion", "perdidas", "operational", "operacional",
    // Cyber stack
    "siem", "soar", "edr", "xdr", "ndr", "mdr",
    "threat-intelligence", "threat-intel", "ti-cyber",
    "ioc", "iocs", "indicadores-de-compromiso",
    "pentest", "pentesting", "pentester", "ethical-hacking",
    "hacking-etico", "red-team", "blue-team", "purple-team",
    "osint", "open-source-intelligence", "inteligencia-fuentes-abiertas",
    "malware", "malware-analysis", "analisis-de-malware",
    "ransomware", "phishing", "spear-phishing",
    "incident-response", "respuesta-a-incidentes", "ir-cyber",
    "forensics", "forense", "forense-digital", "digital-forensics",
    "dfir", "soc-cyber", "soc-tier-1", "soc-tier-2", "soc-tier-3",
    // Frameworks / standards
    "nist", "nist-csf", "iso-27001", "iso27001", "iso-27002",
    "soc-2", "soc2", "pci-dss", "pcidss", "pci",
    "hipaa", "gdpr-cyber", "itil", "cobit", "owasp", "mitre",
    "mitre-att-ck", "att-ck", "kill-chain",
    // Vulnerabilities
    "vulnerability-assessment", "evaluacion-de-vulnerabilidades",
    "vulnerability-management", "gestion-de-vulnerabilidades",
    "patching", "parchado", "patch-management",
    "qualys", "tenable", "nessus", "rapid7", "metasploit",
    "burp-suite", "burp", "owasp-zap", "nmap", "wireshark",
    // Identity / access
    "iam", "identity-access-management", "gestion-identidades",
    "pam", "privileged-access-management", "cyberark", "beyondtrust",
    "okta", "azure-ad", "auth0", "ping-identity", "duo",
    // Network / endpoint security
    "firewall", "next-gen-firewall", "ngfw", "ips", "ids",
    "waf", "web-application-firewall", "ddos-protection",
    "casb", "ztna", "zero-trust", "vpn-corporativo", "sase",
    "endpoint-protection", "antivirus-corporativo", "crowdstrike",
    "sentinelone", "sophos", "mcafee", "trend-micro", "kaspersky",
    "palo-alto-cyber", "fortinet", "checkpoint", "cisco-security",
    // Roles
    "ciso", "chief-information-security-officer",
    "security-architect", "arquitecto-de-seguridad",
    "security-engineer", "ingeniero-de-seguridad",
    "security-analyst", "analista-de-seguridad",
    "grc-cyber", "grc-officer", "compliance-cyber",
    "auditor-de-seguridad",
    // Physical security MX
    "guardia-bancario", "custodia-de-valores", "custodios",
    "guardia-armado", "guardia-no-armado", "elemento-seguridad"
  ],
  // Sustentabilidad / ESG / medio ambiente
  sustainability: [
    "esg", "sustainability", "sostenibilidad", "sustentabilidad",
    "environmental", "ambiental", "ambiente", "verde", "green",
    "carbon", "huella", "footprint", "renewable", "renovable", "solar",
    "eolica", "wind", "csr", "responsabilidad", "rsc",
    "filantropia", "philanthropy", "circular",
    "ods", "sdg",
    // GHG / scopes
    "ghg", "ghg-protocol", "scope-1", "scope-2", "scope-3",
    "alcance-1", "alcance-2", "alcance-3",
    "co2", "co2e", "tco2", "huella-de-carbono", "carbon-footprint",
    "lca", "life-cycle-assessment", "analisis-de-ciclo-de-vida",
    "acv", "ecodiseno", "eco-design",
    // Standards
    "ems", "environmental-management-system",
    "iso-14001-sus", "iso-14064", "iso-14067",
    "b-corp", "certified-b", "certificacion-b", "b-corp-certified",
    "fairtrade", "fair-trade", "rainforest-alliance",
    "msc", "asc", "leed", "leed-certification", "edge-certification",
    "well-certification", "well",
    // Reporting frameworks
    "gri", "global-reporting-initiative", "gri-standards",
    "sasb", "tcfd", "tnfd", "issb", "ifrs-s1", "ifrs-s2",
    "asg", "agenda-2030", "17-ods",
    // Climate
    "climate-action", "accion-climatica", "net-zero",
    "neutralidad-de-carbono", "carbon-neutral", "carbon-neutrality",
    "offset", "offsets", "compensacion-de-carbono",
    "mercado-de-carbono", "carbon-market", "voluntary-carbon-market",
    "vcm", "compliance-carbon-market", "ccm",
    "mrv", "monitoring-reporting-verification",
    "monitoreo-reporte-verificacion",
    // Energy transition
    "transicion-energetica", "energy-transition", "decarbonization",
    "descarbonizacion", "fotovoltaico", "photovoltaic", "geotermia", "geothermal", "biomasa", "biomass",
    "hidrogeno-verde", "green-hydrogen", "hidrogeno",
    // Water / waste
    "water-stewardship", "gestion-del-agua", "water-footprint",
    "huella-hidrica", "wastewater", "aguas-residuales",
    "tratamiento-de-agua", "reciclaje", "recycling",
    "residuos-solidos", "solid-waste", "zero-waste", "cero-residuos",
    // Mexican / regional
    "semarnat-cumplimiento", "manifiesto-impacto-ambiental",
    "mia", "rua", "registro-emisiones", "rete",
    "norma-oficial-mexicana-ambiental", "nom-ambiental",
    "asea-cumplimiento", "biodiversidad", "biodiversity",
    "cambio-climatico", "climate-change",
    // Roles
    "sustainability-manager", "gerente-sustentabilidad",
    "esg-officer", "officer-esg", "csr-manager",
    "responsable-sostenibilidad", "consultor-esg", "consultor-sustentabilidad"
  ],
  // ============================================================
  // NEW BUCKETS
  // ============================================================
  // Investigación científica / R&D / academia técnica
  science_research: [
    "investigador", "investigadora", "investigacion", "researcher",
    "scientist", "cientifico", "cientifica",
    "r-d", "i-d", "investigacion-y-desarrollo",
    "research-and-development",
    // Sciences
    "biologo", "biologa", "biology", "biologia",
    "quimico", "quimica", "chemistry", "chemist",
    "fisico", "fisica", "physics", "physicist",
    "matematico", "matematica", "mathematician", "math",
    "estadistico", "estadistica", "statistics", "statistician",
    "estadisticas",
    // Bio / chem specializations
    "biotecnologia-research", "biotech-research", "biotechnology",
    "biologia-molecular", "molecular-biology",
    "microbiologo", "microbiologa", "microbiology",
    "genomica", "genomics", "genetica", "genetics", "genetics-research",
    "bioinformatica", "bioinformatics",
    "quimica-organica", "organic-chemistry", "quimica-inorganica",
    "inorganic-chemistry", "quimica-analitica", "analytical-chemistry",
    "fisicoquimica", "physical-chemistry",
    // Career / academic
    "postdoc", "post-doc", "postdoctoral", "post-doctoral",
    "fellowship", "fellow", "becario-doctoral",
    "tesista", "tesis", "tesis-doctoral", "thesis",
    "paper", "papers", "publicacion-cientifica", "scientific-publication",
    "peer-review", "peer-reviewed", "revision-por-pares",
    "indexed", "scopus", "wos", "web-of-science",
    "h-index", "factor-de-impacto", "impact-factor",
    "conference", "ponente", "ponencia", "conferencista",
    // Lab / methodology
    "laboratorio", "lab", "lab-tech", "tecnico-laboratorio",
    "tecnica-laboratorio", "investigacion-laboratorio",
    "ensayo", "ensayos", "experiment", "experimentos", "experimento",
    "experimental", "experimentation",
    "metodologia", "methodology", "metodos-cuantitativos",
    "metodos-cualitativos", "metodos-mixtos", "mixed-methods",
    "qualitative-research", "quantitative-research",
    // Math / stats specifics
    "regresion", "regression", "anova", "manova", "chi-cuadrado",
    "machine-learning-research", "modelos-bayesianos", "bayesian",
    "modelos-econometricos", "econometrics", "econometria",
    // Funding / institutions
    "conacyt-research", "snii", "sni", "sistema-nacional-investigadores",
    "candidato-snii", "nivel-1-snii", "nivel-2-snii", "nivel-3-snii",
    "cinvestav-research", "cide", "colmex", "el-colegio-de-mexico",
    "ipn-research", "unam-research",
    "nih", "nsf", "horizon-europe",
    // Field-specific
    "bench-science", "wet-lab", "dry-lab",
    "field-research", "trabajo-de-campo",
    "ethnography-research", "etnografia-research",
    // Tools
    "spss", "stata", "r-stats", "r-language", "minitab",
    "matlab", "mathematica", "sas-stats", "jmp",
    "geneious", "blast", "bowtie", "samtools",
    "cryosem", "cryoelectron", "microscopia", "microscopy",
    "espectrometria", "spectrometry", "cromatografia", "chromatography",
    "hplc", "gc-ms", "lc-ms", "rmn", "nmr"
  ],
  // Transporte, aviación, marítimo, ferroviario, ride-share
  transport_aviation: [
    "piloto", "pilot", "copiloto", "copilot",
    "sobrecargo", "sobrecargos", "aeromoza", "aeromozas",
    "flight-attendant", "flight-attendants",
    "ground-crew", "ground-staff", "personal-de-tierra",
    "despachador", "despachadora", "dispatcher", "flight-dispatcher",
    "conductor", "conductora", "conductores",
    "chofer", "choferes", "chofer-privado",
    "operador-de-tractocamion", "tractocamionista",
    "transportista", "transportistas", "autotransporte",
    // Aviation
    "aviacion", "aviation", "aviador", "aviadora",
    "aeronave", "aeronaves", "aircraft",
    "aeronautica", "aeronautical", "ingeniero-aeronautico",
    "aerolinea", "aerolineas", "airline", "airlines",
    "vuelo", "vuelos", "flight", "flights",
    "ground", "hangar", "hangares", "gate", "gates",
    "atc", "controlador-aereo", "controladora-aerea",
    "air-traffic-control", "ats", "air-traffic-services",
    "fbo", "general-aviation", "aviacion-general",
    "private-aviation", "aviacion-privada", "executive-aviation",
    "aviacion-ejecutiva",
    // Mexican airlines / airports
    "aeromexico", "viva-aerobus", "volaris", "magnicharters",
    "tar-aerolineas", "aerus", "interjet",
    "asur", "gap", "oma", "asa", "aeropuertos-y-servicios",
    "aicm", "aifa", "felipe-angeles", "tijuana-airport",
    "guadalajara-airport", "monterrey-airport", "cancun-airport",
    "icao", "iata", "faa", "easa", "agencia-federal-aviacion",
    // Maritime / port
    "naviero", "navieras", "maritime", "maritimo", "maritima",
    "portuario", "portuaria", "puerto", "puertos",
    "estibador-portuario", "estibadores",
    "asipona", "asipoma", "veracruz-port", "manzanillo-port",
    "lazaro-cardenas-port", "altamira-port", "puerto-progreso",
    "buque", "buques", "vessel", "vessels", "ship", "ships",
    "marino", "marinos", "merchant-marine", "marina-mercante",
    "carga-maritima", "shipping-maritime", "container-ship",
    "porta-contenedores",
    // Rail
    "ferroviario", "ferroviaria", "railroad", "railway",
    "kcsm", "kansas-city-southern-de-mexico", "ferromex",
    "ferrosur", "lineas-ferreas", "tren", "trenes",
    "operador-de-locomotora", "locomotive", "rail-operator",
    "tren-suburbano", "tren-maya", "trenes-de-pasajeros",
    "train-conductor",
    // Trucking
    "trailero", "tractocamion", "tracto", "doble-remolque",
    "rastra", "operador-doble-remolque", "operador-rastra",
    "operador-pipa", "pipa", "tanque",
    "operador-de-grua", "grua", "gruas", "operador-grua-titan",
    "lic-fed", "licencia-federal", "licencia-categoria-e",
    // Local transport / ride-share
    "taxista", "taxi", "ride-share", "rideshare",
    "uber-driver", "didi-driver", "cabify-driver", "indriver-driver",
    "delivery-rider", "rider", "riders", "repartidor-moto",
    "moto-rider", "motociclista-repartidor",
    "rappi-rider", "didi-rider", "uber-eats-driver",
    "paqueteria", "paqueteros", "courier-mx",
    "estafeta", "fedex-mx", "dhl-mx", "ups-mx", "redpack",
    // Roles / certifications
    "comandante", "captain-aviation", "primer-oficial",
    "first-officer", "instructor-de-vuelo", "flight-instructor",
    "tipo-rating", "type-rating", "atpl", "cpl", "ppl",
    "ifr", "vfr", "instrument-rating",
    "type-737", "type-a320", "type-embraer",
    // Logistics-aviation specific
    "carga-aerea", "air-cargo", "freight-aviation",
    "courier-internacional", "international-courier"
  ],
  // Alimentos, agroindustria, agricultura
  food_agribusiness: [
    "agropecuario", "agropecuaria", "agricultura", "agricultural",
    "agronomico", "agronomica", "agronomo", "agronoma",
    "ingeniero-agronomo", "ingeniera-agronoma",
    "ganaderia", "ganadero", "ganadera", "livestock",
    "avicola", "avicultor", "avicultora", "poultry",
    "porcicola", "porcino", "porcina", "swine", "pork",
    "lechera", "lecheria", "dairy", "dairy-farm",
    "bovino", "bovina", "bovinos", "cattle", "ovino", "ovina",
    "caprino", "caprina", "goats",
    // Food industry
    "food-industry", "industria-alimentaria",
    "food-science", "ciencia-de-alimentos", "ciencias-alimentarias",
    "alimentos-bebidas", "alimentos-y-bebidas",
    "tecnologo-alimentos", "tecnologa-alimentos",
    "ingeniero-alimentos", "ingeniera-alimentos",
    "nutricionista", "nutriologo-alimentaria", "dietetico",
    "dietista-alimentaria", "dietitian-food",
    // Food safety
    "food-safety", "inocuidad-alimentaria", "fssc-22000", "fssc",
    "haccp", "appcc", "brc", "ifs", "globalg-a-p", "globalgap",
    "primus-gfs", "gfsi",
    "trazabilidad", "traceability", "etiquetado-nutrimental",
    // Agroindustry
    "agroindustria", "agribusiness", "ag-tech", "agtech",
    "invernadero", "invernaderos", "greenhouse", "greenhouses",
    "hidroponia", "hydroponics", "aeroponia", "aeroponics",
    "verticales-farms", "vertical-farming",
    "organic", "organico", "organica", "organicos", "organicas",
    "organic-certified", "certificacion-organica",
    "transgenico", "transgenicos", "ogm", "gmo",
    // Crops / inputs
    "riego", "irrigacion", "irrigation", "drip-irrigation",
    "riego-por-goteo", "aspersion", "fertirriego",
    "fertilizante", "fertilizantes", "fertilizer", "fertilizers",
    "abono", "abonos", "compost",
    "semilla", "semillas", "seed", "seeds", "germoplasma",
    "fito", "fitosanitario", "fitosanitarios", "fitomejoramiento",
    "plant-breeding", "mejoramiento-genetico",
    "agroquimico", "agroquimicos", "agrochemicals", "pesticidas",
    "pesticides", "herbicida", "herbicidas", "insecticida",
    "insecticidas", "fungicida", "fungicidas",
    // Ag operations
    "cosecha", "cosechas", "harvest", "siembra", "planting",
    "labores-de-campo", "campo-agricola",
    "tractor", "tractores", "operador-tractor", "tractor-operator",
    "agricultura-de-precision", "precision-agriculture",
    "drones-agricolas", "ag-drones",
    // Mexican ag
    "sader", "sagarpa-ag", "senasica", "fira", "fnd-rural",
    "norma-de-calidad-organica", "lpo",
    "campo-mexicano", "comercializacion-rural",
    "centros-de-acopio", "acopio",
    // Subsegments
    "frutas-y-verduras", "fruits-and-vegetables",
    "berries", "fresa", "fresas", "blueberries", "moras",
    "aguacate", "avocado", "limon", "lime", "mango",
    "horticultura", "horticulture", "floricultura", "floriculture",
    "cafe", "coffee", "cacao", "cocoa", "agave",
    "tequila-mfg", "mezcal-mfg", "azucar", "sugar-cane",
    "arroz", "rice", "maiz", "corn", "trigo", "wheat",
    "soya", "soja", "soybean", "frijol", "bean",
    // Agribusiness companies
    "bachoco", "san-juan", "lala-ag", "alpura-ag", "sigma-alimentos",
    "gruma-ag", "altex", "minsa", "viz-impulsa", "industrias-bachoco",
    "bimbo-ag", "nestle-ag",
    // Aquaculture
    "acuicultura", "aquaculture", "piscicultura", "camaron",
    "shrimp-farming", "salmonicultura", "salmon"
  ],
  // Seguros y actuarial
  insurance_actuarial: [
    "seguros", "seguro", "insurance", "aseguradora", "aseguradoras",
    "insurer", "insurers",
    "poliza", "polizas", "policy-insurance", "policies-insurance",
    // Underwriting
    "suscripcion", "underwriting", "underwriter", "underwriters",
    "suscriptor", "suscriptora", "suscriptores",
    "cesion", "ceded", "cesion-de-riesgo",
    // Claims
    "claims", "siniestros", "siniestro", "ajustador", "ajustadora",
    "ajustadores", "ajuste", "ajustes", "ajuste-de-siniestros",
    "loss-adjuster", "claims-adjuster",
    "perito-en-siniestros", "perito-de-seguros",
    // Reinsurance
    "reaseguros", "reaseguro", "reinsurance", "reinsurer",
    "reasegurador", "reaseguradora", "munich-re", "swiss-re",
    "hannover-re", "scor", "berkshire-hathaway-re",
    // Lines / branches
    "ramo", "ramos", "ramo-vida", "vida", "life-insurance",
    "ramo-autos", "autos-insurance", "auto-insurance",
    "ramo-gastos-medicos", "gastos-medicos-mayores", "gmm",
    "health-insurance-mx", "ramo-salud",
    "ramo-danos", "danos", "property-and-casualty", "p-c",
    "ramo-incendio", "incendio", "fire-insurance",
    "ramo-marítimo", "ramo-maritimo", "marine-insurance",
    "ramo-aviacion", "aviation-insurance",
    "ramo-responsabilidad", "responsabilidad-civil",
    "general-liability", "rc-general",
    "fianzas", "surety", "surety-bonds", "fianza",
    "bonding", "afianzadora", "afianzadoras",
    // Risk
    "riesgo-asegurador", "insurance-risk", "risk-insurance",
    "tarificacion", "tariff", "pricing-actuarial", "pricing-insurance",
    "modelo-tarifario", "tarifa", "tarifas",
    "experiencia-de-siniestralidad", "siniestralidad", "loss-ratio",
    "expense-ratio", "combined-ratio",
    // Actuarial
    "actuarial", "actuario", "actuaria", "actuarios",
    "actuary", "actuaries", "actuarial-science", "ciencia-actuarial",
    "fcas", "asa", "fsa", "cera", "fia",
    "icea", "imce", "amac",
    "valuacion-actuarial", "actuarial-valuation",
    "reservas-tecnicas", "technical-reserves", "ibnr",
    "incurred-but-not-reported",
    "modelos-actuariales", "actuarial-models", "stochastic-models",
    "modelos-estocasticos",
    "solvencia", "solvency", "solvency-ii", "ifrs-17",
    "embedded-value", "valor-intrinseco",
    // Mexican companies
    "gnp", "axa", "axa-seguros", "mapfre", "qualitas",
    "metlife-mx", "zurich", "allianz-mx", "allianz",
    "chubb-mx", "chubb", "atlas-seguros", "inbursa-seguros",
    "banorte-seguros", "el-aguila", "ana-seguros",
    "sura-seguros", "thona-seguros",
    "patrimonial-inbursa", "afirme-seguros", "general-insurance",
    // Distribution
    "broker-de-seguros", "intermediario-de-seguros", "brokerage",
    "agente-de-seguros", "agente-promotor-seguros",
    "promotor-de-seguros", "promotora-de-seguros",
    "captacion-clientes-seguros", "ventas-de-seguros",
    "telemarketing-seguros", "afp", "afore-seguros",
    "bancassurance", "bancaseguros",
    // Regulator
    "cnsf", "comision-nacional-de-seguros-y-fianzas",
    "amis", "amis-mx", "amasfac",
    "circular-cnsf", "ley-instituciones-de-seguros"
  ],
  // Entretenimiento / artes / contenido / juegos
  entertainment_arts: [
    "entretenimiento", "entertainment", "espectaculos", "espectaculo",
    "show", "shows", "live-show", "live-shows",
    "produccion", "producciones", "production",
    "productor", "productora", "producer", "producers",
    "postproduccion", "post-produccion", "post-production",
    "postproduction",
    // Cinema
    "cinematografia", "cinematography",
    "cinematografo", "cinematographer", "dop", "director-cinematografico", "director-de-cine",
    "director-de-fotografia", "director-of-photography",
    "screenplay", "guion", "guiones", "guionista", "screenwriter",
    "writers-room", "writer-s-room", "sala-de-guionistas",
    "actor", "actriz", "actores", "actrices", "casting",
    "casting-director", "director-de-casting",
    "agencia-de-talento", "talent-agency", "talent-agencies",
    "agente-de-talento", "talent-agent",
    "extra-cinematografico", "extras-cinematograficos",
    "doble", "stunt", "stunts", "stunt-double",
    // Music
    "music", "musica", "musical", "musico", "musica-en-vivo",
    "live-music", "performer", "interprete",
    "compositor", "compositora", "composer", "composers",
    "songwriter", "letrista-musica", "lyricist",
    "sound-engineer", "ingeniero-de-audio", "ingeniera-de-audio",
    "audio-engineer", "audio-mixing", "mezcla-de-audio",
    "mastering", "masterizacion",
    "estudio-de-grabacion", "recording-studio",
    "session-musician", "musico-de-sesion",
    "djs", "deejay", "club-dj", "wedding-dj",
    "managment-musical", "music-manager",
    // Gaming
    "gaming", "videojuegos", "video-games",
    "esports", "e-sports", "competitive-gaming",
    "twitch-streamer", "streamer", "streamers", "streaming-gaming",
    "content-creator", "creador-de-contenido",
    "creadora-de-contenido", "creators",
    "youtuber-mx", "tiktoker-mx", "podcaster",
    "game-design", "diseno-de-videojuegos", "game-designer",
    "game-developer", "desarrollador-de-videojuegos",
    "unity-game", "unreal-engine-game",
    "narrative-design", "diseno-narrativo",
    "level-design", "diseno-de-niveles",
    // Theater / dance
    "teatro", "theater", "theatre", "obra-de-teatro",
    "danza", "dance", "ballet", "bailarin", "bailarina",
    "dancer", "coreografo", "coreografa", "choreographer",
    "circo", "circus", "circus-arts",
    // Visual arts
    "pintor", "pintora", "painter", "pintura",
    "escultor", "escultora", "sculptor", "escultura",
    "artista-visual", "visual-artist",
    "galeria", "galleries", "gallery", "curador",
    "curadora", "curator", "curaduria", "curatorial",
    "museo", "museos", "museum", "museums",
    "patrimonio-cultural", "cultural-heritage", "heritage",
    // Comedy / hosts
    "comediante", "comedian", "stand-up-comedy",
    "host", "presentador-eventos", "presentadora-eventos",
    "maestro-de-ceremonias", "emcee",
    // Mexican entertainment
    "televisa-entretenimiento", "tv-azteca-entretenimiento",
    "ndmas-entretenimiento", "imagen-entretenimiento",
    "auditorio-nacional", "palacio-de-bellas-artes",
    "foro-sol", "arena-cdmx", "arena-monterrey",
    // Streaming / OTT entertainment
    "netflix-mx", "amazon-prime-video-mx", "disney-plus-mx",
    "disney+", "hbo-max-mx", "max-mx", "paramount-plus-mx",
    "vix-tv", "claro-video", "blim-tv",
    // Festivals / events
    "festival", "festivales", "festival-de-cine",
    "morelia-international", "guanajuato-festival",
    "festival-vive-latino", "vive-latino", "corona-capital",
    "edc-mexico", "tomorrowland", "festival-cervantino"
  ],
  // Deporte, fitness, recreación, kinesio
  fitness_sports: [
    "deporte", "deportes", "sport", "sports", "deportivo", "deportiva",
    "deportivos", "deportivas",
    "fitness", "wellness-fitness", "bienestar-fisico",
    "gym", "gyms", "gimnasio", "gimnasios",
    // Trainers
    "entrenador", "entrenadora", "trainer", "trainers",
    "coach", "coaches", "coaching",
    "personal-trainer", "entrenador-personal",
    "instructor-de-yoga", "yoga-instructor", "yogi",
    "instructor-de-pilates", "pilates-instructor",
    "instructor-de-crossfit", "crossfit-coach", "crossfit-trainer",
    "crossfit", "boxeo", "boxing", "kickboxing", "karate",
    "instructor-zumba", "zumba", "spinning", "instructor-spinning",
    "indoor-cycling", "ciclismo-indoor",
    "instructor-de-natacion", "swimming-instructor",
    "instructor-de-tenis", "tennis-instructor", "tennis-coach",
    "instructor-de-golf", "golf-pro", "golf-instructor",
    "instructor-clavadismo", "instructor-buceo", "diving-instructor",
    // Athletes
    "atleta", "atletas", "athlete", "athletes",
    "atletismo", "athletics", "track-and-field",
    "futbolista", "soccer-player", "futbol", "futbol-mexicano",
    "soccer", "liga-mx", "ligamx", "femexfut",
    "basketball", "basquetbol", "baloncesto", "baloncestista",
    "basketball-player", "lnbp",
    "tenis", "tenista", "tennis", "tennis-player", "wta", "atp",
    "beisbol", "baseball", "lmb", "liga-mexicana-de-beisbol",
    "voleibol", "volleyball", "voleibolista",
    "natacion", "natacion-competitiva", "swimmer", "nadador",
    "nadadora", "swimming-competitive",
    "ciclismo", "cycling", "ciclista", "cyclist",
    "running", "corredor", "corredora", "maraton", "marathon",
    "triatlon", "triatleta", "triathlon", "ironman",
    "patinaje", "skating", "ice-skating", "patinaje-artistico",
    "esqui", "ski", "skiing", "snowboard", "snowboarding",
    "surf", "surfing", "surfer",
    "rugby", "rugby-player",
    "futbol-americano", "american-football",
    // Sports medicine / therapy
    "kinesiologo", "kinesiologa", "kinesiology", "kinesiologo-deportivo",
    "fisioterapeuta-deportivo", "fisioterapia-deportiva",
    "physical-therapist-sports",
    "sports-medicine", "medicina-deportiva", "medico-deportivo",
    "nutricion-deportiva", "sports-nutrition",
    "preparador-fisico", "preparadora-fisica", "strength-and-conditioning",
    "s-c", "athletic-trainer", "athletic-training",
    // Sports orgs / facilities
    "club-deportivo", "clubes-deportivos", "sports-club",
    "federacion", "federaciones", "federation", "federations",
    "comite-olimpico", "comite-olimpico-mexicano",
    "conade", "comision-nacional-de-cultura-fisica",
    "estadio", "estadios", "stadium", "stadiums",
    "arena", "arenas", "auditorio-deportivo",
    "campo", "cancha", "canchas", "field-sports",
    // Recreation
    "recreacion", "recreativo", "recreativa", "recreation",
    "campamento", "camping", "outdoor", "actividades-al-aire-libre",
    "alpinismo", "mountaineering", "escalada", "rock-climbing",
    "senderismo", "hiking", "trekking",
    "rafting", "kayaking", "canotaje",
    "deportes-extremos", "extreme-sports", "skateboarding",
    "skater", "parkour",
    // Mexican sports orgs
    "femexfut-club", "club-america", "chivas-guadalajara",
    "cruz-azul", "club-pumas", "club-tigres", "club-monterrey",
    "santos-laguna", "club-leon", "atlas-fc", "puebla-fc",
    "diablos-rojos", "sultanes-monterrey", "tomateros-culiacan",
    "leones-de-yucatan", "tigres-de-quintana-roo",
    "team-mexico", "seleccion-mexicana"
  ],
  // ============================================================
  // Mexican-market signals (brands / sectors / border / industries)
  // Catch-all bucket for brand/industry hints in MX-specific listings.
  // ============================================================
  mexican_industries: [
    // Banking MX
    "bancomer", "banamex", "citibanamex", "banorte", "santander",
    "santander-mx", "scotiabank", "scotiabank-mx", "hsbc", "hsbc-mx",
    "bbva", "bbva-mexico", "banregio", "inbursa", "hey-banco",
    "banco-azteca", "banco-del-bajio", "afirme", "compartamos-banco",
    "banco-multiva", "banca-mifel", "ve-por-mas", "actinver",
    "monex", "ci-banco", "banco-interacciones",
    // Fintech MX
    "clip", "kueski", "kueski-pay", "konfio", "albo", "stori",
    "nubank", "nu-mexico", "uala", "uala-mexico",
    "fondeadora", "bitso", "bitso-mexico", "cuenca",
    "vexi", "minu", "covalto", "facto-mx", "altio",
    "la-haus", "habi", "fairplay", "creze", "weecompany",
    // Telecom MX
    "telcel", "att", "att-mexico", "movistar", "movistar-mx",
    "tigo", "megacable", "totalplay", "izzi", "izzi-mx",
    "cfe-telecom", "altan", "axtel", "alestra", "marcatel",
    "axtel-empresarial", "totalplay-empresarial", "wirecard",
    // Energy
    "pemex", "cfe", "comision-federal-electricidad", "sener-energy",
    "energetico", "energeticos", "petrolero", "petrolera",
    "petrochemical", "petroquimica", "petroquimicas",
    "gasolinera", "gasolineras", "gas-station",
    "lp-gas", "gas-natural", "natural-gas",
    "iberdrola-mx", "naturgy-mx", "atlas-renewable-energy",
    "engie-mx", "enel-green-power", "acciona-mx", "edf-mx",
    "termoelectrica", "hidroelectrica", "ciclo-combinado",
    // Insurance MX brands (cross-listed)
    "gnp-seguros", "axa-mx-insurance", "mapfre-seguros",
    "qualitas-seguros", "metlife-mx-insurance",
    "zurich-mx-insurance", "allianz-mx-insurance",
    // FMCG MX
    "coca-cola", "coca-cola-femsa", "femsa", "kof",
    "pepsi", "pepsico", "pepsico-mx", "bimbo", "grupo-bimbo",
    "lala", "grupo-lala", "alpura", "nestle", "nestle-mx",
    "unilever", "unilever-mx", "p-g", "procter", "procter-and-gamble",
    "gamble", "danone", "danone-mx",
    "mondelez", "mondelez-mx", "kraft", "heinz", "kraft-heinz",
    "mars", "mars-wrigley", "kelloggs", "kelloggs-mx",
    "gruma", "maseca", "mission-foods",
    "modelo", "grupo-modelo", "anheuser-busch-inbev", "ab-inbev",
    "heineken", "heineken-mx", "corona-cerveza",
    "jose-cuervo", "casa-cuervo", "tequila-jose-cuervo",
    "patron-tequila", "becle", "tequila-corralejo",
    // Retail chains MX
    "walmart", "walmart-mx", "wal-mart", "costco", "costco-mx",
    "sams", "sams-club", "soriana", "chedraui",
    "oxxo", "femsa-comercio", "7eleven", "seven-eleven",
    "liverpool", "el-puerto-de-liverpool", "palacio",
    "palacio-de-hierro", "hierro", "el-palacio-de-hierro",
    "suburbia", "sears", "sears-mx", "sanborns",
    "elektra", "grupo-elektra", "coppel", "famsa",
    "bodega", "bodega-aurrera", "aurrera",
    "superama", "city-club", "fresko", "mi-bodega-aurrera",
    "home-depot-mx", "home-depot", "homedepot",
    "office-depot-mx", "office-max", "officemax",
    "best-buy-mx", "best-buy", "rad-shack",
    "farmacia-guadalajara", "farmacias-guadalajara", "farmacias-similares",
    "farmacia-del-ahorro", "farmacias-benavides",
    // Maquila / IMMEX / border
    "maquila", "maquiladora", "maquiladoras", "maquila-program",
    "immex", "programa-immex", "shelter-program",
    "programa-shelter", "maquiladora-de-exportacion",
    "frontera", "border-mx", "us-mx-border",
    "ciudad-juarez", "juarez-maquila", "tijuana-maquila",
    "tijuana-mfg", "reynosa-maquila", "reynosa-mfg",
    "matamoros-maquila", "nuevo-laredo-maquila",
    "mexicali-maquila", "ciudad-acuna",
    "monterrey-mfg", "saltillo-mfg", "ramos-arizpe-mfg",
    "guanajuato-bajio", "queretaro-bajio", "aguascalientes-mfg",
    "san-luis-potosi-mfg", "puebla-mfg", "toluca-mfg",
    // Mining / minerals
    "mineria", "mining", "minero", "minera", "mineros",
    "grupo-mexico", "industrias-penoles", "penoles",
    "fresnillo-plc", "first-majestic", "americas-mining",
    "metalurgica-met-mex", "almaden-minerals",
    "altos-hornos", "ahmsa", "ternium-mexico", "ternium",
    "deacero", "ica-fluor",
    // Auto industry
    "automotriz", "automotive-mx", "automotive-industry",
    "ford-mx", "gm-mx", "general-motors-mx", "stellantis",
    "fca-mx", "fiat-chrysler", "chrysler-mx",
    "vw-mx", "volkswagen-mx", "audi-mx", "audi-mexico",
    "bmw-mx", "mercedes-benz-mx", "kia-mx", "hyundai-mx",
    "toyota-mx", "nissan-mx", "mazda-mx", "honda-mx",
    "tesla-mx", "tesla-monterrey", "byd-mx",
    "jac-mx", "chinese-auto-mx",
    "tier-1-mx", "delphi", "denso-mx", "magna",
    "lear", "lear-corp", "yazaki", "valeo-mx",
    "bosch-mx", "continental-mx", "schaeffler-mx",
    // Aerospace
    "aeronautica-mx", "aerospace-mx", "aeronautico-mx",
    "queretaro-aeronautico", "bombardier-mx", "safran-mx",
    "ge-aviation-mx", "honeywell-mx", "eaton-mx",
    "embraer-mx", "fokker-mx",
    // Food / beverage MX
    "alimentos-mx", "bebidas-mx", "food-and-beverage-mx",
    "industria-tequilera", "industria-cervecera",
    "cervecera-mx", "industria-de-alimentos-mx",
    "frutas-tropicales-mx", "berries-mx",
    "agrosuper", "agropur", "industrias-bachoco-mx",
    // Pharma / Health MX
    "farmaceutica-mx", "pharma-mx", "industria-farmaceutica",
    "labs-pisa", "laboratorios-pisa", "pisa", "labs-silanes",
    "sanofi-mx", "pfizer-mx", "merck-mx", "merck-sharp-dohme",
    "bayer-mx", "roche-mx", "novartis-mx", "abbvie-mx",
    "boehringer-ingelheim-mx", "lilly-mx", "astrazeneca-mx",
    "j-and-j-mx", "johnson-and-johnson-mx", "gsk-mx",
    "genomma-lab", "carnot",
    // Real estate / FIBRA cross-listed
    "fibra-uno-mx", "fibra-macquarie-mx", "fibra-monterrey-mx",
    "vinte", "ara", "casas-ara", "consorcio-ara",
    "homex", "geo", "javer", "casas-javer", "casas-geo",
    "ruba", "casas-ruba",
    // Construction MX
    "ica", "ingenieros-civiles-asociados", "carso-construccion",
    "icasa", "construcciones-aldesa", "ohl-mx", "ohl",
    "gmd-construccion", "promotora-y-operadora",
    "grupo-aeroportuario", "asur", "gap-aeropuertos",
    "oma-aeropuertos",
    // Conglomerates / holdings MX
    "grupo-carso", "grupo-bimbo", "femsa-conglomerado",
    "alfa-grupo", "grupo-alfa", "alpek", "nemak",
    "axtel-conglomerado", "kuo-grupo", "grupo-kuo",
    "vitro", "mexichem", "orbia", "cydsa",
    "salinas-grupo", "grupo-salinas",
    "televisa-conglomerado", "tv-azteca-conglomerado",
    "elektra-conglomerado",
    // Logistics / 3PL MX
    "estafeta-mx", "fedex-mexico", "dhl-mexico",
    "ups-mexico", "redpack-mx", "paquetexpress",
    "mercurio", "j-m-romo",
    "pinturas-comex", "pinturas-comex-mx", "comex",
    // Energy / Oil services MX
    "halliburton-mx", "schlumberger-mx", "baker-hughes-mx",
    "weatherford-mx",
    "icc-mx", "cme-mexico", "cnh-comision-nacional-hidrocarburos",
    "cre-comision-reguladora-energia",
    // Tech / Telco infrastructure
    "americall-movil", "america-movil", "claro", "telefonica-mx",
    "telmex", "carso-telecom",
    "kio-networks", "alestra-empresarial", "metro-net",
    "axtel-empresarial-mx",
    // Mexican universities (sometimes employer)
    "tec-monterrey-empresa", "unam-empresa", "ipn-empresa",
    "itam-empresa",
    // Government enterprise (cross-listed)
    "pemex-empresa", "cfe-empresa", "afore-empresa",
    "infonavit-empresa", "imss-empresa", "issste-empresa"
  ]
};

/**
 * Classify a token bag into domain buckets. Returns a sorted-desc map of
 * { bucketName: matchCount } so the caller can pick a "dominant" bucket.
 * Tokens that don't fall in any bucket are silently ignored.
 */
function classifyDomain(tokens) {
  const counts = {};
  if (!tokens || !tokens.length) return counts;
  const set = tokens instanceof Set ? tokens : new Set(tokens);
  for (const [bucket, words] of Object.entries(DOMAIN_BUCKETS)) {
    let n = 0;
    for (const w of words) {
      if (set.has(w)) n++;
    }
    if (n) counts[bucket] = n;
  }
  return counts;
}

/**
 * Pick the dominant domain from a counts map. Returns null when there's
 * nothing or when no bucket clearly leads (the "tie" case is treated as
 * unclear so we don't apply a penalty on noisy signals).
 */
function dominantDomain(counts) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [top, second] = entries;
  // Need a clear winner: top must beat second by at least 2 hits AND have
  // ≥2 hits itself. Otherwise return null = "ambiguous, don't penalize".
  if (top[1] < 2) return null;
  if (second && top[1] - second[1] < 2) return null;
  return top[0];
}

/**
 * Same as dominantDomain but returns the top-N candidates as a Set so the
 * caller can detect "soft mismatch" cases: when the title is ambiguous
 * (no clear winner) but the profile's dominant domain is NOT in the
 * title's top buckets at all, we can still penalize. Used as a fallback
 * to dominantDomain so vacancies like "Ejecutivo de Datos Maestros SAP
 * S/4 HANA Supply Chain" (ops + tech tied) still get penalized for a
 * sales-only profile.
 */
function topDomainsSet(counts, n = 3) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return new Set();
  entries.sort((a, b) => b[1] - a[1]);
  const out = new Set();
  for (let i = 0; i < Math.min(n, entries.length); i++) {
    if (entries[i][1] >= 1) out.add(entries[i][0]);
  }
  return out;
}

// Filler tokens — words too generic to count as a meaningful overlap on
// their own. A profile mentioning "análisis de datos" and a title saying
// "Datos Maestros" both contain "datos" but that's not a real match.
// These tokens still contribute when paired with a non-filler anchor
// (e.g. "datos comerciales" vs "Sales Data Analyst" → "data" + "sales"
// = legitimate match) but never in isolation.
const FILLER_TOKENS = new Set([
  // Ultra-generic — appear in every CV and most JDs equally. Matching
  // these alone tells us nothing about role fit.
  "datos", "data", "informacion", "information",
  "proyecto", "proyectos", "project", "projects",
  "gestion", "management", "manage", "manejo",
  "estrategia", "estrategias", "strategy", "strategic", "strategies",
  "trabajo", "trabajos", "work", "working",
  "empresa", "empresas",
  "equipo", "equipos",
  "proceso", "procesos",
  "desarrollo",
  "area", "areas", "departamento",
  "responsable", "responsabilidades", "responsibilities",
  "tareas", "tasks", "task",
  "objetivo", "objetivos", "goal", "goals", "objective", "objectives",
  "actividades", "activities", "activity",
  "general", "generales",
  "mejora", "mejoras", "improvement", "improvements",
  "analisis", "analysis", "analyses",
  "implementacion", "implementation",
  "experiencia", "experience", "experiencias",
  "conocimiento", "conocimientos", "knowledge",
  "habilidad", "habilidades", "skills", "skill",
  "funcion", "funciones",
  "puesto", "puestos", "position", "positions",
  "rol", "roles",
  "labor", "labores",
  "principal", "principales", "main"
]);

export function computeListingMatchScore(profile, jobLite, preferences = null) {
  const reasons = [];
  const titleNorm = normalize(jobLite?.title || "");
  if (!titleNorm) return { score: 0, reasons: [] };
  const titleTokens = tokenize(titleNorm, 50);

  // 1) Skill matches against the title. We require the skill to be ≥3
  // chars to avoid noise like "QA" matching "QA quality assurance" in
  // unrelated titles, and we skip skills that are exactly a generic
  // role suffix (so "Manager" as a skill doesn't auto-match every
  // manager title).
  const skillMatches = [];
  for (const skillRaw of profile.skills || []) {
    const s = normalize(skillRaw);
    if (!s || s.length < 3) continue;
    if (ROLE_GENERIC_SUFFIXES.has(s)) continue;
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
  // Critical: the overlap must include at least one NON-suffix and
  // NON-filler token (a "discipline anchor"). A sales person with
  // "Business Developer" in their CV shouldn't match "IT Solution
  // Developer" on "developer" alone, and shouldn't match "Datos
  // Maestros" on the word "datos" alone.
  const roleTokens = new Set();
  for (const e of profile?.experience || []) {
    for (const t of tokenize(normalize(e?.role || ""), 50)) roleTokens.add(t);
  }
  const overlapAll = [];
  const overlapAnchors = [];
  for (const t of titleTokens) {
    if (roleTokens.has(t)) {
      overlapAll.push(t);
      if (!ROLE_GENERIC_SUFFIXES.has(t) && !FILLER_TOKENS.has(t)) overlapAnchors.push(t);
    }
  }
  // Score the overlap by anchor tokens (the discipline words). Suffixes
  // and fillers contribute +2 each as a tiebreaker but never alone.
  const anchorPts = Math.min(overlapAnchors.length * 18, 30);
  const suffixPts = overlapAnchors.length > 0
    ? Math.min(Math.max(overlapAll.length - overlapAnchors.length, 0) * 2, 6)
    : 0;
  const roleBonusPts = anchorPts + suffixPts;
  if (overlapAnchors.length) {
    reasons.push(`Tu experiencia incluye: ${overlapAnchors.slice(0, 3).join(", ")}`);
  }

  // 3) Summary overlap — tokens from the user's summary that show up in
  // the title. Same rules: skip generic suffixes AND filler tokens.
  const summaryTokens = new Set(tokenize(normalize(profile?.summary || ""), 200));
  const summaryAnchors = [];
  for (const t of titleTokens) {
    if (summaryTokens.has(t)
        && !roleTokens.has(t)
        && !ROLE_GENERIC_SUFFIXES.has(t)
        && !FILLER_TOKENS.has(t)) {
      summaryAnchors.push(t);
    }
  }
  const summaryBonusPts = Math.min(summaryAnchors.length * 8, 16);
  if (summaryAnchors.length) {
    reasons.push(`Alinea con tu resumen: ${summaryAnchors.slice(0, 3).join(", ")}`);
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

  // 5) Domain mismatch penalty.
  // If the profile is dominantly one domain (e.g. sales/marketing) and
  // the job title is dominantly a different one (e.g. tech), the role
  // overlap is almost certainly a false positive on a generic suffix.
  // Apply a penalty so these don't bubble to the top.
  const profileBag = tokenize(normalize(buildProfileBag(profile)), 500);
  const profileCounts = classifyDomain(profileBag);
  const titleCounts = classifyDomain(titleTokens);
  const profileDomain = dominantDomain(profileCounts);
  const titleDomain = dominantDomain(titleCounts);
  let domainDelta = 0;
  if (profileDomain && titleDomain) {
    // Both sides have a clear winner.
    if (profileDomain === titleDomain) {
      domainDelta = 6;
      reasons.unshift(`Mismo dominio: ${titleDomain}`);
    } else {
      domainDelta = -22;
      reasons.push(`Distinto dominio: tu CV es ${profileDomain}, esta vacante es ${titleDomain}`);
    }
  } else if (profileDomain && !titleDomain) {
    // Profile is clear but title is ambiguous (e.g. ops + tech tied on
    // "Datos Maestros SAP Cadena de Suministro"). Soft-mismatch: if the
    // user's dominant domain isn't in the title's top-3 buckets at all,
    // that's a clear sign the title belongs to a different world. Apply
    // a lighter penalty (−12) than the hard mismatch (−22).
    const titleTopSet = topDomainsSet(titleCounts, 3);
    if (titleTopSet.size > 0 && !titleTopSet.has(profileDomain)) {
      domainDelta = -12;
      const topNames = Array.from(titleTopSet).slice(0, 2).join("/");
      reasons.push(`Probablemente otro dominio (${topNames}); tu CV es ${profileDomain}`);
    }
  }

  const base = 35;
  // Preference bonuses (city / modality / salary). Applied AFTER the base
  // listing math so the layering is identical to the rich-job path. No-op
  // when preferences arg is null or has no filters set.
  const prefDelta = applyPreferenceBonuses(preferences, jobLite, reasons);
  const raw = base + skillBonus + roleBonusPts + summaryBonusPts + modalityPts + domainDelta + prefDelta;
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

/**
 * DOMAIN_BUCKETS smoke tests — runnable expectations for the dictionary
 * after the 2026-04 expansion (29 buckets, ~5000 keywords). The numbers
 * below assume `computeListingMatchScore(profile, jobLite)` is called with
 * no preferences. They reflect the ≥2-hits + beat-by-≥2 dominantDomain()
 * guard, so thin titles still safely produce no penalty.
 *
 *   const salesProfile = {
 *     summary: "Ejecutivo comercial con experiencia en ventas B2B, KAM, " +
 *              "trade marketing y CRM Salesforce.",
 *     experience: [
 *       { role: "Key Account Manager Trade Marketing", company: "Bimbo" },
 *       { role: "Ejecutivo de Ventas Senior",          company: "FEMSA" }
 *     ],
 *     skills: ["Salesforce", "HubSpot", "KAM", "Trade Marketing"]
 *   };
 *
 *   const techProfile = {
 *     summary: "Backend engineer con Python, AWS, Kubernetes y microservicios.",
 *     experience: [
 *       { role: "Senior Backend Engineer", company: "Kavak" },
 *       { role: "Software Engineer",       company: "Mercado Libre" }
 *     ],
 *     skills: ["Python", "AWS", "Kubernetes", "Docker", "PostgreSQL"]
 *   };
 *
 *   // (1) Sales/marketing CV + IT title → tech wins, mismatch with sales → -22
 *   //     score ≈ 13 ("Distinto dominio: tu CV es sales, esta vacante es tech")
 *   computeListingMatchScore(salesProfile,
 *     { title: "Software Engineer Backend Python AWS", company: "Acme" });
 *
 *   // (2) Sales CV + KAM Trade Marketing title → sales/marketing match → +6
 *   //     score = 100 (capped) — skills, role overlap, summary all align
 *   computeListingMatchScore(salesProfile,
 *     { title: "KAM Trade Marketing FMCG", company: "Lala" });
 *
 *   // (3) Sales CV + admin title → admin wins, mismatch → -22
 *   //     score ≈ 13 ("Distinto dominio: tu CV es sales, esta vacante es admin")
 *   computeListingMatchScore(salesProfile,
 *     { title: "Asistente administrativo bilingue", company: "Walmart" });
 *
 *   // (4) Tech CV + Senior Backend Engineer → tech matches → +6
 *   //     score = 100 (capped)
 *   computeListingMatchScore(techProfile,
 *     { title: "Senior Backend Engineer Python AWS", company: "Rappi" });
 */
