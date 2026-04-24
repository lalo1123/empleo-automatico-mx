import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "lg";

interface BaseProps {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  className?: string;
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary:
    "bg-[color:var(--color-brand-600)] text-white hover:bg-[color:var(--color-brand-700)] shadow-[var(--shadow-brand)]",
  secondary:
    "bg-white text-[color:var(--color-ink)] border border-[color:var(--color-border)] hover:border-[color:var(--color-brand-400)] hover:text-[color:var(--color-brand-700)] shadow-[var(--shadow-soft)]",
  ghost:
    "bg-transparent text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)]",
};

const SIZE_CLASS: Record<Size, string> = {
  md: "px-5 py-2.5 text-sm",
  lg: "px-6 py-3.5 text-base",
};

function buildClass(variant: Variant, size: Size, extra = "") {
  return `inline-flex items-center justify-center gap-2 rounded-[12px] font-semibold transition ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${extra}`.trim();
}

interface CtaLinkProps
  extends BaseProps,
    Omit<ComponentProps<typeof Link>, "className" | "children"> {}

export function CtaLink({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: CtaLinkProps) {
  return (
    <Link className={buildClass(variant, size, className)} {...rest}>
      {children}
    </Link>
  );
}

interface CtaButtonProps
  extends BaseProps,
    Omit<ComponentProps<"button">, "className" | "children"> {}

export function CtaButton({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: CtaButtonProps) {
  return (
    <button className={buildClass(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}
