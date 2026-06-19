interface FaqItem {
  q: string;
  a: string;
}

interface FaqProps {
  items: FaqItem[];
}

// Minimal accordion: hairline dividers (no heavy card), the chevron rotates and
// turns teal when open, the open row gets a subtle teal wash.
export function Faq({ items }: FaqProps) {
  return (
    <div className="divide-y divide-[color:var(--color-border)] border-y border-[color:var(--color-border)]">
      {items.map((item, i) => (
        <details
          key={item.q}
          className="group"
          // Open first item by default so users see the pattern immediately.
          {...(i === 0 ? { open: true } : {})}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-[10px] px-2 py-5 text-left text-[15px] font-semibold text-[color:var(--color-ink)] transition-colors hover:text-[color:var(--color-brand-700)] [&::-webkit-details-marker]:hidden">
            <span>{item.q}</span>
            <span
              aria-hidden
              className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-[color:var(--color-border)] text-[color:var(--color-ink-muted)] transition duration-200 group-open:rotate-45 group-open:border-[color:var(--color-brand-300)] group-open:bg-[color:var(--color-brand-50)] group-open:text-[color:var(--color-brand-700)]"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
          </summary>
          <p className="px-2 pb-5 text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
            {item.a}
          </p>
        </details>
      ))}
    </div>
  );
}
