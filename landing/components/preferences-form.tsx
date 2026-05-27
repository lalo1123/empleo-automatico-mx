"use client";

import { useState, useTransition } from "react";
import { putPreferences, type Modality, type UserPreferences } from "@/lib/api";

const MODALITIES: { id: Modality; label: string; sub: string }[] = [
  { id: "any", label: "Cualquiera", sub: "Sin filtro de modalidad" },
  { id: "remoto", label: "Remoto", sub: "100% desde casa" },
  { id: "hibrido", label: "Híbrido", sub: "Algunos días en oficina" },
  { id: "presencial", label: "Presencial", sub: "Todos los días en oficina" },
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
