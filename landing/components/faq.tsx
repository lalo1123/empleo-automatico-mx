interface FaqItem {
  q: string;
  a: string;
}

interface FaqProps {
  items: FaqItem[];
}

export function Faq({ items }: FaqProps) {
  return (
    <div className="divide-y divide-[color:var(--color-border)] rounded-[16px] border border-[color:var(--color-border)] bg-white shadow-[var(--shadow-soft)]">
      {items.map((item, i) => (
        <details
          key={item.q}
          className="group px-5 py-4 open:bg-[color:var(--color-surface-soft)]"
          // Open first item by default so users see the pattern immediately.
          {...(i === 0 ? { open: true } : {})}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left text-sm font-semibold text-[color:var(--color-ink)] [&::-webkit-details-marker]:hidden">
            <span>{item.q}</span>
            <span
              aria-hidden
              className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)] transition group-open:rotate-180"
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
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </summary>
          <p className="mt-3 text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
            {item.a}
          </p>
        </details>
      ))}
    </div>
  );
}
