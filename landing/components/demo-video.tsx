"use client";

// Demo video placeholder for the "Cómo funciona" section.
//
// Renders a clean 16:9 frame with a play button overlay and caption. Until a
// real video is recorded and pasted in, the click handler shows an inline
// "próximamente" message instead of playing anything.
//
// TODO: Replace with real Loom embed when recorded.
// Suggested: https://www.loom.com/share/<id>  -> pass `loomUrl="https://www.loom.com/embed/<id>"`.

import { useState } from "react";

interface DemoVideoProps {
  /** e.g. "https://www.loom.com/embed/abc123" — when set, renders the Loom iframe. */
  loomUrl?: string;
  /** YouTube video ID — alternative to `loomUrl`. */
  youtubeId?: string;
  /** Optional override for the static poster image. Defaults to an inline SVG mock. */
  posterSrc?: string;
}

export function DemoVideo({ loomUrl, youtubeId, posterSrc }: DemoVideoProps) {
  const [showToast, setShowToast] = useState(false);

  // If a real video URL was provided, just render it. The 16:9 wrapper keeps
  // the aspect ratio consistent across mobile/desktop.
  if (loomUrl) {
    return (
      <figure className="mx-auto w-full max-w-3xl">
        <div className="relative overflow-hidden rounded-[20px] border border-[color:var(--color-border)] bg-black shadow-[0_20px_60px_-20px_rgba(15,29,44,0.45)]">
          <div className="relative aspect-video w-full">
            <iframe
              src={loomUrl}
              title="Demo de Empleo Automático MX"
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              className="absolute inset-0 h-full w-full"
            />
          </div>
        </div>
        <figcaption className="mt-3 text-center text-sm text-[color:var(--color-ink-muted)]">
          Mira cómo funciona en 60 segundos
        </figcaption>
      </figure>
    );
  }

  if (youtubeId) {
    return (
      <figure className="mx-auto w-full max-w-3xl">
        <div className="relative overflow-hidden rounded-[20px] border border-[color:var(--color-border)] bg-black shadow-[0_20px_60px_-20px_rgba(15,29,44,0.45)]">
          <div className="relative aspect-video w-full">
            <iframe
              src={`https://www.youtube.com/embed/${youtubeId}?rel=0`}
              title="Demo de Empleo Automático MX"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="absolute inset-0 h-full w-full"
            />
          </div>
        </div>
        <figcaption className="mt-3 text-center text-sm text-[color:var(--color-ink-muted)]">
          Mira cómo funciona en 60 segundos
        </figcaption>
      </figure>
    );
  }

  // No real video yet — render the static poster + play overlay.
  const handleClick = () => {
    setShowToast(true);
    // Auto-dismiss after a few seconds so it doesn't linger if the user
    // scrolls away without explicitly closing.
    window.setTimeout(() => setShowToast(false), 3500);
  };

  return (
    <figure className="mx-auto w-full max-w-3xl">
      <div className="relative overflow-hidden rounded-[20px] border border-[color:var(--color-border)] bg-[color:var(--color-brand-900)] shadow-[0_20px_60px_-20px_rgba(15,29,44,0.45)]">
        <div className="relative aspect-video w-full">
          {posterSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={posterSrc}
              alt="Vista previa: la extensión sobre una vacante en OCC"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <DefaultPoster />
          )}

          {/* Play button — purely decorative until a real video is wired up. */}
          <button
            type="button"
            onClick={handleClick}
            aria-label="Reproducir demo (próximamente)"
            className="group absolute inset-0 flex items-center justify-center focus:outline-none"
          >
            <span
              aria-hidden
              className="absolute inset-0 bg-gradient-to-t from-[color:var(--color-brand-900)]/60 via-transparent to-transparent transition-opacity group-hover:opacity-80"
            />
            <span
              aria-hidden
              className="relative flex h-20 w-20 items-center justify-center rounded-full bg-white/95 text-[color:var(--color-brand-700)] shadow-[0_10px_30px_-5px_rgba(15,29,44,0.5)] transition-transform group-hover:scale-105 group-focus-visible:scale-105"
              style={{ boxShadow: "0 0 0 8px rgba(112, 209, 198, 0.25), 0 10px 30px -5px rgba(15,29,44,0.5)" }}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-9 w-9 translate-x-[2px]"
                fill="currentColor"
                aria-hidden
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          </button>

          {showToast ? (
            <div
              role="status"
              aria-live="polite"
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/95 px-4 py-2 text-xs font-medium text-[color:var(--color-ink)] shadow-[var(--shadow-md)]"
            >
              Próximamente — estamos grabando el demo.
            </div>
          ) : null}
        </div>
      </div>
      <figcaption className="mt-3 text-center text-sm text-[color:var(--color-ink-muted)]">
        Mira cómo funciona en 60 segundos
      </figcaption>
    </figure>
  );
}

