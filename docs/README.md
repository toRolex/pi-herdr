# pi-herdr documentation

Read the current guides in [English](../README.md) or [简体中文](../README.zh-CN.md). Each guide covers installation, all public tools, sessions, routing, layout, settings, and limitations for the toRolex fork.

## Quick start

Install pi and herdr separately. Configure an authenticated pi model, ensure Node.js 22.19.0 or newer is available, and run herdr 0.9.0 or newer from your terminal.

```bash
herdr --version
herdr status
herdr
```

Install the extension from this fork's Git source, then restart pi or reload:

```bash
pi install git:github.com/toRolex/pi-herdr
```

In pi, ask:

```text
Spawn an agent named summ to summarize README.md in three bullets.
Give me its result when the completion notification arrives.
```

`herdr_spawn_agent` returns acceptance immediately as `starting` or `queued`. It does not guarantee boot completion. `herdr_get_agent_result` with `{ "target": "summ" }` returns one current snapshot. Neither tool accepts `wait`. Background workflows return a run ID immediately and report one aggregated result later.

## Current reference

- [Public tools](../README.md#tools) and their [schema implementations](../src/tools).
- [Settings](../README.md#settings), including workflow registration and pane layout.
- [Development commands](../README.md#development).
- [Attribution and license](../README.md#attribution-and-license).

Some older topic pages retain historical contracts. Use the two root guides and current schemas for public tool behavior.
