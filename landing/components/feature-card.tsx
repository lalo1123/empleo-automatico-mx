import type { ReactNode } from "react";

interface FeatureCardProps {
  icon: ReactNode;
  title: string;
  description: string;
}

export function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <article className="group relative flex flex-col gap-3 rounded-[16px] border border-[color:var(--color-border)] bg-white p-6 shadow-[var(--shadow-soft)] transition hover:-translate-y-0.5 hover:border-[color:var(--color-brand-300)] hover:shadow-[var(--shadow-md)]">
      <div
        aria-hidden
        className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)]"
      >
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-[color:var(--color-ink)]">
        {title}
      </h3>
      <p className="text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
        {description}
      </p>
    </article>
  );
}
