import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ParentNotifyStore, WakeSubscriptionError } from "../parent-notify-store.js";
import { getSettingsPaths, loadSettings } from "../settings.js";

/** Explicit authorization only; spawn, send and unread never create subscriptions. */
export function registerWakeTools(pi: ExtensionAPI): void {
 pi.registerTool({
  name: "herdr_wake_subscription",
  label: "Manage explicit wake subscription",
  description: "Subscribe once to a completion matching explicit agentId, runId or eventId in this receiver session; all supplied fields must match. TTL is at most 1 hour. quiet/none notifications cannot be overridden. Revoke by id or list active subscriptions. Does not spawn, send, or mark pending messages read.",
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
    const failure = { code: error instanceof WakeSubscriptionError ? error.code : "persistence-error", message: error instanceof Error ? error.message : String(error) };
    return { content: [{ type: "text", text: `Error (${failure.code}): ${failure.message}` }], details: { error: failure }, isError: true };
   }
  },
 });
}
