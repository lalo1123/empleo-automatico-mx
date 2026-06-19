"use client";

import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";

interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Stagger delay in ms (applied as transition-delay). */
  delay?: number;
  /** Element to render as (default div). */
  as?: ElementType;
}

/**
 * Scroll-triggered entrance. Renders its children visible during SSR / before
 * hydration (so no-JS visitors and crawlers always see content); only after
 * mount does it arm the hidden state and fade the element in when it scrolls
 * into view. Reduced-motion users get the content immediately (see globals.css).
 */
export function Reveal({ children, className = "", delay = 0, as }: RevealProps) {
  const Tag = (as ?? "div") as ElementType;
  const ref = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    setMounted(true);
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Before mount: no reveal class → fully visible (SSR / no-JS safe).
  const revealClass = !mounted ? "" : shown ? "eamx-reveal is-in" : "eamx-reveal";

  return (
    <Tag
      ref={ref}
      className={`${revealClass} ${className}`.trim()}
      style={delay && mounted ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
