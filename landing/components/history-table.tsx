"use client";

import { useState } from "react";
import type {
  Application,
  ApplicationSource,
  ApplicationStatus,
} from "@/lib/api";
import { ApplicationTimelineDrawer } from "./application-timeline-drawer";

const SOURCE_LABELS: Record<ApplicationSource, string> = {
  lapieza: "LaPieza",
  occ: "OCC",
  computrabajo: "Computrabajo",
  bumeran: "Bumeran",
  indeed: "Indeed",
  linkedin: "LinkedIn",
};

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  applied: "Postulado",
  viewed: "Visto",
  rejected: "Rechazado",
  hired: "Contratado",
};

function formatDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
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

export function HistoryTable({
  applications,
}: {
  applications: Application[];
}) {
  const [selected, setSelected] = useState<Application | null>(null);

  return (
    <>
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
              <th className="px-4 py-3 text-right font-semibold">Detalle</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-border)]">
            {applications.map((app) => (
              <tr
                key={app.id}
                className="cursor-pointer transition hover:bg-[color:var(--color-surface-soft)]"
                onClick={() => setSelected(app)}
              >
                <td className="px-4 py-3 align-top">
                  <span className="font-medium text-[color:var(--color-ink)]">
                    {app.title || "(sin título)"}
                  </span>
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
                  {SOURCE_LABELS[app.source]}
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
                    {STATUS_LABELS[app.status]}
                  </span>
                </td>
                <td className="px-4 py-3 align-top text-[color:var(--color-ink-soft)]">
                  {formatDate(app.appliedAt)}
                </td>
                <td className="px-4 py-3 align-top text-right">
                  <span
                    className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--color-brand-600)]"
                    aria-hidden
                  >
                    Ver →
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ApplicationTimelineDrawer
        app={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
