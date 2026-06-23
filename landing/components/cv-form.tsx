"use client";

// Mi CV — manage the CV from the web account (the source of truth). Two ways to
// create it: "Crear con IA" (chat interview → /applications/build-profile) or
// "Pegar mi CV" (paste text → /applications/parse-cv). Both persist server-side
// and sync down to the extension. All calls go through the /api/cv proxy.

import { useRef, useState } from "react";
import type { UserProfile } from "@/lib/api";

// pdf.js is self-hosted under /public/vendor (copied from the extension's
// vendored build) and loaded ON DEMAND only when the user uploads a PDF — so
// it never bloats the main bundle and needs no npm dependency. The UMD build
// sets window.pdfjsLib; we extract text fully in the browser (the PDF never
// leaves the user's machine — only the parsed TEXT goes to our backend, the
// same path as "Pegar mi CV").
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB

type PdfTextItem = { str?: string; transform?: number[]; width?: number; hasEOL?: boolean };
type PdfDocLike = {
  numPages: number;
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: PdfTextItem[] }> }>;
};
type PdfLib = {
  getDocument: (opts: { data: ArrayBuffer }) => { promise: Promise<PdfDocLike> };
  GlobalWorkerOptions?: { workerSrc: string };
};

async function loadPdfLib(): Promise<PdfLib> {
  const w = window as unknown as { pdfjsLib?: PdfLib };
  if (w.pdfjsLib) return w.pdfjsLib;
  await new Promise<void>((resolve, reject) => {
    const id = "eamx-pdfjs";
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing) {
      if (w.pdfjsLib) return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("No se pudo cargar el lector de PDF.")));
      return;
    }
    const s = document.createElement("script");
    s.id = id;
    s.src = "/vendor/pdf.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("No se pudo cargar el lector de PDF."));
    document.head.appendChild(s);
  });
  if (!w.pdfjsLib) throw new Error("No se pudo cargar el lector de PDF.");
  return w.pdfjsLib;
}

// Reconstruct readable text from a pdf.js page. A naive items.join(" ") inserts
// a space between EVERY text run, which shatters words ("serrat os",
// "po sicionamiento") and runs sections together. Instead we use each run's
// geometry (transform x/y + width): a big vertical change → newline; a real
// horizontal gap → single space; adjacent runs → glued (same word).
function pageItemsToText(items: PdfTextItem[]): string {
  let out = "";
  let prev: PdfTextItem | null = null;
  for (const item of items) {
    const str = item.str || "";
    if (!str) {
      if (item.hasEOL && !out.endsWith("\n")) out += "\n";
      continue;
    }
    const tr = item.transform || [1, 0, 0, 1, 0, 0];
    const x = tr[4] || 0;
    const y = tr[5] || 0;
    if (prev) {
      const ptr = prev.transform || [1, 0, 0, 1, 0, 0];
      const prevEndX = (ptr[4] || 0) + (prev.width || 0);
      const dy = Math.abs(y - (ptr[5] || 0));
      if (prev.hasEOL || dy > 4) {
        if (!out.endsWith("\n")) out += "\n";
      } else if (x - prevEndX > 0.8) {
        if (!out.endsWith(" ") && !out.endsWith("\n")) out += " ";
      }
    }
    out += str;
    prev = item;
  }
  return out;
}

