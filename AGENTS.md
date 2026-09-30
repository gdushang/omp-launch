# Repository Guidelines

Startup animation extension for [oh-my-pi (omp)](https://github.com/oh-my-pi): a fullscreen overlay plays a video intro before the session UI appears. Two renderers — **SIXEL** (pixel-perfect) and **truecolor half-blocks**. No clip means no animation: startup is skipped and the session UI appears immediately. TypeScript sources are executed directly by omp's embedded Bun; there is **no build step, no bundler, no test suite**.

## Project Overview

- Play exactly one animation at startup, then hand the screen to omp. Nothing is played outside an interactive main session (`ctx.hasUI && ctx.agent.kind === "main"`).
- The picture always fills the window: SIXEL encodes to the measured grid, half-blocks paint the whole grid.
- SIXEL is **pre-encoded and cached** per terminal geometry, because encoding 169 frames costs ~5.6s. Startup reads the cache file (measured ~233ms to first frame) instead of re-encoding.
- No built-in clip library: the animation comes from the user's own video (config directory, `source`, or `OMP_LAUNCH`).

## Architecture & Data Flow

```
ompLaunch(pi)                         src/index.ts
 ├─ pi.on("session_start")            → play(pi, ctx, config)
 └─ pi.registerCommand("launch")      → panel / list / info / encode / default / one-off play

play()                                src/index.ts
 └─ ctx.ui.custom(LaunchPlayer)       src/player.ts  (fullscreen overlay, owns timing)
     └─ loadMain()
         ├─ probeMedia                src/probe.ts        ffprobe → width/height/fps/duration
         ├─ adoptGraphicsProtocol     src/index.ts        SIXEL or half-blocks only
         ├─ prepareGeometry           src/index.ts        CSI 14 t pixels + cell + grid, may grow window
         └─ one of three stage paths:
              cache hit   → cachedStage(cache)            src/index.ts    no decode, no encode
              cache miss  → noticeStage + startPreencode  src/index.ts    encode on its own, survives overlay
              mode "live" → loadSixelStage                src/index.ts    decode + worker pool, plays after 16 frames
            fallbacks: loadBlockStage; both renderers failing (or no clip) → skip
```

Encoding and rendering:

```
decodeClip        src/video-frames.ts   ffmpeg image2pipe → base64 PNG frames
SixelPool         src/sixel-pool.ts     N workers, round-robin frames, one message per frame
sixel-worker      src/sixel-worker.ts   dynamic import of host pi-tui → renderImage → sequence
sixelLines        src/index.ts          reserved rows + ESC[<n>A + sequence (the overlay contract)
decodeBlockFrames src/color-blocks.ts   ffmpeg rgb24 → truecolor half-block rows
```

Layering rules worth keeping:

- `src/index.ts` is the only orchestration layer (protocol, geometry, cache keys, stage assembly, background jobs, command/panel wiring).
- `src/settings.ts` never imports `src/index.ts`: it drives behaviour through the `SettingsHost` callbacks that `index.ts` implements (dependency injection, no cycles).
- Lifetimes are explicit: `LaunchStage.dispose()` releases what a stage holds (an encode pool); `PreencodeJob` (`startPreencode`) is deliberately independent of the overlay so closing the notice never aborts a write.
- `LaunchStage.complete()` lets a stage end when *its* work finishes (the encode notice) instead of guessing a `durationMs`.

## Key Directories

| Path | Purpose |
|---|---|
| `src/` | All code, 13 TypeScript modules, flat (no subdirectories) |
| `scripts/` | `ensure-ffmpeg.mjs`: the `postinstall` hook — creates the launch config directory, then fetches a static ffmpeg only when `FFMPEG_BIN`, `PATH` and the local copy all lack one. **bun blocks postinstalls of untrusted packages**, so under `omp` it never runs unless the user trusts it (`bun pm trust omp-launch`); `src/index.ts` therefore does the `mkdir` itself on `session_start` |
| `node_modules/` | Only `ffprobe-static` (ships its own binary). `@oh-my-pi/*` is **not** present — the host provides it |

Config lives outside the repo: `<cwd>/.omp/launch/launch.json` or `~/.omp/agent/launch/launch.json` (or `$PI_CODING_AGENT_DIR/launch/`). The SIXEL cache sits in `cache/` next to it.

## Development Commands

There are no npm scripts. Practical commands:

```bash
# Syntax + internal module graph (host packages are external, so this works offline)
bun build src/index.ts --target=bun --external "@oh-my-pi/*" --outdir /tmp/omp-check

# The worker is a separate entry point — check it too
bun build src/sixel-worker.ts --target=bun --external "@oh-my-pi/*" --outdir /tmp/omp-check

# Run it for real (a terminal, not a pipe: the overlay needs a TTY)
omp --extension <repo directory>

# Install dependencies (ffprobe-static ships its own binary; ffmpeg is taken from PATH,
# or downloaded by scripts/ensure-ffmpeg.mjs when PATH has none)
npm install

# Inside a running session: reload the extension without restarting
/reload-plugins
```

Offline limits: `src/index.ts`, `player.ts`, `settings.ts`, `window.ts`, `sixel-worker.ts` import `@oh-my-pi/*` at runtime and **cannot be executed** outside omp. Modules that only touch `node:*` (and type-only host imports) run under plain `bun`: `config.ts`, `video-cache.ts`, `sixel-pool.ts`, `probe.ts`, `ffmpeg.ts`, `video-frames.ts`, `color-blocks.ts`.

## Code Conventions & Common Patterns

**Formatting & naming**

- Tabs, double quotes, semicolons, ~120 column lines. Files are kebab-case (`sixel-pool.ts`), exports are camelCase, types/interfaces are PascalCase.
- Each file starts with a single-line purpose comment: `// omp-launch: <what it owns>`. No long headers.
- Comments are **English**; every user-facing string is **Chinese**.
- Constants are SCREAMING_SNAKE at module top, with the unit or meaning in the name: `ENCODE_WORKERS`, `ENCODE_HEAD`, `NOTICE_MAX_MS`, `NOTICE_SETTLE_MS`, `PIXEL_LIMITS`-style locals.

**Types**

- Declare and export interfaces in the module that owns the value (`CacheKey` in `video-cache.ts`, `LaunchStage` in `player.ts`); consumers `import type`.
- Prefer `import type` for type-only dependencies; never `ReturnType<typeof fn>` in a published signature.
- `readonly` fields and private `#fields` by default (`SixelPool.#receive`, `LaunchPlayer.#finish`).

**Async & concurrency**

- Always `Promise.withResolvers()`; never `new Promise(executor)`. This is a hard project rule.
- Background work is detached with `void promise.then(...)` and reports through `pi.logger` / `ctx.ui.notify` — it must not depend on the overlay's lifetime.
- Cancellation is explicit: pools expose idempotent `close()`, stages expose `dispose()`, and timers go through `ctx.setTimeout` / `ctx.clearTimer`.

**Error handling**

- Fail *downward*, never outward: a SIXEL pool that cannot start → half-blocks; a clip that no renderer can draw (or no clip at all) → **the overlay closes at once and startup is skipped**; a damaged/truncated cache file → deleted, then re-encoded.
- Playback reports one of three outcomes instead of a boolean: `played` (a clip or the pre-encode notice was shown), `skipped` (no clip — not an error, nothing is reported to the user), `failed` (there was a clip and every renderer gave up — warned in the log and by notification).
- Nothing throws into the host: `loadMain()` rejections are caught by `LaunchPlayer`'s `fallback` callback.
- Diagnostics accumulate in a local `notes: string[]` and are joined into the single `omp-launch: playback` log line (plus `diagnostics.reason` for the fallback notice).

**Observability**

- `pi.logger.info("omp-launch: <event>", { ...fields })`. Events in use: `playback`, `SIXEL 编码完成`, `预编码完成`, `播放结束`, `播放中断`, plus `omp-launch: 未能播放素材` and `omp-launch: 素材加载失败` at warn/error level.
- The overlay reports state by polling, not by callbacks: `progress()` for the encode bar, `complete()` to end the stage.

**Persistence**

- Cache file layout: `"OMP-LAUNCH-SIXEL\n"` + `u32 header length` + JSON header + per frame `u32 length` + UTF-8 SIXEL sequence. Bump `FORMAT` when the layout changes.
- Writes are atomic-ish: write `<file>.tmp`, `rm` the target, `rename` (Windows needs the `rm` first). Reads validate magic, format, and the full key; a mismatch deletes the file.
- Cache key = source path + size + mtime + fps + render pixel size + grid columns/rows + measured cell size + `fit`. One file per clip: re-encoding prunes the source's older geometries.

## Important Files

| File | Role |
|---|---|
| `src/index.ts` | Entry (`export default function ompLaunch`), protocol probing, geometry, stage assembly, background pre-encode, `/launch` command surface, panel host implementation |
| `src/player.ts` | `LaunchPlayer` overlay component: stage swapping, end reasons (`duration`/`wait`/`empty`/`skip`/`settled`), plain-key-only skipping |
| `src/sixel-pool.ts` | Worker pool: round-robin frame dealing, per-frame streaming, `waitForHead` / `finished` / `close` |
| `src/sixel-worker.ts` | Worker entry; resolves host pi-tui from an absolute URL passed by the main thread |
| `src/video-cache.ts` | Cache key, binary format, atomic write, damage detection, per-clip pruning |
| `src/window.ts` | `imageFrameSize` (display grid vs render pixels), `planWindow`, `measureCell`, `applyWindow`/`waitForWindow` |
| `src/config.ts` | `LaunchConfig` + `DEFAULTS`, discovery order, `availableMedia`, `saveLaunchConfig` |
| `src/settings.ts` | Panel rows (`buildItems`), label→value mapping (`applyChange`), `SettingsHost` contract |
| `src/video-frames.ts` / `src/color-blocks.ts` | The two renderers |
| `src/probe.ts` / `src/ffmpeg.ts` | External binary resolution + media probing |
| `package.json` | Extension manifest: `omp.extensions: ["./src/index.ts"]` |
| `README.md` | User-facing documentation (Chinese): panel, resolution, cache, commands, troubleshooting |

## Runtime/Tooling Preferences

- **Runtime: Bun**, embedded in the host `omp` binary. Sources are run as TypeScript — do not add a bundler, `tsconfig.json`, or a build output directory.
- `"type": "module"`, ESM only, `node:` builtins are fine (Bun implements them).
- Host modules `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui` exist only inside omp. In a Worker, resolve them on the main thread and pass the absolute URL (`piTuiModuleUrl`, built from `Bun.main` / `Bun.resolveSync`) — a static worker import fails.
- ffprobe comes from `ffprobe-static` when present, otherwise `PATH`. ffmpeg is resolved by `src/ffmpeg.ts` as `FFMPEG_BIN` → `PATH` → `<launch dir>/bin/ffmpeg[.exe]`; the last one is what `scripts/ensure-ffmpeg.mjs` downloads during `postinstall`, and only when the first two find nothing.
- Package manager: npm (`package-lock.json`, `lockfileVersion: 3`, registry pinned to a mirror). Adding a dependency means adding it to `package.json` **and** committing the lockfile.
- Windows-first development. Platform-sensitive spots: cache write uses `rm` before `rename`; the ffmpeg obtained by `scripts/ensure-ffmpeg.mjs` lands as `ffmpeg.exe` under `<launch dir>/bin/`; config paths accept both `\` and `/`.
- Never commit generated artifacts or scratch scripts; run one-off checks from a temp directory outside the repo.

## Testing & QA

There is **no test framework, no CI, no linter, no formatter, and no type-check configuration** in this repository. Verification is a ladder — pick the highest rung that the change allows:

1. **Build check** (always): `bun build <touched entry> --target=bun --external "@oh-my-pi/*"` verifies syntax, imports, and the internal module graph. It does **not** check undefined identifiers — deleting or renaming a symbol can still bundle "successfully" and blow up at runtime (`ReferenceError: resolveMedia is not defined` was shipped exactly that way). After removing or renaming anything, `grep -rn "<oldName>" src/` for call sites before trusting a green build. There is no `tsc` here: the host's `@oh-my-pi/*` types are not on disk, so no type checker can substitute for that grep.
2. **Offline checks for pure modules**: `bun` can import and exercise `config.ts`, `video-cache.ts`, `sixel-pool.ts`, and the ffmpeg-backed modules directly — write a throwaway script in a temp directory. Useful targets: config discovery order, cache round-trip/damage/pruning, pool head-gating and failure paths, ffmpeg decode timing.
3. **Real run** (required for anything touching the overlay, TUI input, SIXEL output, or the cache): `omp --extension <dir>`, then read the log line events under `~/.omp/logs/`. `/launch info` prints protocol, grid, cell and cache state; `/launch encode` builds a cache file on demand.
4. **Panel changes** need a manual pass in a real terminal (`/launch`): the settings list is interactive and cannot be driven headlessly.

Expectations:

- Behavioural changes deserve evidence from a real run — logs (`omp-launch: playback` with its `outcome`/`mode`/`path`/`notes`) or terminal output. A passing build alone proves nothing about playback.
- Prefer a throwaway verification script over adding a permanent test file; this repo has no test harness to file it under.
- When a change alters defaults, commands, or the cache format, update `README.md` in the same edit — README is the only documentation and it is spot-checked against `src/config.ts` (`DEFAULTS`), `src/index.ts` (command surface) and `src/video-cache.ts` (cache table).
