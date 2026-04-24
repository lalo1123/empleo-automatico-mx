// /v1/billing/* - Conekta subscription creation and cancellation.
//
// Flow:
//   1. Ensure the user has a Conekta customer id (create on first checkout).
//   2. Create a hosted Checkout PaymentLink referencing the plan_id.
//   3. Insert a `subscriptions` row in status=pending.
//   4. Return the hosted checkout URL to the client.
//
// Webhooks finalize state: `subscription.created` lifts status to active,
// `subscription.paid` extends current_period_end, `subscription.payment_failed`
// marks past_due -> paused, `subscription.canceled` / `.expired` downgrade.

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AppContext } from "../lib/env.js";
import { loadEnv } from "../lib/env.js";
import { HttpError, sendError } from "../lib/errors.js";
import { authRequired } from "../middleware/auth.js";
import {
  cancelCustomerSubscription,
  createCustomer,
  createSubscriptionCheckout
} from "../lib/conekta.js";
import {
  createSubscription,
  findActiveSubscription,
  findUserById,
  setConektaCustomerId,
  updateSubscription
} from "../lib/db.js";
import { getConektaPlanId, getPrice, PLANS } from "../lib/plans.js";

const checkoutSchema = z.object({
  plan: z.enum(["pro", "premium"]),
  interval: z.enum(["monthly", "yearly"])
});

export const billingRoutes = new Hono<AppContext>();

billingRoutes.post("/checkout", authRequired(), async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = checkoutSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Plan o intervalo invalido"
      );
    }

    const { plan, interval } = parsed.data;
    const env = loadEnv();
    const user = c.get("user");

    const price = getPrice(plan, interval);
    if (!price) {
      throw new HttpError(400, "VALIDATION_ERROR", "Plan no disponible.");
    }

    const planId = getConektaPlanId(env, plan, interval);
    if (!planId) {
      console.error(`[billing] missing conekta plan id for ${plan} ${interval}`);
      throw new HttpError(
        500,
        "INTERNAL_ERROR",
        "Configuracion de planes incompleta. Contacta a soporte."
      );
    }

    // Reuse an existing Conekta customer where possible to keep a single
    // customer record across checkouts.
    const userRow = findUserById(user.id);
    if (!userRow) {
      throw new HttpError(401, "UNAUTHORIZED", "Usuario no encontrado.");
    }

    let customerId = userRow.conekta_customer_id;
    if (!customerId) {
      const customer = await createCustomer({
        apiKey: env.CONEKTA_API_KEY,
        name: userRow.name ?? user.email,
        email: user.email
      });
      customerId = customer.id;
      setConektaCustomerId(user.id, customerId);
    }

    const subscriptionId = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const orderName = `Empleo Automatico ${PLANS[plan].name} (${interval === "monthly" ? "mensual" : "anual"})`;

    const checkout = await createSubscriptionCheckout({
      apiKey: env.CONEKTA_API_KEY,
      planId,
      customerId,
      customerName: userRow.name ?? user.email,
      customerEmail: user.email,
      name: orderName,
      redirectUrl: env.FRONTEND_BACK_URL
    });

    // We don't yet know the subscription id from Conekta; the webhook
    // `subscription.created` will attach it. Until then we store the internal
    // id only.
    createSubscription({
      id: subscriptionId,
      userId: user.id,
      conektaSubscriptionId: null,
      plan,
      interval,
      status: "pending",
      now
    });

    console.log(
      `[billing] checkout user=${user.id} plan=${plan} interval=${interval} sub=${subscriptionId} checkout=${checkout.id}`
    );
    return c.json({ ok: true, checkoutUrl: checkout.url });
  } catch (err) {
    return sendError(c, err);
  }
});

billingRoutes.post("/cancel", authRequired(), async (c) => {
  try {
    const env = loadEnv();
    const user = c.get("user");
    const sub = findActiveSubscription(user.id);
    if (!sub) {
      throw new HttpError(404, "NOT_FOUND", "No tienes una suscripcion activa.");
    }

    // Flag locally first so we don't keep retrying Conekta on failure loops.
    updateSubscription({
      id: sub.id,
      status: sub.status,
      currentPeriodEnd: sub.current_period_end,
      willCancelAtPeriodEnd: 1
    });

    // Tell Conekta to cancel. Cancellation is at the customer level because
    // Conekta customers carry a single subscription record.
    const userRow = findUserById(user.id);
    if (userRow?.conekta_customer_id) {
      await cancelCustomerSubscription({
        apiKey: env.CONEKTA_API_KEY,
        customerId: userRow.conekta_customer_id
      });
    }

    console.log(`[billing] cancel user=${user.id} sub=${sub.id}`);
    return c.json({
      ok: true,
      status: "will_cancel_at_period_end",
      effectiveAt: sub.current_period_end
    });
  } catch (err) {
    return sendError(c, err);
  }
});
