import type { ReactNode } from "react";

interface FeatureCardProps {
  icon: ReactNode;
  title: string;
  description: string;
}

// Hairline card in the minimal+alive language: lifts with a teal-tinted glow on
// hover, the teal icon chip scales/intensifies, no heavy shadow. (.eaq-card /
// .eaq-ic hover behaviour lives in globals.css.)
export function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <article className="eaq-card flex h-full flex-col gap-3 rounded-[16px] border border-[color:var(--color-border)] bg-white p-6">
      <span
        aria-hidden
        className="eaq-ic flex h-11 w-11 items-center justify-center rounded-[12px] bg-[#eaf4f2] text-[color:var(--color-brand-600)]"
      >
        {icon}
      </span>
      <h3 className="text-[17px] font-bold tracking-tight text-[color:var(--color-ink)]">
        {title}
      </h3>
      <p className="text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
        {description}
      </p>
    </article>
  );
}
