import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SteeredMessage } from "./push.js";
import type { HerdrSettings } from "./settings.js";

export interface WakeScope { agentId?: string; runId?: string; eventId?: string }
export interface WakeSubscription {
 id: string;
 scope: WakeScope;
 expiresAt: number;
 oneShot: true;
}
export class WakeSubscriptionError extends Error {
 constructor(readonly code: "policy-conflict" | "invalid-argument", message: string) { super(message); }
}
const scopeKeys = ["agentId", "runId", "eventId"] as const;
function validateScope(scope: WakeScope): void {
 if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).some(key => !scopeKeys.includes(key as typeof scopeKeys[number])) ||
  !scopeKeys.some(key => typeof scope[key] === "string" && scope[key]!.trim()) ||
  scopeKeys.some(key => scope[key] !== undefined && (typeof scope[key] !== "string" || !scope[key]!.trim() || /[*?]/.test(scope[key]!)))) {
  throw new WakeSubscriptionError("invalid-argument", "scope requires explicit agentId, runId or eventId; names and wildcards are not supported");
 }
}

interface StoreData {
 version: 1;
 hostFile: string;
 messages: { key: string; message: SteeredMessage }[];
 subscriptions: WakeSubscription[];
}
export const parentNotifyPath = (hostFile: string): string => `${hostFile}.herdr-parent-notify.json`;

function canonical(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
 if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
 return JSON.stringify(value) ?? "null";
}
export function pendingMessageKey(msg: SteeredMessage): string {
 const eventId = msg.details.eventId;
 const noticeId = msg.details.noticeId;
 if (typeof noticeId === 'string' && noticeId.trim()) return `notice:${noticeId}`;
 return typeof eventId === "string" && eventId.trim()
  ? `event:${eventId}`
  : messageContentKey(msg);
}

function messageContentKey(msg: SteeredMessage): string {
 try { return `message:${createHash('sha256').update(canonical(JSON.parse(JSON.stringify(msg)))).digest('hex')}`; }
 catch (error) { throw new Error('parent notification must be JSON serializable', { cause: error }); }
}

/** Receiver-session outbox; every operation reloads disk so restart never loses ownership. */
export class ParentNotifyStore {
 constructor(readonly hostFile: string, private readonly options: { now?: () => number } = {}) {
  if (!hostFile.trim()) throw new Error("receiver session file required");
 }
 private load(): StoreData {
  try {
   const data = JSON.parse(readFileSync(parentNotifyPath(this.hostFile), "utf8"));
   if (data.version !== 1 || data.hostFile !== this.hostFile || !Array.isArray(data.messages) || !Array.isArray(data.subscriptions)) throw new Error("invalid parent notify store");
   for (const row of data.messages) {
    const msg = row?.message;
    if (typeof row?.key !== "string" || !msg || typeof msg.content !== "string" || !msg.details || typeof msg.details !== "object" || Array.isArray(msg.details) || typeof msg.wake !== "boolean" || (msg.deliverAs !== undefined && !["steer", "followUp", "nextTurn"].includes(msg.deliverAs)) || row.key !== pendingMessageKey(msg)) throw new Error("invalid pending message");
   }
   if (new Set(data.messages.map((row: { key: string }) => row.key)).size !== data.messages.length || new Set(data.subscriptions.map((subscription: WakeSubscription) => subscription.id)).size !== data.subscriptions.length) throw new Error("duplicate parent notify store identity");
   for (const subscription of data.subscriptions) {
    validateScope(subscription?.scope);
    if (typeof subscription.id !== "string" || !subscription.id || subscription.oneShot !== true || !Number.isFinite(subscription.expiresAt)) throw new Error("invalid wake subscription");
   }
   return data;
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, hostFile: this.hostFile, messages: [], subscriptions: [] };
   throw error;
  }
 }
 private save(data: StoreData): void {
  const path = parentNotifyPath(this.hostFile);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
   fd = openSync(temporary, "wx", 0o600);
   writeFileSync(fd, JSON.stringify(data));
   fsyncSync(fd);
   closeSync(fd); fd = undefined;
   renameSync(temporary, path);
   fd = openSync(dirname(path), "r");
   fsyncSync(fd);
  } finally {
   if (fd !== undefined) closeSync(fd);
   try { unlinkSync(temporary); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
   }
  }
 }
 put(msg: SteeredMessage): string {
  const key = pendingMessageKey(msg);
  const data = this.load();
  if (!data.messages.some(row => row.key === key)) {
   data.messages.push({ key, message: msg });
   this.save(data);
  }
  return key;
 }
 pending(): SteeredMessage[] { return this.load().messages.map(row => row.message); }
 remove(key: string): boolean {
  const data = this.load();
  const index = data.messages.findIndex(row => row.key === key);
  if (index < 0) return false;
  data.messages.splice(index, 1); this.save(data); return true;
 }
 subscribe(scope: WakeScope, ttlMs: number, notifications: HerdrSettings["notifications"]): WakeSubscription {
  if (notifications !== "normal") throw new WakeSubscriptionError("policy-conflict", `notifications=${notifications}: explicit wake cannot override policy`);
  validateScope(scope);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 3_600_000) throw new WakeSubscriptionError("invalid-argument", "ttl_ms must be an integer between 1 and 3600000 (1h)");
  const subscription: WakeSubscription = { id: randomUUID(), scope: { ...scope }, expiresAt: (this.options.now ?? Date.now)() + ttlMs, oneShot: true };
  const data = this.load();
  data.subscriptions.push(subscription); this.save(data); return subscription;
 }
 revoke(id: string): boolean {
  const data = this.load();
  const index = data.subscriptions.findIndex(subscription => subscription.id === id);
  if (index < 0) return false;
  data.subscriptions.splice(index, 1); this.save(data); return true;
 }
 listSubscriptions(): WakeSubscription[] {
  const now = (this.options.now ?? Date.now)();
  return this.load().subscriptions.filter(subscription => subscription.expiresAt > now);
 }
 matching(details: Record<string, unknown>, notifications: HerdrSettings["notifications"]): WakeSubscription[] {
  const subscriptions = this.listSubscriptions();
  if (notifications !== "normal") return [];
  return subscriptions.filter(subscription => scopeKeys.every(key => subscription.scope[key] === undefined || details[key] === subscription.scope[key]));
 }
 consume(id: string): boolean { return this.revoke(id); }
 unread(details: { agentId?: string; name?: string }): number {
  return this.pending().filter(msg =>
   (!details.agentId || msg.details.agentId === details.agentId) &&
   (!details.name || msg.details.name === details.name)).length;
 }
}
