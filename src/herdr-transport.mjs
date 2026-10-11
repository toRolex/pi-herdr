// 扩展与独立回收 worker 共用的原生 Node transport。
// Herdr 子进程调用、结果解析与错误归一化统一收口于此。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const MIN_HERDR_VERSION = Object.freeze({ major: 0, minor: 9, patch: 0 });
export const HERDR_UPGRADE_POINTER = 'https://herdr.dev';

export function resolveHerdrBin() {
 const override = process.env.HERDR_BIN_PATH ?? process.env.HERDR_BIN;
 if (override) return override;
 const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
 for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
  for (const extension of extensions) {
   const candidate = join(directory, extension ? `herdr${extension}` : 'herdr');
   try { if (existsSync(candidate)) return candidate; } catch {}
  }
 }
 return 'herdr';
}

function mapCode(rawCode) {
 const code = String(rawCode ?? '').toLowerCase();
 if (code === 'agent_start_failed') return 'AGENT_START_FAILED';
 if (code.includes('not_found') || code === 'no_such_agent' || code === 'no_such_pane') return 'NOT_FOUND';
 if (code.includes('gone')) return 'PANE_GONE';
 if (code.includes('timeout') || code.includes('timed_out')) return 'TIMEOUT';
 return 'VALIDATION_ERROR';
}

function parseLastJson(text) {
 const value = text.trim();
 if (!value) return null;
 try { return JSON.parse(value); } catch {}
 const lines = value.split(/\r?\n/).filter(line => line.trim());
 for (let i = lines.length - 1; i >= 0; i--) {
  try { return JSON.parse(lines[i]); } catch {}
 }
 return null;
}

const messageOf = error => error instanceof Error ? error.message : String(error);
const failure = (code, message, details) => ({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });
const isErrorEnvelope = value => value && typeof value === 'object' && (value.error || value.ok === false);

/** 执行 Herdr 命令，并将进程与 envelope 错误归一化为 Result。 */
export async function ensureHerdrVersion(bin) {
 const probe = await runHerdrCommand(bin, ['--version'], { timeoutMs: 3_000, textOk: true });
 if (!probe.ok) return probe;
 const text = typeof probe.data === 'string' ? probe.data : '';
 const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
 if (!match) return failure('HERDR_TOO_OLD', `herdr version could not be determined, and pi-herdr requires herdr >= 0.9.0 — upgrade from ${HERDR_UPGRADE_POINTER}, then restart pi (/reload).`, { state: 'unknown' });
 const version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
 if (version.major === 0 && version.minor < MIN_HERDR_VERSION.minor) {
  return failure('HERDR_TOO_OLD', `herdr ${match[0]} is too old: pi-herdr requires herdr >= 0.9.0 — upgrade from ${HERDR_UPGRADE_POINTER}, then restart pi (/reload).`, { version });
 }
 return { ok: true, data: version };
}

export function runHerdrCommand(bin, args, options = {}) {
 const timeoutMs = options.timeoutMs ?? 60_000;
 return new Promise(resolve => {
  let child;
  try {
   child = spawn(bin, args, { shell: false, windowsHide: true, env: process.env });
  } catch (error) {
   resolve(failure('HERDR_UNAVAILABLE', `failed to spawn herdr: ${messageOf(error)}`));
   return;
  }
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = result => {
   if (settled) return;
   settled = true;
   clearTimeout(timer);
   options.signal?.removeEventListener('abort', onAbort);
   resolve(result);
  };
  const onAbort = () => {
   try { child.kill(); } catch {}
   finish(failure('TIMEOUT', `herdr ${args.join(' ')} aborted`));
  };
  const timer = setTimeout(() => {
   try { child.kill(); } catch {}
   finish(failure('TIMEOUT', `herdr ${args.join(' ')} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (options.signal) {
   if (options.signal.aborted) onAbort();
   else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  child.on('error', error => {
   finish(failure('HERDR_UNAVAILABLE', `failed to run herdr: ${messageOf(error)}`));
  });
  child.on('close', exitCode => {
   let parsed = parseLastJson(stdout);
   if (exitCode !== 0 && !isErrorEnvelope(parsed)) {
    const alternate = parseLastJson(stderr);
    if (isErrorEnvelope(alternate)) parsed = alternate;
   }
   if (parsed === null) {
    if (exitCode === 0 && !stdout.trim() && !stderr.trim()) {
     finish({ ok: true, data: {} });
     return;
    }
    if (options.textOk && exitCode === 0 && stdout.trim()) {
     finish({ ok: true, data: stdout });
     return;
    }
    const firstError = stderr.split(/\r?\n/).find(line => line.trim());
    finish(failure('VALIDATION_ERROR', firstError ? `herdr error: ${firstError.trim()}` : 'herdr returned unparseable output', { exitCode, stderr, stdout }));
    return;
   }
   const envelope = parsed;
   if (isErrorEnvelope(envelope)) {
    const raw = envelope.error && typeof envelope.error === 'object' ? envelope.error : envelope;
    finish(failure(mapCode(raw.code), String(raw.message ?? 'herdr error'), raw));
    return;
   }
   // JSON 响应不能覆盖进程失败；仅退出码 0 证明命令成功。
   if (exitCode !== 0) {
    const diagnostic = stderr.split(/\r?\n/).find(line => line.trim())?.trim();
    finish(failure('VALIDATION_ERROR', `herdr exited with status ${exitCode ?? 'unknown'}${diagnostic ? `: ${diagnostic}` : ''}`, { exitCode, stderr, stdout }));
    return;
   }
   finish({ ok: true, data: envelope?.result ?? envelope?.data ?? envelope });
  });
 });
}
