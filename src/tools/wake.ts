import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { unwrap } from "../env.js";
import { ParentNotifyStore, WakeSubscriptionError } from "../parent-notify-store.js";
import { getSettingsPaths, loadSettings } from "../settings.js";

/** Explicit authorization only; spawn, send and unread never create subscriptions. */
export function registerWakeTools(pi: ExtensionAPI): void {
 pi.registerTool({
  name: "herdr_wake_subscription",
  label: "Manage explicit wake subscription",
  description: "Create a one-shot wake authorization for explicit agentId, runId or eventId values in this receiver session; every supplied scope field must match. Authorization expires within the requested TTL (maximum 1 hour) and can be revoked by id. Only notifications=normal permits subscriptions; quiet and none remain non-waking and cannot be overridden. Spawn, send and unread never create authorization.",
  promptSnippet: "Manage explicit, scoped, one-shot wake authorization for a completion",
  promptGuidelines: ["Use herdr_wake_subscription only when explicitly authorizing a matching completion to wake this receiver; choose a narrow agentId, runId or eventId scope and short TTL, revoke by id when no longer needed, and never assume it overrides quiet/none."],
  parameters: Type.Object({
   action: Type.Union([Type.Literal("subscribe"), Type.Literal("revoke"), Type.Literal("list")]),
   scope: Type.Optional(Type.Object({
    agentId: Type.Optional(Type.String({ minLength: 1 })),
    runId: Type.Optional(Type.String({ minLength: 1 })),
    eventId: Type.Optional(Type.String({ minLength: 1 })),
   }, { additionalProperties: false })),
   ttl_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
   id: Type.Optional(Type.String({ minLength: 1 })),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
   try {
    const hostFile = ctx.sessionManager.getSessionFile();
    if (!hostFile) throw new WakeSubscriptionError("invalid-argument", "receiver host session file unavailable");
    const store = new ParentNotifyStore(hostFile);
    const notifications = loadSettings(getSettingsPaths(ctx.cwd)).effective.notifications;
    let details: Record<string, unknown>;
    switch (params.action) {
     case "subscribe":
      if (!params.scope || params.ttl_ms === undefined) throw new WakeSubscriptionError("invalid-argument", "subscribe requires scope and ttl_ms");
      details = { subscription: store.subscribe(params.scope, params.ttl_ms, notifications) };
      break;
     case "revoke":
      if (!params.id?.trim()) throw new WakeSubscriptionError("invalid-argument", "revoke requires id");
      details = { id: params.id, revoked: store.revoke(params.id) };
      break;
     case "list": details = { subscriptions: store.listSubscriptions() }; break;
     default: throw new WakeSubscriptionError("invalid-argument", "unknown wake subscription action");
    }
    return { content: [{ type: "text", text: JSON.stringify(details) }], details };
   } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = error instanceof WakeSubscriptionError
     ? error.code === "policy-conflict" ? "notification-policy" : "invalid-argument"
     : "persistence-error";
    const policy = reason === "notification-policy" ? /notifications=(normal|quiet|none)/.exec(message)?.[1] : undefined;
    return unwrap({ ok: false, error: {
     code: "VALIDATION_ERROR",
     message,
     details: { reason, ...(policy ? { notifications: policy } : {}) },
    } });
   }
  },
 });
}
