// Historial — full list of postulaciones synced from the Chrome extension's
// attachFinalizeApplyTracker. Lets the user see EVERYTHING they applied to
// across the 6 supported portals from one place, with filter/pagination.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import {
  getAccount,
  getApplicationsHistory,
  getApplicationsStats,
  ApiCallError,
  type ApplicationSource,
  type ApplicationStatus,
} from "@/lib/api";
import { clearSessionCookie, getSessionToken } from "@/lib/auth";
import { pageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const metadata: Metadata = pageMetadata({
  title: "Historial de postulaciones",
  description: "Todas tus postulaciones sincronizadas desde la extensión.",
  path: "/account/historial",
  noIndex: true,
});

interface PageProps {
  searchParams: Promise<{
    source?: string;
    status?: string;
    page?: string;
  }>;
}

const SOURCES: { id: ApplicationSource; label: string }[] = [
  { id: "lapieza", label: "LaPieza" },
  { id: "occ", label: "OCC" },
  { id: "computrabajo", label: "Computrabajo" },
  { id: "indeed", label: "Indeed" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "bumeran", label: "Bumeran" },
];

const STATUSES: { id: ApplicationStatus; label: string }[] = [
  { id: "applied", label: "Postulado" },
  { id: "viewed", label: "Visto" },
  { id: "rejected", label: "Rechazado" },
  { id: "hired", label: "Contratado" },
];

function isValidSource(s: string | undefined): s is ApplicationSource {
  return !!s && SOURCES.some((src) => src.id === s);
}
function isValidStatus(s: string | undefined): s is ApplicationStatus {
  return !!s && STATUSES.some((st) => st.id === s);
}

function formatDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function statusLabel(status: ApplicationStatus): string {
  return STATUSES.find((s) => s.id === status)?.label ?? status;
}

function sourceLabel(source: ApplicationSource): string {
  return SOURCES.find((s) => s.id === source)?.label ?? source;
}

function statusTone(status: ApplicationStatus): string {
  switch (status) {
    case "hired":
      return "bg-emerald-50 text-emerald-800 border-emerald-200";
    case "viewed":
      return "bg-sky-50 text-sky-800 border-sky-200";
    case "rejected":
      return "bg-rose-50 text-rose-800 border-rose-200";
    case "applied":
    default:
      return "bg-slate-50 text-slate-700 border-slate-200";
  }
}

const PAGE_SIZE = 25;

export default async function HistorialPage({ searchParams }: PageProps) {
  const token = await getSessionToken();
  if (!token) redirect("/login?next=/account/historial");

  const { source, status, page: pageParam } = await searchParams;
  const selectedSource = isValidSource(source) ? source : undefined;
  const selectedStatus = isValidStatus(status) ? status : undefined;
  const page = Math.max(1, Number(pageParam) || 1);

  // Fetch account + stats + history in parallel.
  let accountData;
  let statsData;
  let historyData;
  try {
    [accountData, statsData, historyData] = await Promise.all([
      getAccount(token!),
      getApplicationsStats(token!),
      getApplicationsHistory(token!, {
        source: selectedSource,
        status: selectedStatus,
        page,
        pageSize: PAGE_SIZE,
      }),
    ]);
  } catch (err) {
    if (err instanceof ApiCallError && (err.status === 401 || err.status === 403)) {
      await clearSessionCookie();
      redirect("/login?error=invalid");
    }
    redirect("/account?error=history_load");
  }

  const { user } = accountData!;
  const stats = statsData!.stats;
  const { applications, total } = historyData!;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Build "previous filter" URLs while preserving the other filters.
  function buildHref(overrides: { source?: string; status?: string; page?: number }) {
    const params = new URLSearchParams();
    const finalSource = overrides.source !== undefined ? overrides.source : selectedSource;
    const finalStatus = overrides.status !== undefined ? overrides.status : selectedStatus;
    const finalPage = overrides.page !== undefined ? overrides.page : page;
    if (finalSource) params.set("source", finalSource);
    if (finalStatus) params.set("status", finalStatus);
    if (finalPage && finalPage > 1) params.set("page", String(finalPage));
    const qs = params.toString();
    return `/account/historial${qs ? "?" + qs : ""}`;
  }

  return (
    <>
      <Nav authed />
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <nav aria-label="Ruta de navegación" className="text-xs text-[color:var(--color-ink-muted)]">
          <Link href="/account" className="hover:text-[color:var(--color-ink)]">
            Mi cuenta
          </Link>{" "}
          / Historial
        </nav>

        <header className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)]">
              Historial de postulaciones
            </h1>
            <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
              Sincronizado automáticamente desde la extensión cuando das clic en{" "}
              <strong>Finalizar</strong> en cada vacante.
            </p>
          </div>
          <Link
            href="/account"
            className="text-sm font-medium text-[color:var(--color-brand-600)] hover:underline"
          >
            ← Volver a Mi cuenta
          </Link>
        </header>

        {/* Stats row — total, mes, semana, top portal */}
        <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total" value={stats.totalAll.toLocaleString("es-MX")} sub="postulaciones" />
          <StatCard label="Este mes" value={stats.totalMonth.toLocaleString("es-MX")} sub="postulaciones" />
          <StatCard label="Esta semana" value={stats.totalWeek.toLocaleString("es-MX")} sub="postulaciones" />
          <StatCard
            label="Top portal"
            value={topSourceLabel(stats.bySource)}
            sub={topSourceCount(stats.bySource) + " postulaciones"}
          />
        </section>

        {/* Filters */}
        <section className="mt-8 flex flex-wrap items-center gap-2 rounded-[14px] border border-[color:var(--color-border)] bg-white p-3 shadow-[var(--shadow-soft)]">
          <span className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-ink-muted)] mr-1">
            Filtrar
          </span>

          {/* Portal filter */}
          <FilterChip
            href={buildHref({ source: "", page: 1 })}
            active={!selectedSource}
            label="Todos los portales"
          />
          {SOURCES.map((src) => (
            <FilterChip
              key={src.id}
              href={buildHref({ source: src.id, page: 1 })}
              active={selectedSource === src.id}
              label={src.label}
              count={stats.bySource[src.id] || 0}
            />
          ))}

          {/* Divider */}
          <span className="mx-2 h-5 w-px bg-[color:var(--color-border)]" aria-hidden />

          {/* Status filter */}
          <FilterChip
            href={buildHref({ status: "", page: 1 })}
            active={!selectedStatus}
            label="Todos los estados"
          />
          {STATUSES.map((st) => (
            <FilterChip
              key={st.id}
              href={buildHref({ status: st.id, page: 1 })}
              active={selectedStatus === st.id}
              label={st.label}
            />
          ))}
        </section>

        {/* Table */}
        <section className="mt-6 overflow-hidden rounded-[16px] border border-[color:var(--color-border)] bg-white shadow-[var(--shadow-soft)]">
          {applications.length === 0 ? (
            <EmptyState user={user.email} />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-[color:var(--color-surface-soft)] text-xs uppercase tracking-wider text-[color:var(--color-ink-muted)]">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">Vacante</th>
                    <th className="px-4 py-3 text-left font-semibold">Empresa</th>
                    <th className="px-4 py-3 text-left font-semibold">Portal</th>
                    <th className="px-4 py-3 text-left font-semibold">Match</th>
                    <th className="px-4 py-3 text-left font-semibold">Estado</th>
                    <th className="px-4 py-3 text-left font-semibold">Fecha</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--color-border)]">
                  {applications.map((app) => (
                    <tr key={app.id} className="hover:bg-[color:var(--color-surface-soft)]">
                      <td className="px-4 py-3 align-top">
                        {app.url ? (
                          <a
                            href={app.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-[color:var(--color-ink)] hover:text-[color:var(--color-brand-600)] hover:underline"
                          >
                            {app.title || "(sin título)"}
                          </a>
                        ) : (
                          <span className="font-medium text-[color:var(--color-ink)]">
                            {app.title || "(sin título)"}
                          </span>
                        )}
                        {app.location && (
                          <div className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">
                            {app.location}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top text-[color:var(--color-ink-soft)]">
                        {app.company || "—"}
                      </td>
                      <td className="px-4 py-3 align-top text-[color:var(--color-ink-soft)]">
                        {sourceLabel(app.source)}
                      </td>
                      <td className="px-4 py-3 align-top font-medium text-[color:var(--color-ink)]">
                        {app.matchScore > 0 ? `${app.matchScore}%` : "—"}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone(
                            app.status
                          )}`}
                        >
                          {statusLabel(app.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-top text-[color:var(--color-ink-soft)]">
                        {formatDate(app.appliedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Pagination */}
        {totalPages > 1 && (
          <nav
            className="mt-6 flex items-center justify-between text-sm"
            aria-label="Paginación"
          >
            <div className="text-[color:var(--color-ink-muted)]">
              Página {page} de {totalPages} · {total} postulaciones
            </div>
            <div className="flex gap-2">
              {page > 1 && (
                <Link
                  href={buildHref({ page: page - 1 })}
                  className="rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-1.5 font-medium text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
                >
                  ← Anterior
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={buildHref({ page: page + 1 })}
                  className="rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-1.5 font-medium text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
                >
                  Siguiente →
                </Link>
              )}
            </div>
          </nav>
        )}

        <p className="mt-8 text-xs text-[color:var(--color-ink-muted)]">
          Tu historial se actualiza automáticamente. Si una vacante no aparece,
          asegúrate de haberle dado clic a <strong>Finalizar</strong> con la
          extensión instalada y la sesión iniciada.
        </p>
      </main>
      <Footer />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-[14px] border border-[color:var(--color-border)] bg-white p-4 shadow-[var(--shadow-soft)]">
      <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-ink-muted)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-[color:var(--color-ink)]">
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">
          {sub}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
}) {
  const base =
    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition";
  const inactive =
    "border-[color:var(--color-border)] bg-white text-[color:var(--color-ink-soft)] hover:border-[color:var(--color-brand-400)] hover:text-[color:var(--color-ink)]";
  const activeCls =
    "border-[color:var(--color-brand-500)] bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)]";
  return (
    <Link href={href} className={`${base} ${active ? activeCls : inactive}`}>
      <span>{label}</span>
      {count !== undefined && count > 0 && (
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
            active
              ? "bg-[color:var(--color-brand-200)] text-[color:var(--color-brand-800)]"
              : "bg-[color:var(--color-surface-soft)] text-[color:var(--color-ink-muted)]"
          }`}
        >
          {count}
        </span>
      )}
    </Link>
  );
}

