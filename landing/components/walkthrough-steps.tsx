"use client";

// Step renderers for the Walkthrough component. Each step is a self-contained
// stylised mock with its own animation. Split out of walkthrough.tsx purely to
// keep that orchestrator file focused on state + accessibility.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import styles from "./walkthrough.module.css";

// Cover letter shown character-by-character in step 3. Real beta-tester
// vibes — short, specific, mentions the role and the candidate's strengths.
export const COVER_LETTER =
  "Hola, vi su vacante de Frontend Senior y encaja con mi experiencia. " +
  "Llevo 5 años con React y TypeScript, y en mi último puesto en Mer-Co " +
  "lideré la migración a Next.js. Me encantaría platicar sobre cómo " +
  "puedo aportar al equipo. Saludos, Daniela.";

// Phrases the cover letter highlights as "matches" against the vacancy.
const MATCH_PHRASES = ["React y TypeScript", "Next.js"] as const;

interface StepProps {
  reduced: boolean;
}

/* ------------------------------------------------------------------ */
/* Step 1 — Sube tu CV                                                 */
/* ------------------------------------------------------------------ */

export function Step1Cv({ reduced }: StepProps) {
  return (
    <div className="grid gap-4 md:grid-cols-[1.1fr_1fr] md:gap-6">
      {/* Mock options page panel with dropzone */}
      <div className="rounded-[14px] border border-[color:var(--color-border)] bg-[color:var(--color-surface-soft)] p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-ink-muted)]">
            Configuración
          </span>
          <span className="rounded-full bg-[color:var(--color-brand-50)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-brand-700)]">
            Tu CV
          </span>
        </div>
        <div
          className={`relative flex h-44 flex-col items-center justify-center gap-2 overflow-hidden rounded-[12px] border-2 border-dashed bg-white text-center sm:h-52 ${reduced ? "" : styles.dropPulse}`}
          style={{ borderColor: "rgba(112, 209, 198, 0.6)" }}
        >
          <svg
            viewBox="0 0 64 80"
            className="h-14 w-14 text-[color:var(--color-brand-700)]"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M14 4h28l14 14v54a4 4 0 01-4 4H14a4 4 0 01-4-4V8a4 4 0 014-4z" />
            <path d="M42 4v14h14" />
            <path d="M20 38h24M20 48h24M20 58h16" />
          </svg>
          <p className="text-xs font-medium text-[color:var(--color-ink)]">
            CV-Daniela-Romero.pdf
          </p>
          <p className="text-[11px] text-[color:var(--color-ink-muted)]">
            Arrastra tu PDF aquí o haz clic para subirlo
          </p>
          {!reduced ? <span aria-hidden className={styles.scanLine} /> : null}
        </div>
      </div>

      {/* Extracted structured data */}
      <div className="rounded-[14px] border border-[color:var(--color-border)] bg-white p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)]">
            <CheckIcon />
          </span>
          <span className="text-xs font-semibold text-[color:var(--color-ink)]">
            Datos extraídos
          </span>
        </div>
        <ul className="space-y-3">
          {[
            { k: "Nombre", v: "Daniela Romero", delay: 0 },
            { k: "Experiencia", v: "5 años · Frontend", delay: 120 },
            { k: "Skills", v: "React · TypeScript · Next.js", delay: 240 },
            { k: "Ubicación", v: "CDMX", delay: 360 },
          ].map((row) => (
            <li
              key={row.k}
              className={`flex flex-col gap-1 rounded-[10px] bg-[color:var(--color-surface-soft)] px-3 py-2 ${reduced ? "" : styles.fieldFadeIn}`}
              style={reduced ? undefined : { animationDelay: `${row.delay}ms` }}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-ink-muted)]">
                {row.k}
              </span>
              <span className="text-sm font-medium text-[color:var(--color-ink)]">
                {row.v}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2 — Navega vacantes                                            */
/* ------------------------------------------------------------------ */

const PORTAL_TABS = [
  { id: "occ", label: "OCC", url: "occ.com.mx/empleo/desarrollador-frontend" },
  { id: "ct", label: "CT", url: "computrabajo.com.mx/oferta/frontend" },
  { id: "bum", label: "BUM", url: "bumeran.com.mx/empleo/frontend" },
  { id: "ind", label: "IND", url: "mx.indeed.com/viewjob?jk=frontend" },
  { id: "li", label: "LI", url: "linkedin.com/jobs/view/frontend" },
] as const;

export function Step2Browse({ reduced }: StepProps) {
  // Cycle the active portal tab every ~1.4s so the user sees the extension
  // is multi-portal, not single-source. Disabled under reduced-motion.
  const [activeTab, setActiveTab] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => {
      setActiveTab((i) => (i + 1) % PORTAL_TABS.length);
    }, 1400);
    return () => window.clearInterval(id);
  }, [reduced]);

  const tab = PORTAL_TABS[activeTab];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {PORTAL_TABS.map((p, idx) => {
          const isActive = idx === activeTab;
          return (
            <span
              key={p.id}
              className={`rounded-t-[10px] border-b-0 border px-2.5 py-1 text-[10px] font-semibold transition ${
                isActive
                  ? "border-[color:var(--color-brand-300)] bg-white text-[color:var(--color-brand-700)] shadow-[0_-2px_8px_-2px_rgba(112,209,198,0.4)]"
                  : "border-transparent bg-[color:var(--color-surface-sunken)] text-[color:var(--color-ink-muted)]"
              }`}
              style={
                isActive
                  ? { boxShadow: "0 0 0 2px rgba(112,209,198,0.35) inset" }
                  : undefined
              }
            >
              {p.label}
            </span>
          );
        })}
      </div>

      <div className="relative rounded-[14px] border border-[color:var(--color-border)] bg-white shadow-[var(--shadow-soft)]">
        <BrowserChrome url={tab.url} />
        <div className="space-y-3 p-4 sm:p-5">
          <span className="inline-flex items-center rounded-full bg-[color:var(--color-brand-50)] px-2.5 py-0.5 text-[11px] font-medium text-[color:var(--color-brand-700)]">
            Tiempo completo · CDMX
          </span>
          <h3 className="text-base font-semibold text-[color:var(--color-ink)] sm:text-lg">
            Desarrollador Frontend Senior
          </h3>
          <p className="text-xs text-[color:var(--color-ink-muted)]">
            Mer-Co · publicado hace 2 días
          </p>
          <div className="space-y-2 pt-1">
            <div className="h-1.5 w-full rounded-full bg-[color:var(--color-surface-sunken)]" />
            <div className="h-1.5 w-11/12 rounded-full bg-[color:var(--color-surface-sunken)]" />
            <div className="h-1.5 w-4/5 rounded-full bg-[color:var(--color-surface-sunken)]" />
            <div className="h-1.5 w-3/5 rounded-full bg-[color:var(--color-surface-sunken)]" />
          </div>
        </div>

        {/* Floating "Postular con IA" FAB */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className={`absolute bottom-4 right-4 inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-[#70d1c6] to-[#105971] px-4 py-2.5 text-xs font-semibold text-white ${reduced ? "" : styles.fab}`}
          style={
            reduced
              ? { boxShadow: "0 8px 24px -6px rgba(16, 89, 113, 0.5)" }
              : undefined
          }
        >
          <span aria-hidden>✨</span>
          <span>Postular con IA</span>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 3 — IA genera carta                                            */
/* ------------------------------------------------------------------ */

function useTypewriter(target: string, enabled: boolean, speedMs = 22) {
  const [text, setText] = useState(enabled ? "" : target);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (!enabled) {
      setText(targetRef.current);
      return;
    }
    setText("");
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      if (i > targetRef.current.length) {
        window.clearInterval(id);
        return;
      }
      setText(targetRef.current.slice(0, i));
    }, speedMs);
    return () => window.clearInterval(id);
  }, [enabled, speedMs]);

  return text;
}

