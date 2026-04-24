// Liveness probe for Dokploy / Traefik / uptime monitors.
// Intentionally trivial: we don't touch the DB or the backend here — this
// endpoint only asserts that the Next.js process is accepting requests.
// For a deeper check, expose a separate `/api/readyz` that pings the API.

import { NextResponse } from "next/server";

// Always render fresh; never cache the probe.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  return NextResponse.json(
    { ok: true, service: "landing", ts: Date.now() },
    { status: 200 },
  );
}