// Default inline-SVG poster — a mocked OCC vacancy with the floating
// "Postular con IA" FAB. Inlined so we don't ship an extra asset just for the
// placeholder, and so it stays crisp at any size.
function DefaultPoster() {
  return (
    <svg
      viewBox="0 0 800 450"
      className="absolute inset-0 h-full w-full"
      role="img"
      aria-label="Vista previa: una vacante en OCC con el botón de Empleo Automático"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id="dv-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0f1d2c" />
          <stop offset="100%" stopColor="#105971" />
        </linearGradient>
        <linearGradient id="dv-fab" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#70d1c6" />
          <stop offset="100%" stopColor="#105971" />
        </linearGradient>
      </defs>

      <rect width="800" height="450" fill="url(#dv-bg)" />

      {/* Browser window mock */}
      <g transform="translate(80 60)">
        <rect width="640" height="330" rx="14" fill="#ffffff" />
        <rect width="640" height="32" rx="14" fill="#f1f5f9" />
        <circle cx="18" cy="16" r="5" fill="#ff5f56" />
        <circle cx="36" cy="16" r="5" fill="#ffbd2e" />
        <circle cx="54" cy="16" r="5" fill="#27c93f" />
        <rect x="80" y="8" width="280" height="16" rx="6" fill="#e2e8f0" />
        <text x="92" y="20" fontSize="10" fill="#5b6e7e" fontFamily="system-ui, sans-serif">
          occ.com.mx/empleo/desarrollador-frontend
        </text>

        {/* Vacancy content */}
        <rect x="24" y="56" width="120" height="14" rx="4" fill="#a8e6da" />
        <rect x="24" y="80" width="360" height="20" rx="4" fill="#0f1d2c" />
        <rect x="24" y="112" width="500" height="8" rx="3" fill="#e2e8f0" />
        <rect x="24" y="128" width="460" height="8" rx="3" fill="#e2e8f0" />
        <rect x="24" y="144" width="420" height="8" rx="3" fill="#e2e8f0" />
        <rect x="24" y="172" width="180" height="10" rx="3" fill="#cbd5e1" />
        <rect x="24" y="192" width="500" height="8" rx="3" fill="#e2e8f0" />
        <rect x="24" y="208" width="380" height="8" rx="3" fill="#e2e8f0" />
        <rect x="24" y="224" width="440" height="8" rx="3" fill="#e2e8f0" />
      </g>

      {/* Floating "Postular con IA" FAB — bottom right */}
      <g transform="translate(560 320)">
        <circle cx="0" cy="0" r="44" fill="rgba(112,209,198,0.25)" />
        <circle cx="0" cy="0" r="34" fill="url(#dv-fab)" />
        <text
          x="0"
          y="4"
          textAnchor="middle"
          fontSize="11"
          fontWeight="700"
          fill="#ffffff"
          fontFamily="system-ui, sans-serif"
        >
          Postular
        </text>
        <text
          x="0"
          y="18"
          textAnchor="middle"
          fontSize="10"
          fontWeight="600"
          fill="#ffffff"
          fontFamily="system-ui, sans-serif"
          opacity="0.9"
        >
          con IA
        </text>
      </g>
    </svg>
  );
}