export function Step3Letter({ reduced }: StepProps) {
  const typed = useTypewriter(COVER_LETTER, !reduced, 22);
  const done = typed.length >= COVER_LETTER.length;

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_1.1fr] md:gap-5">
      {/* Underlying browser frame, dimmed to suggest it's behind the panel. */}
      <div className="hidden rounded-[14px] border border-[color:var(--color-border)] bg-white opacity-60 md:block">
        <BrowserChrome url="occ.com.mx/empleo/desarrollador-frontend" />
        <div className="space-y-3 p-4">
          <span className="inline-flex items-center rounded-full bg-[color:var(--color-brand-50)] px-2.5 py-0.5 text-[11px] font-medium text-[color:var(--color-brand-700)]">
            Tiempo completo · CDMX
          </span>
          <h3 className="text-base font-semibold text-[color:var(--color-ink)]">
            Desarrollador Frontend Senior
          </h3>
          <div className="space-y-2 pt-1">
            <div className="h-1.5 w-full rounded-full bg-[color:var(--color-surface-sunken)]" />
            <div className="h-1.5 w-4/5 rounded-full bg-[color:var(--color-surface-sunken)]" />
            <div className="h-1.5 w-3/5 rounded-full bg-[color:var(--color-surface-sunken)]" />
          </div>
        </div>
      </div>

      <div
        className={`rounded-[14px] border border-[color:var(--color-brand-200)] bg-white p-4 shadow-[var(--shadow-brand)] sm:p-5 ${reduced ? "" : styles.sidePanel}`}
      >
        <SidePanelHeader text="Empleo Automático · generando carta" />
        <div className="rounded-[10px] bg-[color:var(--color-surface-soft)] p-3 text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
          <HighlightedLetter text={typed} reduced={reduced} done={done} />
          {!reduced && !done ? (
            <span aria-hidden className={styles.caret} />
          ) : null}
        </div>
        <div className="mt-3 flex items-center justify-between text-[11px] text-[color:var(--color-ink-muted)]">
          <span>{done ? "Carta lista" : "Escribiendo..."}</span>
          <span>{typed.length}/{COVER_LETTER.length} caracteres</span>
        </div>
      </div>
    </div>
  );
}

