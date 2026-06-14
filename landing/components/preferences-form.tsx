"use client";

import { useState, useTransition } from "react";
import {
  PERSONAL_ANSWER_KEYS,
  type Modality,
  type PersonalAnswerKey,
  type PersonalAnswers,
  type UserPreferences,
} from "@/lib/api";

const MODALITIES: { id: Modality; label: string; sub: string; icon: string }[] = [
  { id: "any", label: "Cualquiera", sub: "Sin filtro de modalidad", icon: "🌎" },
  { id: "remoto", label: "Remoto", sub: "100% desde casa", icon: "🏠" },
  { id: "hibrido", label: "Híbrido", sub: "Algunos días en oficina", icon: "🔀" },
  { id: "presencial", label: "Presencial", sub: "Todos los días en oficina", icon: "🏢" },
];

// Personal screening questions the AI never invents — the auto-postular
// answers them with YOUR saved text. Keys must match backend
// PERSONAL_ANSWER_KEYS and the extension's PERSONAL_ANSWER_PATTERNS.
// Recruiter-voice questions — each renders as a chat exchange the user
// pre-answers once. Portafolio + LinkedIn render separately (they carry
// URL normalization + a helper button).
const PERSONAL_FIELDS: {
  key: PersonalAnswerKey;
  label: string;
  placeholder: string;
}[] = [
  { key: "vehiculo", label: "¿Cuentas con vehículo propio? 🚗", placeholder: "Ej. Sí, cuento con vehículo propio" },
  { key: "licencia", label: "¿Tienes licencia de conducir vigente?", placeholder: "Ej. Sí, licencia vigente" },
  { key: "viajar", label: "¿Tienes disponibilidad para viajar? ✈️", placeholder: "Ej. Sí, sin problema" },
  { key: "reubicarse", label: "¿Te abrirías a un cambio de residencia?", placeholder: "Ej. No por el momento" },
  { key: "ingles", label: "¿Cuál es tu nivel de inglés?", placeholder: "Ej. Intermedio-avanzado (B2)" },
  { key: "inicio", label: "¿Cuándo podrías empezar? 📅", placeholder: "Ej. Disponibilidad inmediata" },
];

