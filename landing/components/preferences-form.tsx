"use client";

import { useState, useTransition } from "react";
import {
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
const PERSONAL_FIELDS: {
  key: PersonalAnswerKey;
  icon: string;
  label: string;
  placeholder: string;
}[] = [
  { key: "vehiculo", icon: "🚗", label: "¿Vehículo propio?", placeholder: "Ej. Sí, cuento con vehículo propio" },
  { key: "licencia", icon: "🪪", label: "¿Licencia de conducir?", placeholder: "Ej. Sí, licencia vigente" },
  { key: "viajar", icon: "✈️", label: "¿Disponibilidad para viajar?", placeholder: "Ej. Sí, sin problema" },
  { key: "reubicarse", icon: "📦", label: "¿Cambio de residencia?", placeholder: "Ej. No por el momento" },
  { key: "ingles", icon: "🌐", label: "Nivel de inglés", placeholder: "Ej. Intermedio-avanzado (B2)" },
  { key: "inicio", icon: "📅", label: "¿Cuándo puedes empezar?", placeholder: "Ej. Disponibilidad inmediata" },
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
  children,
}: {
  icon: string;
  title: string;
  sub: string;
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
        <div>
          <h2 className="text-lg font-extrabold tracking-tight text-[color:var(--color-ink)]">
            {title}
          </h2>
          <p className="mt-0.5 text-[13px] leading-snug text-[color:var(--color-ink-muted)]">
            {sub}
          </p>
        </div>
      </header>
      <div className="mt-5">{children}</div>
    </section>
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
  const [personalAnswers, setPersonalAnswers] = useState<PersonalAnswers>(
    initial.personalAnswers || {}
  );
  const setAnswer = (key: PersonalAnswerKey, value: string) =>
    setPersonalAnswers((prev) => ({ ...prev, [key]: value.slice(0, 200) }));
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<
    { tone: "ok" | "err"; text: string } | null
  >(null);

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

      {/* ============ Card 2: Respuestas automáticas ============ */}
      <SectionCard
        icon="💬"
        title="Respuestas automáticas"
        sub="Las vacantes preguntan estos datos y la IA nunca los inventa: responde con TU respuesta tal cual. Los vacíos se marcan para ti (individual) o esa vacante se salta (automático)."
      >
        {/* Salario esperado — destacado */}
        <div className="rounded-xl border border-[color:var(--color-brand-200)] bg-gradient-to-br from-[color:var(--color-brand-50)] to-white p-4">
          <label
            htmlFor="pref-expected-salary"
            className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-ink)]"
          >
            <span aria-hidden>💰</span> Salario esperado
          </label>
          <p className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">
            Tu número, escrito como quieras que aparezca en la postulación.
          </p>
          <input
            id="pref-expected-salary"
            type="text"
            value={expectedSalary}
            onChange={(e) => setExpectedSalary(e.target.value.slice(0, 120))}
            placeholder="Ej. $30,000 MXN brutos mensuales"
            className={`mt-2 ${inputCls}`}
            autoComplete="off"
          />
        </div>

        <div className="mt-5 grid gap-x-4 gap-y-4 sm:grid-cols-2">
          {PERSONAL_FIELDS.map((f) => (
            <div key={f.key}>
              <label
                htmlFor={`pref-pa-${f.key}`}
                className="flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-ink)]"
              >
                <span aria-hidden>{f.icon}</span> {f.label}
              </label>
              <input
                id={`pref-pa-${f.key}`}
                type="text"
                value={personalAnswers[f.key] || ""}
                onChange={(e) => setAnswer(f.key, e.target.value)}
                placeholder={f.placeholder}
                className={`mt-1.5 ${inputCls}`}
                autoComplete="off"
              />
            </div>
          ))}

          {/* Portafolio — URL normalizada al salir del campo */}
          <div>
            <label
              htmlFor="pref-pa-portafolio"
              className="flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-ink)]"
            >
              <span aria-hidden>🎨</span> Link de portafolio
            </label>
            <input
              id="pref-pa-portafolio"
              type="text"
              value={personalAnswers.portafolio || ""}
              onChange={(e) => setAnswer("portafolio", e.target.value)}
              onBlur={(e) => setAnswer("portafolio", normalizeUrl(e.target.value))}
              placeholder="Ej. tuportafolio.com"
              className={`mt-1.5 ${inputCls}`}
              autoComplete="off"
            />
          </div>

          {/* LinkedIn — botón "abrir mi perfil" + normalización de lo pegado */}
          <div>
            <label
              htmlFor="pref-pa-linkedin"
              className="flex items-center justify-between gap-2 text-[13px] font-semibold text-[color:var(--color-ink)]"
            >
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="grid h-4 w-4 place-items-center rounded-[3px] bg-[#0a66c2] text-[10px] font-black leading-none text-white"
                >
                  in
                </span>
                Perfil de LinkedIn
              </span>
              <a
                href="https://www.linkedin.com/in/me/"
                target="_blank"
                rel="noopener noreferrer"
                className="whitespace-nowrap text-xs font-bold text-[#0a66c2] hover:underline"
                title="Abre tu propio perfil en LinkedIn para copiar el link"
              >
                Abrir mi perfil ↗
              </a>
            </label>
            <input
              id="pref-pa-linkedin"
              type="text"
              value={personalAnswers.linkedin || ""}
              onChange={(e) => setAnswer("linkedin", e.target.value)}
              onBlur={(e) => setAnswer("linkedin", normalizeLinkedIn(e.target.value))}
              placeholder="Pega tu link o solo tu usuario"
              className={`mt-1.5 ${inputCls}`}
              autoComplete="off"
            />
            <p className="mt-1 text-[11px] text-[color:var(--color-ink-muted)]">
              Tip: con sesión en LinkedIn, “Abrir mi perfil” te lleva directo —
              copia la URL y pégala aquí. Acepta solo tu usuario (lo completamos).
            </p>
          </div>
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