/** Renders the cover letter, drawing a cyan underline under matched phrases
 * once the typewriter completes. We split on the matches so React can render
 * each segment as either plain text or a highlighted <mark>. */
function HighlightedLetter({
  text,
  reduced,
  done,
}: {
  text: string;
  reduced: boolean;
  done: boolean;
}) {
  const segments = useMemo(() => {
    if (!text) return [{ value: "", match: false }];
    const parts: Array<{ value: string; match: boolean }> = [];
    let cursor = 0;
    while (cursor < text.length) {
      let nextStart = -1;
      let nextLen = 0;
      for (const phrase of MATCH_PHRASES) {
        const at = text.indexOf(phrase, cursor);
        if (at !== -1 && (nextStart === -1 || at < nextStart)) {
          nextStart = at;
          nextLen = phrase.length;
        }
      }
      if (nextStart === -1) {
        parts.push({ value: text.slice(cursor), match: false });
        break;
      }
      if (nextStart > cursor) {
        parts.push({ value: text.slice(cursor, nextStart), match: false });
      }
      parts.push({ value: text.slice(nextStart, nextStart + nextLen), match: true });
      cursor = nextStart + nextLen;
    }
    return parts;
  }, [text]);

  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <mark
            key={i}
            // Only animate the underline once the typewriter has finished —
            // otherwise the underline draws while text is still moving and
            // looks janky.
            className={`bg-transparent px-0.5 font-medium text-[color:var(--color-ink)] ${
              !reduced && done ? styles.matchUnderline : ""
            }`}
            style={
              reduced || done
                ? undefined
                : {
                    backgroundImage:
                      "linear-gradient(to right, rgba(112,209,198,0.7), rgba(112,209,198,0.7))",
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "0 95%",
                    backgroundSize: "0% 30%",
                  }
            }
          >
            {seg.value}
          </mark>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Step 4 — Tú das el último clic                                      */
/* ------------------------------------------------------------------ */

export function Step4Send({ reduced }: StepProps) {
  // Beat: wait ~600ms before "filling" the form fields so the user sees the
  // before/after contrast. Skipped under reduced-motion (just shows filled).
  const [filled, setFilled] = useState(reduced);
  useEffect(() => {
    if (reduced) {
      setFilled(true);
      return;
    }
    setFilled(false);
    const id = window.setTimeout(() => setFilled(true), 600);
    return () => window.clearTimeout(id);
  }, [reduced]);

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_1fr] md:gap-5">
      <div className="rounded-[14px] border border-[color:var(--color-border)] bg-white">
        <BrowserChrome url="occ.com.mx/postular/frontend" />
        <div className="space-y-3 p-4">
          <FormField label="Nombre" value="Daniela Romero" filled={filled} reduced={reduced} />
          <FormField label="Email" value="daniela@correo.mx" filled={filled} reduced={reduced} />
          <FormField label="Teléfono" value="+52 55 1234 5678" filled={filled} reduced={reduced} />
          <FormField
            label="Carta de presentación"
            value="Hola, vi su vacante de Frontend Senior y encaja con mi experiencia..."
            filled={filled}
            reduced={reduced}
            multiline
          />
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className={`mt-2 inline-flex items-center justify-center gap-2 rounded-[10px] bg-[color:var(--color-brand-700)] px-4 py-2 text-sm font-semibold text-white ${reduced ? "" : styles.goldRing}`}
            style={reduced ? undefined : { boxShadow: "0 0 0 0 rgba(255, 196, 65, 0.85)" }}
          >
            Enviar postulación
          </button>
        </div>
      </div>

      <div className="rounded-[14px] border border-[color:var(--color-brand-200)] bg-white p-4 shadow-[var(--shadow-brand)] sm:p-5">
        <SidePanelHeader text="Carta lista para enviar" />
        <div className="rounded-[10px] bg-[color:var(--color-surface-soft)] p-3 text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
          {COVER_LETTER}
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="inline-flex flex-1 items-center justify-center rounded-[10px] bg-[color:var(--color-brand-600)] px-3 py-2 text-xs font-semibold text-white"
          >
            Aprobar y postular
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="inline-flex items-center justify-center rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2 text-xs font-semibold text-[color:var(--color-ink-soft)]"
          >
            Editar
          </button>
        </div>
        <p className="mt-4 text-center text-xs italic text-[color:var(--color-ink-muted)]">
          Tú das el último clic — siempre.
        </p>
      </div>
    </div>
  );
}

