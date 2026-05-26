"use client";

import type { ReactNode } from "react";

/**
 * Wraps the `cancelAction` server action with a window.confirm prompt.
 * Server Components can't bind event handlers, so this client wrapper
 * is the minimum surface needed to gate the destructive cancel action
 * behind a "Are you sure?" dialog.
 */
export function CancelSubscriptionForm({
  action,
  children,
}: {
  action: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        const ok = window.confirm(
          "¿Cancelar tu suscripción? Mantienes acceso hasta el final del período actual. Después regresas al Plan Gratis."
        );
        if (!ok) e.preventDefault();
      }}
    >
      {children}
    </form>
  );
}
