# Quiet reload review fix

## Seam
- Coordinator requested actual AgentSession.reload, loadExtensions/ExtensionRunner, SDK queue and durable session entries.
- Same-process same-session reload must keep the original pending token; queue 1 / disk 1.

## Red
- Added actual SDK reload regression from independently reproduced final audit finding. Red exit 1: actual SDK queue 2 versus required 1; `.artifacts/merger-quiet-reviewfix/red.log`.

## Green
- Shared same-process acknowledgement map via Symbol.for, keyed by session file. Extension loader replacement no longer drops pending quiet/normal tokens.
- Actual SDK reload regression passes: queue 1 / disk 1. Added normal/switch/unknown identity regression; returning to an old session retains its token.
- Unknown session identity keeps current tokens; only explicit synchronous dispatch rejection releases a pending key.

## Decisions
- Pending acknowledgement identity must outlive a sink factory, scoped to session file. Unknown outcomes retain identity; switching sessions uses separate identities.

## Deviations
- None. No spawn/render transport behavior changes.
