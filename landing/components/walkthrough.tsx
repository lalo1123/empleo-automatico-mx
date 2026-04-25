"use client";

// Animated walkthrough for the "Cómo funciona" section.
//
// 4 steps auto-advance every ~5s. Pauses on hover, resumes on leave. Step
// dots below let the user jump to any step. Each step renders a stylised
// browser/CV mock with its own little animation (scan line, typewriter,
// autofill, etc.) — see walkthrough-steps.tsx. Honors
// `prefers-reduced-motion` by disabling auto-advance and all internal
// animations — content still reads fine, just static.
//
// All copy is es-MX. No external libs — pure React + CSS modules.

import { useCallback, useEffect, useState } from "react";
import styles from "./walkthrough.module.css";
import {
  Step1Cv,
  Step2Browse,
  Step3Letter,
  Step4Send,
} from "./walkthrough-steps";

const STEP_DURATION_MS = 5000;

interface Step {
  id: string;
  label: string; // short label shown next to the dot
  title: string; // step title in the stage
  caption: string; // sentence under the title
}

const STEPS: ReadonlyArray<Step> = [
  {
    id: "cv",
    label: "Sube tu CV",
    title: "Sube tu CV",
    caption:
      "Tu CV se parsea con IA y queda guardado en tu navegador, listo para todas tus postulaciones.",
  },
  {
    id: "browse",
    label: "Navega vacantes",
    title: "Navega vacantes en tu portal favorito",
    caption:
      "Funciona en OCC, Computrabajo, Bumeran, Indeed y LinkedIn. Sin cambiar tu flujo.",
  },
  {
    id: "letter",
    label: "Carta con IA",
    title: "IA genera carta personalizada",
    caption:
      "La extensión cruza tu CV con la vacante y redacta una carta única en segundos.",
  },
  {
    id: "send",
    label: "Tú decides",
    title: "Tú das el último clic",
    caption:
      "Revisas, ajustas y envías. Nunca enviamos nada sin tu confirmación.",
  },
];

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function Walkthrough() {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  // Bumped each time we (re)mount a step so its key changes and CSS-module
  // animations replay even if the user clicks the same dot or the loop
  // wraps around to the same index.
  const [tick, setTick] = useState(0);

  // Auto-advance loop. Disabled if user prefers reduced motion or the
  // pointer/focus is currently over the stage.
  useEffect(() => {
    if (reduced || paused) return;
    const id = window.setInterval(() => {
      setActive((i) => (i + 1) % STEPS.length);
      setTick((t) => t + 1);
    }, STEP_DURATION_MS);
    return () => window.clearInterval(id);
  }, [reduced, paused]);

  const goTo = useCallback((idx: number) => {
    setActive(idx);
    setTick((t) => t + 1);
  }, []);

  const onEnter = useCallback(() => setPaused(true), []);
  const onLeave = useCallback(() => setPaused(false), []);

  const step = STEPS[active];

  return (
    <section
      role="region"
      aria-label="Recorrido animado: cómo funciona Empleo Automático MX"
      className="mx-auto w-full max-w-5xl"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      <div
        className={`${styles.stage} relative overflow-hidden rounded-[20px] border border-[color:var(--color-border)] bg-white p-4 shadow-[var(--shadow-md)] sm:p-6 md:p-8`}
      >
        <div
          key={`${active}-${tick}`}
          className={reduced ? "" : styles.stepEnter}
        >
          {active === 0 ? <Step1Cv reduced={reduced} /> : null}
          {active === 1 ? <Step2Browse reduced={reduced} /> : null}
          {active === 2 ? <Step3Letter reduced={reduced} /> : null}
          {active === 3 ? <Step4Send reduced={reduced} /> : null}
        </div>
      </div>

      <div className="mt-6 text-center">
        <p
          aria-live="polite"
          className="text-base font-semibold text-[color:var(--color-ink)] sm:text-lg"
        >
          <span className="text-[color:var(--color-brand-700)]">
            Paso {String(active + 1).padStart(2, "0")}
          </span>{" "}
          · {step.title}
        </p>
        <p className="mx-auto mt-2 max-w-2xl text-sm text-[color:var(--color-ink-soft)]">
          {step.caption}
        </p>

        <div
          role="tablist"
          aria-label="Pasos del recorrido"
          className="mt-5 flex items-center justify-center gap-2"
        >
          {STEPS.map((s, idx) => {
            const isActive = idx === active;
            return (
              <button
                key={s.id}
                role="tab"
                aria-selected={isActive}
                aria-label={`Ir al paso ${idx + 1}: ${s.label}`}
                onClick={() => goTo(idx)}
                type="button"
                className={`group flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  isActive
                    ? "bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)]"
                    : "text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink-soft)]"
                }`}
              >
                <span
                  aria-hidden
                  className={`h-2.5 w-2.5 rounded-full transition ${
                    isActive
                      ? "bg-[color:var(--color-brand-600)]"
                      : "border border-[color:var(--color-border)] bg-white group-hover:border-[color:var(--color-brand-400)]"
                  }`}
                />
                <span className="hidden sm:inline">{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