async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  const lib = await loadPdfLib();
  if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.js";
  const pdf = await lib.getDocument({ data: buf }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(pageItemsToText(content.items));
  }
  // Tidy up: trim each line, collapse runs of blank lines, drop leading/trailing space.
  return pages
    .join("\n\n")
    .split("\n")
    .map((ln) => ln.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const QUESTIONS = [
  "¡Hola! 👋 Vamos a armar tu CV. Para empezar, ¿cuál es tu nombre completo?",
  "¿A qué te dedicas o qué tipo de trabajo buscas? (tu puesto o área principal)",
  "Cuéntame tu experiencia: ¿en qué empresas has trabajado, qué puesto tenías y qué hacías? Pon las que quieras (y los años si los recuerdas).",
  "¿Qué sabes hacer? Herramientas, habilidades, idiomas… lo que se te ocurra.",
  "¿Qué estudiaste? (carrera e institución). Y si quieres, déjame tu correo y ciudad para llenar formularios.",
];

type Msg = { role: "bot" | "user"; text: string };
type Mode = "menu" | "chat" | "paste";

function yearsOfExperience(exp: UserProfile["experience"]): number {
  if (!Array.isArray(exp) || !exp.length) return 0;
  const ranges: [number, number][] = [];
  for (const e of exp) {
    const s = e.startDate ? new Date(e.startDate).getTime() : NaN;
    const f = e.endDate ? new Date(e.endDate).getTime() : Date.now();
    if (Number.isNaN(s) || Number.isNaN(f) || f < s) continue;
    ranges.push([s, f]);
  }
  if (!ranges.length) return 0;
  ranges.sort((a, b) => a[0] - b[0]);
  let total = 0,
    cs = ranges[0][0],
    ce = ranges[0][1];
  for (let i = 1; i < ranges.length; i++) {
    const [s, f] = ranges[i];
    if (s <= ce) ce = Math.max(ce, f);
    else {
      total += ce - cs;
      cs = s;
      ce = f;
    }
  }
  total += ce - cs;
  return Math.round((total / (1000 * 60 * 60 * 24 * 365.25)) * 10) / 10;
}

function CvPreview({ p }: { p: UserProfile }) {
  const yrs = yearsOfExperience(p.experience);
  const Item = ({ k, v }: { k: string; v: string }) => (
    <div className="rounded-xl border border-[color:var(--color-border)] bg-white p-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-ink-muted)]">{k}</div>
      <div className="mt-0.5 text-sm font-semibold text-[color:var(--color-ink)]">{v || "—"}</div>
    </div>
  );
  return (
    <div className="rounded-2xl border border-[#99f6e4] bg-[#f0fdfa] p-4 sm:p-5">
      <div className="flex items-center gap-2 text-sm font-bold text-[#0f766e]">
        <span aria-hidden>✅</span> Tu CV quedó guardado en tu cuenta y se sincroniza solo con la extensión.
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Item k="Nombre" v={p.personal?.fullName || ""} />
        <Item k="Puesto" v={p.experience?.[0]?.role || ""} />
        <Item k="Años de experiencia" v={yrs > 0 ? String(yrs) : ""} />
        <Item k="Top skills" v={(p.skills || []).slice(0, 3).join(", ")} />
      </div>
      {p.summary ? (
        <p className="mt-3 text-xs leading-relaxed text-[color:var(--color-ink-muted)]">{p.summary}</p>
      ) : null}
    </div>
  );
}

export function CvForm({ initial }: { initial: UserProfile | null }) {
  const [profile, setProfile] = useState<UserProfile | null>(initial);
  const [mode, setMode] = useState<Mode>("menu");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [qaIdx, setQaIdx] = useState(0);
  const [qa, setQa] = useState<Array<{ question: string; answer: string }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function startChat() {
    setStatus(null);
    setMode("chat");
    setQaIdx(0);
    setQa([]);
    setMessages([{ role: "bot", text: QUESTIONS[0] }]);
  }

  function sendChat() {
    const val = chatInput.trim();
    if (!val || qaIdx >= QUESTIONS.length || pending) return;
    const nextQa = [...qa, { question: QUESTIONS[qaIdx], answer: val }];
    const nextMsgs: Msg[] = [...messages, { role: "user", text: val }];
    const nextIdx = qaIdx + 1;
    setChatInput("");
    if (nextIdx < QUESTIONS.length) {
      nextMsgs.push({ role: "bot", text: QUESTIONS[nextIdx] });
      setMessages(nextMsgs);
      setQa(nextQa);
      setQaIdx(nextIdx);
    } else {
      setMessages([...nextMsgs, { role: "bot", text: "¡Perfecto! Dame unos segundos, estoy armando tu CV… ✨" }]);
      setQa(nextQa);
      setQaIdx(nextIdx);
      void build(nextQa);
    }
  }

  async function build(finalQa: Array<{ question: string; answer: string }>) {
    setPending(true);
    setStatus(null);
    try {
      const res = await fetch("/api/cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "build", qa: finalQa }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error?.message || "No se pudo crear el CV.");
      setProfile(data.profile);
      setMessages((m) => [...m, { role: "bot", text: "✅ ¡Listo! Tu CV quedó armado y guardado en tu cuenta." }]);
      setStatus({ tone: "ok", text: "CV creado y guardado." });
      setMode("menu");
    } catch (e) {
      setMessages((m) => [...m, { role: "bot", text: "⚠️ " + (e instanceof Error ? e.message : "Error") + " Puedes reintentar." }]);
      setStatus({ tone: "err", text: e instanceof Error ? e.message : "Error" });
      setQaIdx(QUESTIONS.length - 1);
    } finally {
      setPending(false);
    }
  }

  async function importPaste() {
    const text = pasteText.trim();
    if (text.length < 20 || pending) {
      setStatus({ tone: "err", text: "Pega un poco más de texto de tu CV." });
      return;
    }
    setPending(true);
    setStatus(null);
    try {
      const res = await fetch("/api/cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "parse", text }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error?.message || "No se pudo analizar el CV.");
      setProfile(data.profile);
      setStatus({ tone: "ok", text: "CV analizado y guardado." });
      setMode("menu");
      setPasteText("");
    } catch (e) {
      setStatus({ tone: "err", text: e instanceof Error ? e.message : "Error" });
    } finally {
      setPending(false);
    }
  }

  // Upload a PDF → extract its text in the browser → drop it into the paste
  // flow so the user can review before analyzing. Reuses the exact same
  // parse pipeline as "Pegar mi CV"; the PDF itself never leaves the browser.
  async function onPdfSelected(file: File | undefined) {
    if (fileRef.current) fileRef.current.value = ""; // allow re-picking same file
    if (!file || pending) return;
    setStatus(null);
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setStatus({ tone: "err", text: "Solo se acepta PDF." });
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setStatus({ tone: "err", text: "El PDF pesa más de 10 MB." });
      return;
    }
    setPending(true);
    setStatus({ tone: "ok", text: "Leyendo tu PDF…" });
    try {
      const buf = await file.arrayBuffer();
      const text = (await extractPdfText(buf)).trim();
      if (text.length < 30) {
        setMode("paste");
        setStatus({ tone: "err", text: "No pude extraer texto (¿es un PDF escaneado o de imagen?). Copia y pega el texto de tu CV." });
        return;
      }
      setPasteText(text);
      setMode("paste");
      setStatus({ tone: "ok", text: "✅ Extraje el texto de tu PDF — revísalo y dale “Analizar mi CV”." });
    } catch (e) {
      setMode("paste");
      setStatus({ tone: "err", text: (e instanceof Error ? e.message : "No pude leer el PDF.") + " Copia y pega el texto." });
    } finally {
      setPending(false);
    }
  }

  const btnPrimary =
    "inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#137e7a,#105971)] px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60";
  const btnGhost =
    "inline-flex items-center justify-center gap-2 rounded-xl border border-[color:var(--color-border)] bg-white px-5 py-3 text-sm font-semibold text-[color:var(--color-ink)] transition hover:border-[color:var(--color-brand-400)]";

  return (
    <div className="rounded-2xl border border-[color:var(--color-border)] bg-white p-6 shadow-sm sm:p-7">
      <div className="mb-5">
        <h2 className="text-lg font-bold text-[color:var(--color-ink)]">Mi CV</h2>
        <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
          Tu CV vive aquí, en tu cuenta — la extensión lo usa para postular por ti.
          {profile ? " Ya tienes uno; puedes rehacerlo cuando quieras." : " Sube tu PDF, pégalo, o créalo con IA en 2 minutos."}
        </p>
      </div>

      {profile && mode === "menu" ? <CvPreview p={profile} /> : null}

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => onPdfSelected(e.target.files?.[0])}
      />

      {mode === "menu" ? (
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" className={btnPrimary} onClick={startChat} disabled={pending}>
            ✨ {profile ? "Rehacer con IA" : "Crear mi CV con IA"}
          </button>
          <button type="button" className={btnGhost} onClick={() => fileRef.current?.click()} disabled={pending}>
            📄 Subir mi CV (PDF)
          </button>
          <button type="button" className={btnGhost} onClick={() => { setMode("paste"); setStatus(null); }} disabled={pending}>
            📋 Pegar mi CV (texto)
          </button>
        </div>
      ) : null}

      {mode === "chat" ? (
        <div className="mt-4">
          <div className="flex max-h-[380px] flex-col gap-2.5 overflow-y-auto rounded-2xl bg-[#f7fafb] p-3" role="log" aria-live="polite">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "bot" ? "justify-start" : "justify-end"}`}>
                <div
                  className={
                    m.role === "bot"
                      ? "max-w-[86%] rounded-2xl rounded-bl-sm bg-[#eef2f5] px-3.5 py-2.5 text-sm leading-relaxed text-[color:var(--color-ink)] whitespace-pre-wrap"
                      : "max-w-[86%] rounded-2xl rounded-br-sm bg-[linear-gradient(135deg,#137e7a,#105971)] px-3.5 py-2.5 text-sm leading-relaxed text-white whitespace-pre-wrap"
                  }
                >
                  {m.text}
                </div>
              </div>
            ))}
          </div>
          {qaIdx < QUESTIONS.length ? (
            <div className="mt-3 flex items-end gap-2">
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendChat();
                  }
                }}
                rows={2}
                placeholder="Tu respuesta…"
                className="min-h-[44px] flex-1 resize-y rounded-xl border border-[color:var(--color-border)] bg-white px-3.5 py-2.5 text-sm text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-brand-500)]"
                disabled={pending}
              />
              <button type="button" className={btnPrimary} onClick={sendChat} disabled={pending || !chatInput.trim()}>
                Enviar
              </button>
            </div>
          ) : pending ? (
            <p className="mt-3 text-sm font-semibold text-[#0f766e]">Construyendo tu CV con IA… ✨</p>
          ) : null}
          <button type="button" className="mt-3 text-xs text-[color:var(--color-ink-muted)] underline" onClick={() => setMode("menu")} disabled={pending}>
            ← Volver
          </button>
        </div>
      ) : null}

      {mode === "paste" ? (
        <div className="mt-4">
          <label htmlFor="cvPaste" className="text-sm font-semibold text-[color:var(--color-ink)]">
            Pega el texto de tu CV
          </label>
          <textarea
            id="cvPaste"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={10}
            placeholder="Copia y pega aquí todo el texto de tu CV (de tu PDF, LinkedIn, etc.). La IA lo estructura."
            className="mt-1.5 w-full resize-y rounded-xl border border-[color:var(--color-border)] bg-white px-3.5 py-2.5 text-sm text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-brand-500)]"
            disabled={pending}
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" className={btnPrimary} onClick={importPaste} disabled={pending || pasteText.trim().length < 20}>
              {pending ? "Analizando…" : "Analizar mi CV"}
            </button>
            <button type="button" className={btnGhost} onClick={() => fileRef.current?.click()} disabled={pending}>
              📄 Subir un PDF
            </button>
            <button type="button" className={btnGhost} onClick={() => setMode("menu")} disabled={pending}>
              ← Volver
            </button>
          </div>
        </div>
      ) : null}

      {status ? (
        <p className={`mt-4 text-sm font-medium ${status.tone === "ok" ? "text-[#0f766e]" : "text-[#c2410c]"}`}>{status.text}</p>
      ) : null}
    </div>
  );
}
