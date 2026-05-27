"use client";

import { useEffect, useState } from "react";
import type {
  Application,
  ApplicationEvent,
  ApplicationStep,
} from "@/lib/api";

// Human-readable label per step. Matches the extension's
// BULK_STATUS_LABELS but tuned for the web detail drawer (past tense
// where natural, no ellipsis since these are finished events).
const STEP_LABELS: Record<ApplicationStep, string> = {
  starting: "Cadena inició",
  cv: "Seleccionó CV",
  cv_personalized: "CV personalizado con IA",
  cover: "Carta generada con IA",
  questions: "Respuestas IA a preguntas abiertas",
  quiz: "Quiz resuelto automáticamente",
  ready: "Lista para Finalizar",
  submitted: "Postulación enviada",
  error: "Error en la cadena",
  plan_limit: "Llegó al límite del plan",
  closed: "Vacante cerrada",
  no_form: "No se detectó formulario",
  already_applied: "Ya estaba postulada",
};

// Color + icon per step.
const STEP_THEMES: Record<
  ApplicationStep,
  { icon: string; tone: "ok" | "info" | "warn" | "err" }
> = {
  starting: { icon: "⚡", tone: "info" },
  cv: { icon: "📄", tone: "info" },
  cv_personalized: { icon: "✨", tone: "info" },
  cover: { icon: "✍️", tone: "info" },
  questions: { icon: "💬", tone: "info" },
  quiz: { icon: "🧠", tone: "info" },
  ready: { icon: "✓", tone: "ok" },
  submitted: { icon: "🎯", tone: "ok" },
  error: { icon: "✗", tone: "err" },
  plan_limit: { icon: "⚠️", tone: "warn" },
  closed: { icon: "🚫", tone: "err" },
  no_form: { icon: "❓", tone: "warn" },
  already_applied: { icon: "↩️", tone: "info" },
};

function formatTime(unixSec: number) {
  const d = new Date(unixSec * 1000);
  return d.toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toneClass(tone: "ok" | "info" | "warn" | "err") {
  switch (tone) {
    case "ok":
      return "bg-emerald-50 text-emerald-700 ring-emerald-200";
    case "warn":
      return "bg-amber-50 text-amber-700 ring-amber-200";
    case "err":
      return "bg-rose-50 text-rose-700 ring-rose-200";
    default:
      return "bg-sky-50 text-sky-700 ring-sky-200";
  }
}

export function ApplicationTimelineDrawer({
  app,
  onClose,
}: {
  app: Application | null;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!app) {
      setMounted(false);
      return;
    }
    // Trigger slide-in animation after mount.
    const t = setTimeout(() => setMounted(true), 16);
    // Esc to close.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Lock body scroll so the drawer feels modal.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [app, onClose]);

  if (!app) return null;
  const events: ApplicationEvent[] = app.events ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-labelledby="eamx-drawer-title"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        className={`absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-200 ${
          mounted ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* Drawer */}
      <aside
        className={`relative ml-auto h-full w-full max-w-md bg-white shadow-[var(--shadow-soft)] transition-transform duration-200 ease-out sm:max-w-lg ${
          mounted ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] bg-white px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
              {app.source}
            </p>
            <h2
              id="eamx-drawer-title"
              className="mt-0.5 truncate text-lg font-bold text-[color:var(--color-ink)]"
            >
              {app.title || "(sin título)"}
            </h2>
            <p className="truncate text-sm text-[color:var(--color-ink-soft)]">
              {app.company || "—"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-surface-soft)] hover:text-[color:var(--color-ink)]"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </header>

        <div className="max-h-[calc(100vh-72px)] overflow-y-auto px-5 py-5">
          {/* Top metadata */}
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-[color:var(--color-ink-muted)]">
                Match
              </dt>
              <dd className="mt-0.5 font-semibold text-[color:var(--color-ink)]">
                {app.matchScore > 0 ? `${app.matchScore}%` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[color:var(--color-ink-muted)]">
                Postulada
              </dt>
              <dd className="mt-0.5 font-semibold text-[color:var(--color-ink)]">
                {formatTime(app.appliedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[color:var(--color-ink-muted)]">
                Estado
              </dt>
              <dd className="mt-0.5 font-semibold text-[color:var(--color-ink)]">
                {app.status === "applied"
                  ? "Postulado"
                  : app.status === "viewed"
                    ? "Visto"
                    : app.status === "rejected"
                      ? "Rechazado"
                      : "Contratado"}
              </dd>
            </div>
          </dl>

          {/* Open-in-portal CTA */}
          {app.url && (
            <a
              href={app.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-flex items-center gap-2 rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2 text-sm font-medium text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
            >
              Ver vacante en {app.source} ↗
            </a>
          )}

          {/* Timeline */}
          <section className="mt-6">
            <h3 className="text-sm font-semibold text-[color:var(--color-ink)]">
              Qué hizo la cadena
            </h3>
            {events.length === 0 ? (
              <p className="mt-3 text-sm text-[color:var(--color-ink-soft)]">
                Esta postulación no tiene timeline detallado todavía.
                Las postulaciones nuevas registrarán cada paso aquí.
              </p>
            ) : (
              <ol className="mt-3 space-y-3">
                {events.map((ev, i) => {
                  const theme =
                    STEP_THEMES[ev.step] ?? STEP_THEMES.starting;
                  const label =
                    ev.label || STEP_LABELS[ev.step] || String(ev.step);
                  return (
                    <li key={i} className="flex items-start gap-3">
                      <div
                        className={`flex h-9 w-9 flex-none items-center justify-center rounded-full ring-1 ${toneClass(
                          theme.tone
                        )}`}
                      >
                        <span aria-hidden>{theme.icon}</span>
                      </div>
                      <div className="min-w-0 flex-1 pt-1">
                        <div className="text-sm font-semibold text-[color:var(--color-ink)]">
                          {label}
                        </div>
                        <div className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">
                          {formatTime(ev.at)}
                        </div>
                        {ev.meta && Object.keys(ev.meta).length > 0 && (
                          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1 text-xs text-[color:var(--color-ink-soft)]">
                            {Object.entries(ev.meta).map(([k, v]) => (
                              <div key={k} className="contents">
                                <dt className="font-medium uppercase tracking-wider text-[color:var(--color-ink-muted)]">
                                  {k}
                                </dt>
                                <dd className="truncate">{String(v)}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {/* Match reasons (legacy field) */}
          {app.reasons.length > 0 && (
            <section className="mt-6">
              <h3 className="text-sm font-semibold text-[color:var(--color-ink)]">
                Por qué hizo match
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-[color:var(--color-ink-soft)]">
                {app.reasons.map((r, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span aria-hidden className="text-[color:var(--color-brand-600)]">
                      ✓
                    </span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
