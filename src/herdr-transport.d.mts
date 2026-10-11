import type { HerdrErrorCode, Result } from "./env.js";

export const MIN_HERDR_VERSION: Readonly<{ major: number; minor: number; patch: number }>;
export const HERDR_UPGRADE_POINTER: string;
export function resolveHerdrBin(): string;
export function ensureHerdrVersion(bin: string): Promise<Result<{ major: number; minor: number; patch: number }>>;

export interface HerdrTransportOptions {
 timeoutMs?: number;
 signal?: AbortSignal;
 textOk?: boolean;
}

export function runHerdrCommand<T = unknown>(
 bin: string,
 args: string[],
 options?: HerdrTransportOptions,
): Promise<Result<T>>;
