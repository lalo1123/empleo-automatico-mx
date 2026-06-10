"use client";

import { useState, useTransition } from "react";
import {
  type Modality,
  type PersonalAnswerKey,
  type PersonalAnswers,
  type UserPreferences,
} from "@/lib/api";

const MODALITIES: { id: Modality; label: string; sub: string }[] = [
  { id: "any", label: "Cualquiera", sub: "Sin filtro de modalidad" },
  { id: "remoto", label: "Remoto", sub: "100% desde casa" },
  { id: "hibrido", label: "Híbrido", sub: "Algunos días en oficina" },
  { id: "presencial", label: "Presencial", sub: "Todos los días en oficina" },
];

// Personal screening questions the AI never invents — the auto-postular
// answers them with YOUR saved text. Keys must match backend
// PERSONAL_ANSWER_KEYS and the extension's PERSONAL_ANSWER_PATTERNS.
const PERSONAL_FIELDS: {
  key: PersonalAnswerKey;
  label: string;
  placeholder: string;
}[] = [
  { key: "vehiculo", label: "¿Vehículo propio?", placeholder: "Ej. Sí, cuento con vehículo propio" },
  { key: "licencia", label: "¿Licencia de conducir?", placeholder: "Ej. Sí, licencia vigente" },
  { key: "viajar", label: "¿Disponibilidad para viajar?", placeholder: "Ej. Sí, sin problema" },
  { key: "reubicarse", label: "¿Cambio de residencia?", placeholder: "Ej. No por el momento" },
  { key: "ingles", label: "Nivel de inglés", placeholder: "Ej. Intermedio-avanzado (B2)" },
  { key: "inicio", label: "¿Cuándo puedes empezar?", placeholder: "Ej. Disponibilidad inmediata" },
  { key: "portafolio", label: "Link de portafolio", placeholder: "Ej. https://tuportafolio.com" },
  { key: "linkedin", label: "Perfil de LinkedIn", placeholder: "Ej. https://linkedin.com/in/tu-nombre" },
];

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
        // Token is in the session cookie; we need to read it client-side.
        // Easiest: hit a small /api proxy. But we don't have one. Use
        // fetch directly to /v1/account/preferences with credentials,
        // letting the cookie travel through.
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
        setStatus({ tone: "ok", text: "Preferencias guardadas." });
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
    <form
      onSubmit={handleSubmit}
      className="rounded-[16px] border border-[color:var(--color-border)] bg-white p-6 shadow-[var(--shadow-soft)]"
    >
      {/* Ciudad */}
      <div>
        <label
          htmlFor="pref-city"
          className="text-sm font-semibold text-[color:var(--color-ink)]"
        >
          Ciudad
        </label>
        <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
          Vacantes en esta ciudad reciben puntos extra. Déjalo vacío si te da
          igual la ubicación.
        </p>
        <input
          id="pref-city"
          type="text"
          value={city}
          onChange={(e) => setCity(e.target.value.slice(0, 100))}
          placeholder="Ej. Ciudad de México, Monterrey, Guadalajara…"
          className="mt-2 w-full rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2 text-sm text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-brand-500)]"
          autoComplete="off"
        />
      </div>

      {/* Modalidad */}
      <div className="mt-6">
        <span className="text-sm font-semibold text-[color:var(--color-ink)]">
          Modalidad preferida
        </span>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {MODALITIES.map((m) => (
            <label
              key={m.id}
              className={`flex cursor-pointer items-start gap-2 rounded-[10px] border p-3 text-sm transition ${
                modality === m.id
                  ? "border-[color:var(--color-brand-500)] bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)]"
                  : "border-[color:var(--color-border)] bg-white hover:border-[color:var(--color-brand-400)]"
              }`}
            >
              <input
                type="radio"
                name="modality"
                value={m.id}
                checked={modality === m.id}
                onChange={() => setModality(m.id)}
                className="mt-0.5 accent-[color:var(--color-brand-600)]"
              />
              <div>
                <div className="font-semibold">{m.label}</div>
                <div className="text-xs text-[color:var(--color-ink-muted)]">
                  {m.sub}
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Salary range */}
      <div className="mt-6">
        <span className="text-sm font-semibold text-[color:var(--color-ink)]">
          Salario mensual (MXN)
        </span>
        <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
          Vacantes en este rango reciben puntos extra. Opcional.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2">
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
          <div className="flex items-center gap-2 rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2">
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

      {/* Expected salary — the auto-answer typed into "¿expectativa salarial?" */}
      <div className="mt-6">
        <label
          htmlFor="pref-expected-salary"
          className="text-sm font-semibold text-[color:var(--color-ink)]"
        >
          Salario esperado (respuesta automática)
        </label>
        <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
          Cuando una vacante pregunta tu expectativa salarial, el auto-postular
          responde con ESTO — tu número, no inventado. Escríbelo como quieras que
          aparezca. Si lo dejas vacío, esas vacantes se saltan en automático.
        </p>
        <input
          id="pref-expected-salary"
          type="text"
          value={expectedSalary}
          onChange={(e) => setExpectedSalary(e.target.value.slice(0, 120))}
          placeholder="Ej. $30,000 MXN brutos mensuales"
          className="mt-2 w-full rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2 text-sm text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-brand-500)]"
          autoComplete="off"
        />
      </div>

      {/* Personal auto-answers — the screening questions the AI never invents */}
      <div className="mt-6">
        <span className="text-sm font-semibold text-[color:var(--color-ink)]">
          Respuestas automáticas personales
        </span>
        <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
          Las vacantes suelen preguntar estos datos y la IA nunca los inventa.
          Si los guardas aquí, el auto-postular responde con TU respuesta tal
          cual. Los que dejes vacíos: en modo individual te los marca para que
          los escribas tú; en automático esa vacante se salta.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {PERSONAL_FIELDS.map((f) => (
            <div key={f.key}>
              <label
                htmlFor={`pref-pa-${f.key}`}
                className="text-xs font-medium text-[color:var(--color-ink-soft)]"
              >
                {f.label}
              </label>
              <input
                id={`pref-pa-${f.key}`}
                type="text"
                value={personalAnswers[f.key] || ""}
                onChange={(e) => setAnswer(f.key, e.target.value)}
                placeholder={f.placeholder}
                className="mt-1 w-full rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2 text-sm text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-brand-500)]"
                autoComplete="off"
              />
            </div>
          ))}
        </div>
      </div>

      {status && (
        <div
          role={status.tone === "err" ? "alert" : "status"}
          className={`mt-6 rounded-[10px] border px-3 py-2 text-sm ${
            status.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {status.text}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[12px] bg-[color:var(--color-brand-600)] px-5 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition hover:bg-[color:var(--color-brand-700)] disabled:cursor-progress disabled:opacity-60"
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
          className="rounded-[12px] border border-[color:var(--color-border)] bg-white px-5 py-2.5 text-sm font-semibold text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
        >
          Limpiar todo
        </button>
      </div>
    </form>
  );
}