function EmptyState({ user }: { user: string }) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--color-brand-50)] text-2xl">
        📋
      </div>
      <h3 className="text-lg font-semibold text-[color:var(--color-ink)]">
        Todavía no hay postulaciones
      </h3>
      <p className="mt-1 text-sm text-[color:var(--color-ink-soft)]">
        Tu historial aparecerá aquí automáticamente cuando uses la extensión y
        des clic en <strong>Finalizar</strong> en cualquier vacante.
      </p>
      <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
        Cuenta: {user}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <a
          href="https://lapieza.io/vacantes"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-[12px] bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-semibold text-white shadow-[var(--shadow-brand)] hover:bg-[color:var(--color-brand-700)]"
        >
          Abrir LaPieza →
        </a>
        <a
          href="https://www.occ.com.mx/empleos"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-[12px] border border-[color:var(--color-border)] bg-white px-4 py-2 text-sm font-semibold text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
        >
          Abrir OCC →
        </a>
      </div>
    </div>
  );
}

function topSourceLabel(bySource: Record<ApplicationSource, number>): string {
  let topId: ApplicationSource = "lapieza";
  let topCount = -1;
  (Object.entries(bySource) as [ApplicationSource, number][]).forEach(
    ([id, n]) => {
      if (n > topCount) {
        topCount = n;
        topId = id;
      }
    }
  );
  return topCount > 0 ? sourceLabel(topId) : "—";
}

function topSourceCount(bySource: Record<ApplicationSource, number>): string {
  let topCount = 0;
  Object.values(bySource).forEach((n) => {
    if (n > topCount) topCount = n;
  });
  return topCount.toLocaleString("es-MX");
}