function FormField({
  label,
  value,
  filled,
  reduced,
  multiline = false,
}: {
  label: string;
  value: string;
  filled: boolean;
  reduced: boolean;
  multiline?: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-ink-muted)]">
        {label}
      </label>
      <div
        className={`overflow-hidden rounded-[8px] border border-[color:var(--color-border)] bg-[color:var(--color-surface-soft)] ${
          multiline ? "min-h-[3.5rem]" : "h-9"
        } flex items-center px-3 py-2 text-xs text-[color:var(--color-ink)]`}
      >
        {filled ? (
          <span
            className={`block max-w-full truncate ${reduced ? "" : styles.fillBar}`}
            style={reduced ? undefined : ({ "--fill-target": "100%" } as CSSProperties)}
          >
            {value}
          </span>
        ) : (
          <span aria-hidden className="block h-2 w-1/3 rounded-full bg-[color:var(--color-border)]" />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function BrowserChrome({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-[color:var(--color-border)] px-3 py-2">
      <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f56]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#27c93f]" />
      <span className="ml-2 truncate rounded-md bg-[color:var(--color-surface-soft)] px-2 py-0.5 text-[10px] text-[color:var(--color-ink-muted)] sm:text-[11px]">
        {url}
      </span>
    </div>
  );
}

function SidePanelHeader({ text }: { text: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-gradient-to-br from-[#70d1c6] to-[#105971] text-white"
      >
        <SparkleIcon />
      </span>
      <span className="text-xs font-semibold text-[color:var(--color-ink)]">
        {text}
      </span>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </svg>
  );
}
