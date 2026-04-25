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

import { createHmac, timingSafeEqual } from "node:crypto";
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

export async function createCustomer(args: {
  apiKey: string;
  name: string;
  email: string;
}): Promise<ConektaCustomer> {
  return conektaFetch<ConektaCustomer>(args.apiKey, "POST", "/customers", {
    name: args.name,
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
    payments_limit_count: 1,
    needs_shipping_contact: false,
    allowed_payment_methods: ["card"],
    redirection_time: 5,
    on_demand_enabled: false,
    order_template: {
      currency: "MXN",
      customer_info: {
        customer_id: args.customerId,
        name: args.customerName,
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
// Webhook signature verification (HMAC-SHA1 via `Digest` header).
// Conekta sends `Digest: SHA1=<hex>` where the mac is computed on the raw body
// using the webhook signing key (CONEKTA_WEBHOOK_KEY).
// ---------------------------------------------------------------------------

export function verifyWebhookSignature(args: {
  digestHeader: string | null;
  rawBody: string;
  webhookKey: string;
}): boolean {
  const { digestHeader, rawBody, webhookKey } = args;
  if (!digestHeader || !webhookKey) return false;

  // Accept `SHA1=<hex>` (standard) or `sha1=<hex>`.
  const match = /^sha1=([0-9a-fA-F]+)$/i.exec(digestHeader.trim());
  if (!match) return false;
  const provided = match[1];
  if (!provided) return false;

  const expected = createHmac("sha1", webhookKey).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided.toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
