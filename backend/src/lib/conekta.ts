// Conekta REST client (no SDK). Auth is Basic: base64("<api_key>:") per Conekta docs.
// Docs: https://developers.conekta.com/reference/subscriptions
//
// Flow for the MVP:
//   1. First checkout: POST /customers (or reuse stored conekta_customer_id).
//   2. Create a Checkout (PaymentLink with type=Subscription) that references
//      the plan_id. Conekta hosts the card form at the returned url.
//   3. Webhooks update subscription status on our side.
//
// NOTE: the exact Checkout endpoint has been named both "Checkout" and
// "Orders with checkout" in Conekta's docs over time. We use POST /checkouts
// which is the stable public endpoint today (2025+).

import { createPublicKey, createVerify } from "node:crypto";
import { HttpError } from "./errors.js";

const CONEKTA_BASE = "https://api.conekta.io";

// Conekta requires a versioned Accept header. Newest stable public version.
const ACCEPT_HEADER = "application/vnd.conekta-v2.1.0+json";

function authHeader(apiKey: string): string {
  const encoded = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

async function conektaFetch<T>(
  apiKey: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${CONEKTA_BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
      Accept: ACCEPT_HEADER,
      "Accept-Language": "es"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    // Drain body but do not surface raw Conekta errors — they can include
    // request echoes that leak PII or API keys.
    let upstreamDetail = "";
    try {
      upstreamDetail = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    console.error(
      `[conekta] ${method} ${path} failed status=${res.status} detail=${upstreamDetail}`
    );
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(
        500,
        "INTERNAL_ERROR",
        "Error de configuracion del servicio de pagos."
      );
    }
    throw new HttpError(
      502,
      "PAYMENT_ERROR",
      "No pudimos completar la solicitud con el procesador de pagos. Intenta de nuevo."
    );
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new HttpError(502, "PAYMENT_ERROR", "Respuesta invalida del procesador de pagos.");
  }
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface ConektaCustomer {
  id: string;
  name?: string;
  email?: string;
  subscription?: ConektaSubscription | null;
}

/**
 * Conekta rejects names with digits or special chars (only letters, spaces,
 * accents, hyphens, apostrophes are allowed).
 */
function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-ZáéíóúüÁÉÍÓÚÜñÑ\s'-]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned.length >= 2 ? cleaned : "Cliente";
}

export async function createCustomer(args: {
  apiKey: string;
  name: string;
  email: string;
}): Promise<ConektaCustomer> {
  return conektaFetch<ConektaCustomer>(args.apiKey, "POST", "/customers", {
    name: sanitizeName(args.name),
    email: args.email
  });
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface ConektaSubscription {
  id: string;
  status?: string;            // 'in_trial' | 'active' | 'past_due' | 'paused' | 'canceled'
  plan_id?: string;
  billing_cycle_start?: number;
  billing_cycle_end?: number;
  customer_id?: string;
}

export async function cancelCustomerSubscription(args: {
  apiKey: string;
  customerId: string;
}): Promise<void> {
  await conektaFetch<ConektaSubscription>(
    args.apiKey,
    "POST",
    `/customers/${encodeURIComponent(args.customerId)}/subscription/cancel`
  );
}

// ---------------------------------------------------------------------------
// Checkouts — hosted payment link for card + OXXO + SPEI.
// For recurring subscriptions we create a Checkout of type "PaymentLink"
// and attach the plan_id so Conekta enrolls the card into the subscription
// automatically on success.
// ---------------------------------------------------------------------------

export interface ConektaCheckout {
  id: string;
  url: string;
  name?: string;
  type?: string;
  status?: string;
}

export async function createSubscriptionCheckout(args: {
  apiKey: string;
  planId: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  name: string;              // human-readable order name
  unitPriceCentavos: number; // MXN price * 100
  redirectUrl: string;       // user is sent here after a successful payment
}): Promise<ConektaCheckout> {
  // Conekta "Checkout" PaymentLink with subscription plan (v2.1 schema:
  // requires expires_at, payments_limit_count, and order_template wrapper).
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
  const body: Record<string, unknown> = {
    name: args.name,
    type: "PaymentLink",
    recurrent: true,
    plan_id: args.planId,
    expires_at: expiresAt,
    // Conekta requires >1 even for single-user subscription links; 100 is
    // a safe high cap (link is per-user, won't actually be shared).
    payments_limit_count: 100,
    needs_shipping_contact: false,
    allowed_payment_methods: ["card"],
    redirection_time: 5,
    on_demand_enabled: false,
    order_template: {
      currency: "MXN",
      customer_info: {
        customer_id: args.customerId,
        name: sanitizeName(args.customerName),
        email: args.customerEmail
      },
      line_items: [
        {
          name: args.name,
          unit_price: args.unitPriceCentavos,
          quantity: 1
        }
      ]
    },
    metadata: {
      success_url: args.redirectUrl,
      failure_url: args.redirectUrl
    }
  };
  return conektaFetch<ConektaCheckout>(args.apiKey, "POST", "/checkouts", body);
}

// ---------------------------------------------------------------------------
// Webhook signature verification (RSA-SHA256 via `digest` header).
// Conekta signs the raw body with their private key and exposes the matching
// public key in the dashboard. Header format: `digest: SHA256=<base64>`.
// CONEKTA_WEBHOOK_KEY now holds the PEM public key (single line is fine —
// we normalize newlines before parsing).
// ---------------------------------------------------------------------------

function normalizePublicKeyPem(raw: string): string {
  // The Conekta dashboard often returns the PEM with no newlines between the
  // header/body/footer. Node's createPublicKey accepts DER-style multilines,
  // so we re-insert the boundary newlines and split the base64 body into
  // 64-char lines per RFC 7468.
  const trimmed = raw.trim();
  const m = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/i.exec(trimmed);
  if (!m) return trimmed;
  const body = (m[1] ?? "").replace(/\s+/g, "");
  const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

export function verifyWebhookSignature(args: {
  digestHeader: string | null;
  rawBody: string;
  webhookKey: string;  // RSA public key in PEM format
}): boolean {
  const { digestHeader, rawBody, webhookKey } = args;
  if (!digestHeader || !webhookKey) return false;

  const match = /^sha256=([A-Za-z0-9+/=]+)$/i.exec(digestHeader.trim());
  if (!match) return false;
  const providedB64 = match[1];
  if (!providedB64) return false;

  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(providedB64, "base64");
  } catch {
    return false;
  }

  let publicKey;
  try {
    publicKey = createPublicKey(normalizePublicKeyPem(webhookKey));
  } catch {
    return false;
  }

  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(rawBody, "utf8");
    verifier.end();
    return verifier.verify(publicKey, providedSig);
  } catch {
    return false;
  }
}
