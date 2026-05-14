// Plan catalog — kept in sync with backend/src/lib/plans.ts.
// If this file diverges from the backend, UI will show wrong limits/prices.
// Single source of truth for API/pricing: COMMERCIAL.md.

export type PlanId = "free" | "pro" | "premium";
export type BillingInterval = "monthly" | "yearly";

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthlyMxn: number;
  priceYearlyMxn: number;
  applicationsPerMonth: number | "unlimited";
  tagline: string;
  features: string[];
  cta: string;
  popular?: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Gratis",
    priceMonthlyMxn: 0,
    priceYearlyMxn: 0,
    applicationsPerMonth: 3,
    tagline: "Pruébalo sin tarjeta",
    cta: "Empieza gratis",
    features: [
      "3 postulaciones al mes",
      "Cartas generadas con IA",
      "6 portales: OCC, Computrabajo, Bumeran, LaPieza, Indeed, LinkedIn",
      "Soporte por email",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthlyMxn: 299,
    priceYearlyMxn: 2990,
    applicationsPerMonth: 100,
    tagline: "Para búsqueda activa",
    cta: "Contratar Pro",
    popular: true,
    features: [
      "100 postulaciones al mes",
      "Cartas personalizadas + CV optimizado por vacante",
      "Auto-quiz multiple choice",
      "6 portales: OCC, Computrabajo, Bumeran, LaPieza, Indeed, LinkedIn",
      "Historial de postulaciones",
      "Soporte prioritario",
    ],
  },
  premium: {
    id: "premium",
    name: "Premium",
    priceMonthlyMxn: 499,
    priceYearlyMxn: 4990,
    applicationsPerMonth: "unlimited",
    tagline: "Búsqueda intensiva",
    cta: "Contratar Premium",
    features: [
      "Hasta 30 postulaciones al día (protege tu cuenta en los portales)",
      "Cartas personalizadas + CV optimizado por vacante",
      "Auto-quiz multiple choice",
      "6 portales con prioridad y nuevas integraciones",
      "Historial de postulaciones",
      "Soporte prioritario 24h",
      "Acceso anticipado a nuevas funciones",
    ],
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "pro", "premium"];

export function formatMxn(amount: number): string {
  return `$${amount.toLocaleString("es-MX")} MXN`;
}

export function limitLabel(plan: Plan): string {
  return plan.applicationsPerMonth === "unlimited"
    ? "Ilimitado"
    : `${plan.applicationsPerMonth} / mes`;
}