// Canonicalize a LinkedIn handle or URL into https://www.linkedin.com/in/…
// Accepts "lalo-serratos", "linkedin.com/in/lalo", "https://www.linkedin.com/in/lalo/".
function normalizeLinkedIn(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (/^[A-Za-z0-9\-_.%]+$/.test(s)) return `https://www.linkedin.com/in/${s}`;
  const stripped = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (/^linkedin\.com\//i.test(stripped)) {
    return "https://www.linkedin.com/" + stripped.replace(/^linkedin\.com\//i, "").replace(/\/+$/, "");
  }
  return s;
}

// Prepend https:// to bare domains so the saved portfolio link is clickable.
function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

const inputCls =
  "w-full rounded-xl border border-[color:var(--color-border)] bg-white px-3.5 py-2.5 text-sm text-[color:var(--color-ink)] outline-none transition focus:border-[color:var(--color-brand-500)] focus:shadow-[0_0_0_3px_rgba(42,156,145,0.15)]";

function SectionCard({
  icon,
  title,
  sub,
  aside,
  children,
}: {
  icon: string;
  title: string;
  sub: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[20px] border border-[color:var(--color-border)] bg-white p-6 shadow-[0_18px_40px_-28px_rgba(15,29,44,0.45)] sm:p-7">
      <header className="flex items-start gap-3.5">
        <span
          aria-hidden
          className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#ecfaf7] to-[#d2f3ec] text-xl"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-extrabold tracking-tight text-[color:var(--color-ink)]">
            {title}
          </h2>
          <p className="mt-0.5 text-[13px] leading-snug text-[color:var(--color-ink-muted)]">
            {sub}
          </p>
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </header>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/**
 * One exchange of the pre-answered interview: the recruiter's question as a
 * gray chat bubble (left) and the user's editable answer as a "sent" bubble
 * (right). Filled answers render as solid brand-gradient messages; empty
 * ones are dashed ghost bubbles inviting the user to reply. This previews
 * EXACTLY what the product does: answer the recruiter with your words.
 */
function ChatAnswer({
  id,
  question,
  value,
  placeholder,
  onChange,
  onBlur,
  after,
}: {
  id: string;
  question: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onBlur?: (v: string) => void;
  after?: React.ReactNode;
}) {
  const filled = value.trim().length > 0;
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
      {/* recruiter bubble */}
      <div className="flex items-start gap-2 sm:w-[46%] sm:shrink-0">
        <span
          aria-hidden
          className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#0f1d2c] text-[13px]"
        >
          🧑‍💼
        </span>
        <label
          htmlFor={id}
          className="cursor-pointer rounded-2xl rounded-tl-[4px] bg-[#eef3f5] px-3.5 py-2 text-[13px] font-medium leading-snug text-[color:var(--color-ink-soft)]"
        >
          {question}
        </label>
      </div>
      {/* your reply bubble */}
      <div className="min-w-0 flex-1 pl-9 sm:pl-0">
        <div
          className={
            filled
              ? "rounded-2xl rounded-br-[4px] bg-[linear-gradient(135deg,#137e7a,#0d4f63)] shadow-[0_8px_18px_-10px_rgba(16,89,113,0.6)] transition"
              : "rounded-2xl rounded-br-[4px] border-2 border-dashed border-[#cfdde2] bg-white transition focus-within:border-[color:var(--color-brand-400)]"
          }
        >
          <input
            id={id}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur ? (e) => onBlur(e.target.value) : undefined}
            placeholder={placeholder}
            autoComplete="off"
            className={
              filled
                ? "w-full bg-transparent px-3.5 py-2 text-sm font-semibold text-white outline-none placeholder:text-white/60"
                : "w-full bg-transparent px-3.5 py-2 text-sm text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-muted)]"
            }
          />
        </div>
        {after}
      </div>
    </div>
  );
}

export function PreferencesForm({ initial }: { initial: UserPreferences }) {
  const [city, setCity] = useState(initial.city);
  const [modality, setModality] = useState<Modality>(initial.modality);
  const [salaryMin, setSalaryMin] = useState<string>(
    initial.salaryMin == null ? "" : String(initial.salaryMin)
  );
  const [salaryMax, setSalaryMax] = useState<string>(
    initial.salaryMax == null ? "" : String(initial.salaryMax)
  );
  const [expectedSalary, setExpectedSalary] = useState<string>(
    initial.expectedSalary || ""
  );
  // Auto-submit toggle. Default ON ("Automático total"): the extension fills
  // AND sends an individual apply. When OFF ("Revisar antes de enviar") it
  // stops at the final button so the user sends it. `?? true` so existing
  // accounts (before the field existed) default to auto.
  const [autoSubmit, setAutoSubmit] = useState<boolean>(
    initial.autoSubmit ?? true
  );
  const [personalAnswers, setPersonalAnswers] = useState<PersonalAnswers>(
    initial.personalAnswers || {}
  );
  const setAnswer = (key: PersonalAnswerKey, value: string) =>
    setPersonalAnswers((prev) => ({ ...prev, [key]: value.slice(0, 200) }));
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<
    { tone: "ok" | "err"; text: string } | null
  >(null);

  // Progress chip for the interview card: salario + the 8 personal answers.
  const TOTAL_ANSWERS = 1 + PERSONAL_ANSWER_KEYS.length;
  const answeredCount =
    (expectedSalary.trim() ? 1 : 0) +
    PERSONAL_ANSWER_KEYS.filter((k) => (personalAnswers[k] || "").trim()).length;

  const parseSalary = (raw: string): number | null => {
    const cleaned = raw.replace(/[^\d]/g, "");
    if (!cleaned) return null;
    const n = parseInt(cleaned, 10);
    return Number.isFinite(n) ? n : null;
  };

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus(null);

    const min = parseSalary(salaryMin);
    const max = parseSalary(salaryMax);
    if (min != null && max != null && min > max) {
      setStatus({
        tone: "err",
        text: "El salario mínimo no puede ser mayor al máximo.",
      });
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            city: city.trim(),
            modality,
            salaryMin: min,
            salaryMax: max,
            expectedSalary: expectedSalary.trim(),
            autoSubmit,
            personalAnswers,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error?.message || "No se pudo guardar");
        }
        setStatus({
          tone: "ok",
          text: "Listo — guardado y sincronizado con tu extensión. ✓",
        });
      } catch (err) {
        setStatus({
          tone: "err",
          text:
            err instanceof Error
              ? err.message
              : "No se pudo guardar. Intenta de nuevo.",
        });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* ============ Card 1: Ranking ============ */}
      <SectionCard
        icon="🎯"
        title="Ranking de vacantes"
        sub="Afinan el orden en que ves las vacantes — no filtran, solo priorizan. Puedes dejarlos vacíos."
      >
        <div className="space-y-5">
          <div>
            <label
              htmlFor="pref-city"
              className="text-sm font-semibold text-[color:var(--color-ink)]"
            >
              Ciudad
            </label>
            <input
              id="pref-city"
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value.slice(0, 100))}
              placeholder="Ej. Ciudad de México, Monterrey, Guadalajara…"
              className={`mt-1.5 ${inputCls}`}
              autoComplete="off"
            />
          </div>

          <div>
            <span className="text-sm font-semibold text-[color:var(--color-ink)]">
              Modalidad preferida
            </span>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              {MODALITIES.map((m) => (
                <label
                  key={m.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition ${
                    modality === m.id
                      ? "border-[color:var(--color-brand-500)] bg-[color:var(--color-brand-50)] shadow-[0_0_0_3px_rgba(42,156,145,0.12)]"
                      : "border-[color:var(--color-border)] bg-white hover:border-[color:var(--color-brand-400)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="modality"
                    value={m.id}
                    checked={modality === m.id}
                    onChange={() => setModality(m.id)}
                    className="sr-only"
                  />
                  <span aria-hidden className="text-lg">{m.icon}</span>
                  <span>
                    <span
                      className={`block font-semibold ${
                        modality === m.id
                          ? "text-[color:var(--color-brand-700)]"
                          : "text-[color:var(--color-ink)]"
                      }`}
                    >
                      {m.label}
                    </span>
                    <span className="block text-xs text-[color:var(--color-ink-muted)]">
                      {m.sub}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className="text-sm font-semibold text-[color:var(--color-ink)]">
              Salario mensual (MXN)
            </span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-xl border border-[color:var(--color-border)] bg-white px-3.5 py-2.5 transition focus-within:border-[color:var(--color-brand-500)] focus-within:shadow-[0_0_0_3px_rgba(42,156,145,0.15)]">
                <span className="text-sm text-[color:var(--color-ink-muted)]">$</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={salaryMin}
                  onChange={(e) => setSalaryMin(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="Mín"
                  className="w-24 bg-transparent text-sm text-[color:var(--color-ink)] outline-none"
                />
              </div>
              <span className="text-sm text-[color:var(--color-ink-muted)]">—</span>
              <div className="flex items-center gap-2 rounded-xl border border-[color:var(--color-border)] bg-white px-3.5 py-2.5 transition focus-within:border-[color:var(--color-brand-500)] focus-within:shadow-[0_0_0_3px_rgba(42,156,145,0.15)]">
                <span className="text-sm text-[color:var(--color-ink-muted)]">$</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={salaryMax}
                  onChange={(e) => setSalaryMax(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="Máx"
                  className="w-24 bg-transparent text-sm text-[color:var(--color-ink)] outline-none"
                />
              </div>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* ============ Card: Cómo postula la IA (auto-submit) ============ */}
      <SectionCard
        icon="⚡"
        title="Cómo postula la IA"
        sub="Cuando te postulas a UNA vacante. (El auto-postular en lote siempre envía solo.)"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            {
              val: true,
              icon: "🚀",
              label: "Automático total",
              sub: "Llena y ENVÍA solo. Tú entras, revisas la vacante y le das “Postular con IA”. (5 s para cancelar con Esc.)",
            },
            {
              val: false,
              icon: "✋",
              label: "Revisar antes de enviar",
              sub: "Llena todo y se detiene en el botón final para que tú lo revises y lo envíes.",
            },
          ].map((opt) => (
            <label
              key={String(opt.val)}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition ${
                autoSubmit === opt.val
                  ? "border-[color:var(--color-brand-500)] bg-[color:var(--color-brand-50)] shadow-[0_0_0_3px_rgba(42,156,145,0.12)]"
                  : "border-[color:var(--color-border)] bg-white hover:border-[color:var(--color-brand-400)]"
              }`}
            >
              <input
                type="radio"
                name="autoSubmit"
                checked={autoSubmit === opt.val}
                onChange={() => setAutoSubmit(opt.val)}
                className="sr-only"
              />
              <span aria-hidden className="text-lg">
                {opt.icon}
              </span>
              <span>
                <span
                  className={`block font-semibold ${
                    autoSubmit === opt.val
                      ? "text-[color:var(--color-brand-700)]"
                      : "text-[color:var(--color-ink)]"
                  }`}
                >
                  {opt.label}
                </span>
                <span className="block text-xs text-[color:var(--color-ink-muted)]">
                  {opt.sub}
                </span>
              </span>
            </label>
          ))}
        </div>
      </SectionCard>

      {/* ============ Card 2: La entrevista, ya contestada ============ */}
      <SectionCard
        icon="🎙️"
        title="La entrevista, ya contestada"
        sub="Esto es literalmente lo que la IA responderá por ti — con tus palabras, nunca inventado. Contesta como si chatearas con el reclutador: una vez y para siempre. Lo que dejes vacío se salta en automático."
        aside={
          <span
            className={`rounded-full px-3 py-1 text-[11px] font-bold tabular-nums ${
              answeredCount === TOTAL_ANSWERS
                ? "bg-[#ecfaf7] text-[color:var(--color-brand-700)]"
                : "bg-[#fff1e6] text-[#c2410c]"
            }`}
          >
            {answeredCount}/{TOTAL_ANSWERS} listas
          </span>
        }
      >
        <div className="space-y-4 rounded-2xl bg-[#f7fafb] p-4 sm:p-5">
          <ChatAnswer
            id="pref-expected-salary"
            question="Hola 👋 ¿Cuál es tu expectativa salarial?"
            value={expectedSalary}
            placeholder="Escribe tu respuesta…"
            onChange={(v) => setExpectedSalary(v.slice(0, 120))}
          />
          {PERSONAL_FIELDS.map((f) => (
            <ChatAnswer
              key={f.key}
              id={`pref-pa-${f.key}`}
              question={f.label}
              value={personalAnswers[f.key] || ""}
              placeholder={f.placeholder}
              onChange={(v) => setAnswer(f.key, v)}
            />
          ))}
          <ChatAnswer
            id="pref-pa-portafolio"
            question="¿Nos compartes tu portafolio?"
            value={personalAnswers.portafolio || ""}
            placeholder="tuportafolio.com (lo completamos)"
            onChange={(v) => setAnswer("portafolio", v)}
            onBlur={(v) => setAnswer("portafolio", normalizeUrl(v))}
          />
          <ChatAnswer
            id="pref-pa-linkedin"
            question="¿Tu perfil de LinkedIn?"
            value={personalAnswers.linkedin || ""}
            placeholder="Pega tu link o solo tu usuario"
            onChange={(v) => setAnswer("linkedin", v)}
            onBlur={(v) => setAnswer("linkedin", normalizeLinkedIn(v))}
            after={
              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[color:var(--color-ink-muted)]">
                <a
                  href="https://www.linkedin.com/in/me/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-[#0a66c2] px-2 py-1 text-[11px] font-bold text-white hover:brightness-110"
                  title="Abre tu propio perfil en LinkedIn para copiar el link"
                >
                  <span
                    aria-hidden
                    className="grid h-3.5 w-3.5 place-items-center rounded-[2px] bg-white text-[9px] font-black leading-none text-[#0a66c2]"
                  >
                    in
                  </span>
                  Abrir mi perfil ↗
                </a>
                <span>te lleva directo con tu sesión — copia la URL y pégala.</span>
              </div>
            }
          />
        </div>
      </SectionCard>

      {/* ============ Status + acciones ============ */}
      {status && (
        <div
          role={status.tone === "err" ? "alert" : "status"}
          className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium ${
            status.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {status.text}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-xl bg-[color:var(--color-brand-600)] px-6 py-3 text-sm font-bold text-white shadow-[var(--shadow-brand)] transition hover:bg-[color:var(--color-brand-700)] disabled:cursor-progress disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Guardar preferencias"}
        </button>
        <button
          type="button"
          onClick={() => {
            setCity("");
            setModality("any");
            setSalaryMin("");
            setSalaryMax("");
            setExpectedSalary("");
            setPersonalAnswers({});
            setStatus(null);
          }}
          className="rounded-xl border border-[color:var(--color-border)] bg-white px-5 py-3 text-sm font-semibold text-[color:var(--color-ink)] transition hover:border-[color:var(--color-brand-400)]"
        >
          Limpiar todo
        </button>
        <span className="text-xs text-[color:var(--color-ink-muted)]">
          Se sincroniza solo con tu extensión al guardar.
        </span>
      </div>
    </form>
  );
}
