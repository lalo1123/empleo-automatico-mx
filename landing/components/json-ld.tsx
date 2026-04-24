// Reusable JSON-LD (schema.org) component.
// Renders a <script type="application/ld+json"> tag with a given schema
// object. Safe to use in Server Components (no hooks, no state).
//
// Usage:
//   <JsonLd schema={{ "@context": "https://schema.org", "@type": "Organization", ... }} />
//
// Multiple blocks per page are fine (in fact recommended: one per @type).

// Plain JSON-serialisable value. Kept permissive on purpose — schema.org
// documents nest many different @type shapes and a stricter type would
// mean casting at every call site. Validation happens via Google's Rich
// Results Test, not via TypeScript.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonLdSchema = Record<string, any>;

interface JsonLdProps {
  /** A schema.org JSON-LD object. Will be serialized as-is. */
  schema: JsonLdSchema | JsonLdSchema[];
  /** Optional id so the script tag is easy to find during debugging. */
  id?: string;
}

export function JsonLd({ schema, id }: JsonLdProps) {
  // JSON-LD is rendered as-is via dangerouslySetInnerHTML. We escape `<` to
  // avoid any chance of breaking out of the <script> tag. JSON.stringify
  // already escapes `"` and control chars.
  const json = JSON.stringify(schema).replace(/</g, "\\u003c");
  return (
    <script
      type="application/ld+json"
      id={id}
      // eslint-disable-next-line react/no-danger -- JSON-LD requires raw script content
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
