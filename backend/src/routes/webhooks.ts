// /v1/webhooks/conekta - signed notification receiver.
// Idempotent via webhook_events.id. Handles subscription lifecycle.
//
// Signature scheme (per Conekta docs):
//   Header `Digest: SHA1=<hex>` where <hex> = HMAC-SHA1(raw_body, CONEKTA_WEBHOOK_KEY).
// Body JSON shape (summarised, v2 Events API):
//   {
//     "id": "evt_...",
//     "type": "subscription.paid",
//     "data": { "object": { "id": "sub_...", "status": "active",
//                           "billing_cycle_end": 1234567890, "customer_id": "cus_...",
//                           ... } }
//   }

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AppContext } from "../lib/env.js";
import { loadEnv } from "../lib/env.js";
import { errorResponse, sendError } from "../lib/errors.js";
import {
  findActiveSubscription,
  findSubscriptionByConektaId,
  findUserByConektaCustomerId,
  markWebhookProcessed,
  recordWebhookEvent,
  updateSubscription,
  updateUserPlan
} from "../lib/db.js";
import { verifyWebhookSignature } from "../lib/conekta.js";
import type { SubscriptionStatus } from "../types.js";

export const webhookRoutes = new Hono<AppContext>();

interface ConektaEvent {
  id?: string;
  type?: string;
  data?: {
    object?: {
      id?: string;
      status?: string;
      customer_id?: string;
      billing_cycle_end?: number;
      billing_cycle_start?: number;
      plan_id?: string;
    };
  };
}

function mapConektaStatus(s: string | undefined, eventType: string): SubscriptionStatus {
  // Explicit event-type mapping is more reliable than the `status` field for
  // terminal events.
  if (eventType === "subscription.canceled") return "cancelled";
  if (eventType === "subscription.expired") return "expired";
  if (eventType === "subscription.payment_failed") return "paused";
  switch (s) {
    case "active":
    case "in_trial":
      return "active";
    case "paused":
    case "past_due":
      return "paused";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "pending":
    case "unpaid":
      return "pending";
    default:
      return "pending";
  }
}

/**
 * Finds the subscription row in our DB that this Conekta event refers to.
 * Prefer matching by conekta_subscription_id; fall back to the user's most
 * recent pending subscription if we are seeing this subscription id for the
 * first time (subscription.created).
 */
function locateSubscription(
  conektaSubscriptionId: string,
  conektaCustomerId: string | undefined
): { subId: string; userId: string } | null {
  const existing = findSubscriptionByConektaId(conektaSubscriptionId);
  if (existing) return { subId: existing.id, userId: existing.user_id };

  if (!conektaCustomerId) return null;
  const user = findUserByConektaCustomerId(conektaCustomerId);
  if (!user) return null;
  const active = findActiveSubscription(user.id);
  if (!active) return null;
  return { subId: active.id, userId: user.id };
}

webhookRoutes.post("/conekta", async (c) => {
  try {
    const env = loadEnv();
    const rawBody = await c.req.text();

    // Verify signature BEFORE parsing. Conekta signs the raw body.
    const digest = c.req.header("digest") ?? c.req.header("Digest") ?? null;
    const valid = verifyWebhookSignature({
      digestHeader: digest,
      rawBody,
      webhookKey: env.CONEKTA_WEBHOOK_KEY
    });
    if (!valid) {
      console.warn("[webhook] invalid conekta signature", {
        hasDigest: Boolean(digest),
        len: rawBody.length
      });
      return errorResponse(c, 401, "WEBHOOK_SIGNATURE_INVALID", "Firma invalida.");
    }

    let event: ConektaEvent = {};
    try {
      event = JSON.parse(rawBody) as ConektaEvent;
    } catch {
      return errorResponse(c, 400, "VALIDATION_ERROR", "Payload invalido.");
    }

    const eventType = event.type ?? "";
    const eventId = event.id ?? randomUUID();
    const obj = event.data?.object ?? {};
    const conektaSubId = obj.id;

    const now = Math.floor(Date.now() / 1000);
    const inserted = recordWebhookEvent({
      id: eventId,
      source: "conekta",
      eventType,
      payload: rawBody,
      now
    });
    if (!inserted) {
      // Duplicate - ack with 200 so Conekta stops retrying.
      return c.json({ ok: true, duplicate: true });
    }

    // Only process subscription.* events. Other events are recorded but
    // don't mutate state.
    if (
      conektaSubId &&
      (eventType === "subscription.created" ||
        eventType === "subscription.paid" ||
        eventType === "subscription.payment_failed" ||
        eventType === "subscription.canceled" ||
        eventType === "subscription.expired")
    ) {
      const located = locateSubscription(conektaSubId, obj.customer_id);
      if (!located) {
        console.warn(
          `[webhook] no subscription matched conekta_id=${conektaSubId} customer=${obj.customer_id ?? "?"} event=${eventType}`
        );
        markWebhookProcessed(eventId);
        return c.json({ ok: true, ignored: true });
      }

      const newStatus = mapConektaStatus(obj.status, eventType);
      const periodEnd = typeof obj.billing_cycle_end === "number"
        ? obj.billing_cycle_end
        : null;

      const existing = findSubscriptionByConektaId(conektaSubId);
      const willCancel = existing?.will_cancel_at_period_end ?? 0;

      updateSubscription({
        id: located.subId,
        status: newStatus,
        currentPeriodEnd: periodEnd,
        willCancelAtPeriodEnd: willCancel,
        conektaSubscriptionId: conektaSubId
      });

      // Reflect plan on the user row based on event.
      if (eventType === "subscription.created" || eventType === "subscription.paid") {
        const subRow = findSubscriptionByConektaId(conektaSubId);
        if (subRow) {
          updateUserPlan(subRow.user_id, subRow.plan, periodEnd);
        }
      } else if (
        eventType === "subscription.canceled" ||
        eventType === "subscription.expired"
      ) {
        const subRow = findSubscriptionByConektaId(conektaSubId);
        if (subRow) {
          // Keep the paid access until period end; otherwise downgrade immediately.
          if (periodEnd && periodEnd > now) {
            updateUserPlan(subRow.user_id, subRow.plan, periodEnd);
          } else {
            updateUserPlan(subRow.user_id, "free", null);
          }
        }
      } else if (eventType === "subscription.payment_failed") {
        // Keep access until period end, but flag paused. No user downgrade yet.
      }
    }

    markWebhookProcessed(eventId);
    return c.json({ ok: true });
  } catch (err) {
    return sendError(c, err);
  }
});
