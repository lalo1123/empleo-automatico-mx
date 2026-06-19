interface TestimonialProps {
  quote: string;
  name: string;
  role: string;
}

// NOTE to director: los testimonios iniciales son ejemplos ilustrativos construidos
// por el equipo mientras reunimos beta testers. Antes de lanzar público, reemplazar
// con citas reales (con autorización por escrito del autor) y retirar el disclaimer
// de la sección.
export function Testimonial({ quote, name, role }: TestimonialProps) {
  return (
    <figure className="ead-card flex h-full flex-col justify-between gap-4 rounded-[16px] border border-[color:var(--color-border)] bg-white p-6">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="h-7 w-7 text-[color:var(--color-brand-500)]"
        fill="currentColor"
      >
        <path d="M9.5 6.5C6.5 6.5 4 9 4 12v5.5h5.5V12H7c0-1.5 1-2.5 2.5-2.5v-3zm10 0c-3 0-5.5 2.5-5.5 5.5v5.5h5.5V12H17c0-1.5 1-2.5 2.5-2.5v-3z" />
      </svg>
      <blockquote className="text-[15px] leading-relaxed text-[color:var(--color-ink)]">
        &ldquo;{quote}&rdquo;
      </blockquote>
      <figcaption className="flex items-center gap-3 border-t border-[color:var(--color-border)] pt-4">
        <span
          aria-hidden
          className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-[#137e7a] to-[#0f3d54] text-sm font-bold text-white"
        >
          {name
            .split(" ")
            .map((s) => s[0])
            .slice(0, 2)
            .join("")}
        </span>
        <div>
          <p className="text-sm font-bold text-[color:var(--color-ink)]">
            {name}
          </p>
          <p className="text-xs text-[color:var(--color-ink-muted)]">{role}</p>
        </div>
      </figcaption>
    </figure>
  );
}
