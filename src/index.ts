// omp-launch: extension entry — protocol pixels (render resolution capped, always fitted to the window), half-blocks as fallback.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	getCellDimensions,
	ImageProtocol,
	isImageProtocolForced,
	isWindowsTerminalPreviewSixelSupported,
	renderImage,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
	type CellDimensions,
} from "@oh-my-pi/pi-tui";
import { decodeBlockFrames } from "./color-blocks";
import {
	availableMedia,
	loadConfig,
	resolveExplicit,
	saveLaunchConfig,
	userLaunchDir,
	type FitMode,
	type LaunchConfig,
	type ProtocolMode,
} from "./config";
import { LaunchPlayer, type FrameRenderer, type LaunchStage } from "./player";
import { probeMedia, type MediaProbe } from "./probe";
import { createSettingsPanel, type SettingsHost } from "./settings";
import { SixelPool } from "./sixel-pool";
import { decodeVideoFrames, type VideoFrame } from "./video-frames";
import {
	hasCache,
	readCache,
	writeCache,
	type CacheKey,
	type CachedClip,
} from "./video-cache";
import {
	applyWindow,
	currentWindow,
	imageFrameSize,
	measureCell,
	planWindow,
	waitForWindow,
	type ImageBox,
	type PixelLimits,
	type WindowSize,
} from "./window";

const MEDIA_RE = /\.(gif|mp4|webm|mkv|mov|m4v|avi|wmv|apng|webp)$/i;

const PROTOCOL_VALUES: Record<Exclude<ProtocolMode, "auto">, ImageProtocol | null> = {
	sixel: ImageProtocol.Sixel,
	blocks: null,
};

function protocolName(protocol: ImageProtocol | null): string {
	if (protocol === ImageProtocol.Sixel) return "sixel";
	return "无（彩色块）";
}

function timeline(frames: string[][], frameMs: number): FrameRenderer {
	return elapsed => {
		const index = Math.min(frames.length - 1, Math.max(0, Math.floor(elapsed / frameMs)));
		return frames[index] ?? [];
	};
}

/**
 * Canvas rows. One row is held back so a full-height image cannot push the
 * terminal into a scroll: the picture ends on the last row it owns, and the
 * remaining row absorbs the trailing newline.
 */
function grid(): { columns: number; rows: number } {
	return {
		columns: Math.max(1, process.stdout.columns ?? 80),
		rows: Math.max(8, (process.stdout.rows ?? 24) - 1),
	};
}

/** `CSI 14 t` → `CSI 4 ; heightPx ; widthPx t`: real window size in pixels, when answered. */
function queryWindowPixels(ctx: ExtensionContext, timeoutMs = 300): Promise<PixelLimits | undefined> {
	const { promise, resolve } = Promise.withResolvers<PixelLimits | undefined>();
	let timer: Timer | undefined;
	let unsubscribe: (() => void) | undefined;
	const finish = (value: PixelLimits | undefined): void => {
		unsubscribe?.();
		if (timer !== undefined) ctx.clearTimer(timer);
		resolve(value);
	};
	unsubscribe = ctx.ui.onTerminalInput(data => {
		const match = /\x1b\[4;(\d+);(\d+)t/.exec(data);
		if (!match) return;
		finish({ heightPx: Number(match[1]), widthPx: Number(match[2]) });
	});
	timer = ctx.setTimeout(() => finish(undefined), timeoutMs);
	process.stdout.write("\x1b[14t");
	return promise;
}

interface LaunchGeometry {
	columns: number;
	rows: number;
	cell: CellDimensions;
	/** Window size to restore afterwards, when this call enlarged it. */
	restore?: WindowSize;
}

/**
 * Grow the window for a clip and measure the cell from its real pixel size, then read
 * back the grid the overlay draws against. Pre-encoding reuses this so a cached clip
 * is keyed to the same geometry the next launch will compute — a different terminal
 * window or font is a different grid and therefore a different cache file.
 */
async function prepareGeometry(
	ctx: ExtensionContext,
	config: LaunchConfig,
	meta: MediaProbe | undefined,
	notes: string[],
): Promise<LaunchGeometry> {
	let measured: CellDimensions | undefined;
	let restore: WindowSize | undefined;
	if (config.resizeWindow && meta) {
		const before = currentWindow();
		const pixels = await queryWindowPixels(ctx);
		measured = measureCell(before, pixels);
		const planned = planWindow(meta, pixels, measured);
		// Grow-only: shrinking is not the point and emulators routinely ignore it,
		// which would only cost a waitForWindow timeout.
		const target = {
			columns: Math.max(planned.columns, before.columns),
			rows: Math.max(planned.rows, before.rows),
		};
		if (target.columns > before.columns || target.rows > before.rows) {
			applyWindow(target);
			await waitForWindow(target);
			restore = before;
		}
		const cellNote = measured
			? `${measured.widthPx.toFixed(1)}x${measured.heightPx.toFixed(1)}`
			: `估计 ${getCellDimensions().widthPx}x${getCellDimensions().heightPx}`;
		notes.push(
			`窗口 ${before.columns}x${before.rows} → 请求 ${target.columns}x${target.rows}${pixels ? `（像素 ${pixels.widthPx}x${pixels.heightPx}，cell ${cellNote}px）` : "（无像素信息）"}`,
		);
	}
	// pi-tui keeps its own cell size for image fitting (calculateImageFit) and still
	// holds the 9x18 default while omp's cell probe is deferred, so hand it the
	// measured value.
	const cell = measured ?? getCellDimensions();
	if (measured) setCellDimensions(measured);
	const { columns, rows } = grid();
	return { columns, rows, cell, restore };
}

/** Undo an enlargement made for playback or pre-encoding. */
async function restoreGeometry(window: WindowSize | undefined): Promise<void> {
	if (window === undefined) return;
	applyWindow(window);
	await waitForWindow(window);
}

/** Cache lives next to the config it belongs to, so a project's clips do not pile up globally. */
function cacheDirectory(config: LaunchConfig): string {
	return join(config.dir ?? userLaunchDir(), "cache");
}

/** Files and bytes in the cache directory: drives the panel row and the cleanup notice. */
function cacheUsage(config: LaunchConfig): { files: number; bytes: number } {
	const dir = cacheDirectory(config);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return { files: 0, bytes: 0 };
	}
	let files = 0;
	let bytes = 0;
	for (const entry of entries) {
		try {
			const stats = statSync(join(dir, entry));
			if (!stats.isFile()) continue;
			files++;
			bytes += stats.size;
		} catch {
			// A file that vanished between listing and stat contributes nothing.
		}
	}
	return { files, bytes };
}

/** What the settings panel shows on the cleanup row. */
function cacheLabel(config: LaunchConfig): string {
	const usage = cacheUsage(config);
	if (usage.files === 0) return "无缓存";
	return `${usage.files} 个文件 · ${(usage.bytes / 1e6).toFixed(0)}MB`;
}

/**
 * Delete every stored clip; the next launch (or `/launch encode`) encodes again.
 * Synchronous so the settings row shows the size that is actually left on disk once
 * the menu reloads.
 */
function wipeCache(config: LaunchConfig): { files: number; bytes: number } {
	const usage = cacheUsage(config);
	rmSync(cacheDirectory(config), { recursive: true, force: true });
	return usage;
}

/**
 * Key a clip is cached under. The frame rate is the configured target rather than the
 * rate the encoder ends up using: the budget can lower the latter, and a stored clip
 * still plays correctly because its own frame time travels in the cache file.
 */
function cacheKeyFor(
	media: string,
	config: LaunchConfig,
	meta: MediaProbe,
	size: ImageBox,
	geometry: LaunchGeometry,
): CacheKey | undefined {
	let stats;
	try {
		stats = statSync(media);
	} catch {
		return undefined;
	}
	if (!stats.isFile()) return undefined;
	return {
		source: media,
		size: stats.size,
		mtimeMs: Math.round(stats.mtimeMs),
		fps: targetFps(config, meta),
		widthPx: size.widthPx,
		heightPx: size.heightPx,
		columns: geometry.columns,
		rows: geometry.rows,
		cellWidthPx: Math.round(geometry.cell.widthPx * 10) / 10,
		cellHeightPx: Math.round(geometry.cell.heightPx * 10) / 10,
		fit: config.fit,
	};
}

/**
 * Resolve between the two renderers this extension has: SIXEL, else truecolor
 * half-blocks.
 *
 * DA1 (`CSI c`) cannot be used here: omp's ProcessTerminal swallows every
 * `CSI ? … c` reply for the whole session so a late one never leaks into the
 * composer (pi-tui tui.ts:1816) — those bytes never reach an input listener,
 * which is why the old DA1 probe always fell back to blocks. XTSMGRAPHICS item 2
 * is what omp itself probes with in `TUI.enableInput`.
 *
 * omp resolves the static per-terminal protocol and PI_FORCE_IMAGE_PROTOCOL at import
 * time, so `TERMINAL.imageProtocol` may already hold a protocol this extension does not
 * implement (Kitty, iTerm2) — it is cleared so the block renderer takes over instead of
 * an image pipeline that is no longer there.
 */
async function adoptGraphicsProtocol(ctx: ExtensionContext, notes: string[]): Promise<void> {
	if (TERMINAL.imageProtocol === ImageProtocol.Sixel) return;
	if (isImageProtocolForced()) {
		const pinned = TERMINAL.imageProtocol;
		setTerminalImageProtocol(null);
		notes.push(pinned === null ? "图形协议已强制关闭，采用彩色块" : "强制了非 SIXEL 协议，改用彩色块");
		return;
	}
	if (isWindowsTerminalPreviewSixelSupported() || expectsWindowsTerminalSixel()) {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		notes.push("Windows Terminal：采用 SIXEL");
		return;
	}
	if (await probeSixelGeometry(ctx)) {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		notes.push("XTSMGRAPHICS 报告 SIXEL 可用");
		return;
	}
	setTerminalImageProtocol(null);
	notes.push("未探测到 SIXEL，回退彩色块");
}

/**
 * Windows Terminal has shipped SIXEL since 1.22, but build 1.24.11911.0 answers
 * neither `TERM_PROGRAM_VERSION` — what {@link isWindowsTerminalPreviewSixelSupported}
 * keys off — nor XTSMGRAPHICS: the geometry probe times out, and DA1, where it
 * does report attribute 4, is swallowed by ProcessTerminal. `WT_SESSION` is then
 * the only signal left, and trusting it is cheap next to falling back to a
 * 178×100 block grid. Set `protocol: "blocks"` to opt out on an older build.
 */
function expectsWindowsTerminalSixel(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!env.WT_SESSION) return false;
	const program = env.TERM_PROGRAM?.toLowerCase();
	return program === undefined || program === "windows_terminal";
}

/**
 * `CSI ? 2 ; 1 ; 0 S` (XTSMGRAPHICS, item 2 = SIXEL geometry) → `CSI ? 2 ; Ps ; Pv S`.
 * Ps is the status (0 = success) and Pv the maximum SIXEL geometry, which a
 * terminal without SIXEL answers as zero. The reply is consumed so it cannot
 * reach the composer as key input.
 */
function probeSixelGeometry(ctx: ExtensionContext, timeoutMs = 250): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let timer: Timer | undefined;
	let unsubscribe: (() => void) | undefined;
	const finish = (supported: boolean): void => {
		unsubscribe?.();
		if (timer !== undefined) ctx.clearTimer(timer);
		resolve(supported);
	};
	unsubscribe = ctx.ui.onTerminalInput(data => {
		const match = /\x1b\[\?2;(\d+);([0-9;]+)S/.exec(data);
		if (!match) return;
		const status = Number.parseInt(match[1]!, 10);
		const hasGeometry = match[2]!.split(";").some(part => Number.parseInt(part, 10) > 0);
		finish(status === 0 && hasGeometry);
		return { consume: true };
	});
	timer = ctx.setTimeout(() => finish(false), timeoutMs);
	process.stdout.write("\x1b[?2;1;0S");
	return promise;
}

/** Frame-rate floor: playback never drops below this, whatever the memory budget says. */
const MIN_FPS = 24;
/** Frame-rate ceiling when `fps` is left at its default. */
const MAX_FPS = 120;

/**
 * Playback follows the source frame rate, capped at `config.fps` (60 by default):
 * a 24fps clip plays at 24, a 240fps clip at 60. Nothing runs below {@link MIN_FPS}.
 */
function targetFps(config: LaunchConfig, meta: MediaProbe): number {
	const source = meta.fps > 0 ? meta.fps : MIN_FPS;
	const limit = config.fps > 0 ? config.fps : MAX_FPS;
	return Math.max(MIN_FPS, Math.min(limit, source));
}

/**
 * Lower the frame rate (never the duration) when decoded frames would blow `budget`,
 * but never below {@link MIN_FPS}: below that the animation reads as broken rather
 * than smooth, so an over-budget clip keeps its rate and pays the memory instead.
 */
function budgetedFps(fps: number, frameCount: number, totalChars: number, budget: number): number {
	if (frameCount === 0 || totalChars <= budget || fps <= 1) return fps;
	const durationSeconds = frameCount / fps;
	const affordableFrames = Math.floor(budget / (totalChars / frameCount));
	if (affordableFrames <= 0) return MIN_FPS;
	return Math.max(MIN_FPS, Math.min(fps, Math.floor(affordableFrames / durationSeconds)));
}

/**
 * Half-block grid: two vertical pixels per cell. A cell is not exactly twice as
 * tall as it is wide on every font, so the grid ratio comes from the measured
 * cell rather than from an assumed 1:2 cell.
 */
function blockFrameSize(meta: MediaProbe, columns: number, rows: number, cell: CellDimensions, fit: FitMode) {
	// cover: fill the grid; ffmpeg crops whatever the source aspect pushes outside it.
	if (fit === "cover") return { width: Math.max(1, columns), rows: Math.max(1, rows) };
	const aspect = meta.width / meta.height;
	// Logical width per unit height: one column spans `cell.widthPx`, while
	// `rows * 2` pixels span `rows * cell.heightPx`.
	const widthPerHeight = (aspect * cell.heightPx) / (2 * cell.widthPx);
	let width = Math.max(1, columns);
	let height = Math.round(width / widthPerHeight);
	if (height > rows * 2) {
		height = rows * 2;
		width = Math.max(1, Math.round(height * widthPerHeight));
	}
	const blockRows = Math.max(1, Math.ceil(height / 2));
	return { width, rows: blockRows };
}

/** `ESC 7` / `ESC 8`: saved/restored cursor around a graphic placement, as pi-tui's Image does. */
const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
/** pi-tui's placeholder for a row the graphic covers but does not paint. */
const RESERVED_IMAGE_ROW = "\x1b[0m";

/** Workers the clip is split across. Encoding costs ~150ms per frame regardless of frame
 *  size, so the pool is the only lever that raises the achievable frame rate. */
const ENCODE_WORKERS = 8;
/**
 * Frames encoded before playback starts; the rest stream in while the clip plays.
 * Two frames per worker is what the workers need to report their first result anyway,
 * so waiting longer buys buffer (16 frames ≈ 0.7s at 24fps) without delaying the start.
 */
const ENCODE_HEAD = ENCODE_WORKERS * 2;
/**
 * Ceiling for the "预编码中" notice. It normally ends when the encode finishes
 * ({@link NOTICE_SETTLE_MS} after the last frame); this only bounds a wedged job so the
 * session UI is never held hostage.
 */
const NOTICE_MAX_MS = 120_000;

/**
 * pi-tui 的绝对 URL。worker 的模块解析基于自身文件位置，而 pi-tui 随宿主 omp 安装、
 * 不在本项目 node_modules 里，所以说明符得先在主线程解析成真实路径再传过去。
 * omp 的加载器只接管 import 说明符，不参与 `import.meta.resolve` / `Bun.resolveSync`，
 * 因此基准取 omp 自己的入口（`Bun.main`，退而求其次 `process.argv[1]`），最后才回退
 * 裸说明符——那时 worker 会带着解析错误回报。
 */
let piTuiModuleUrl = "@oh-my-pi/pi-tui";
for (const base of [Bun.main, process.argv[1]].filter((entry): entry is string => Boolean(entry))) {
	try {
		piTuiModuleUrl = pathToFileURL(Bun.resolveSync("@oh-my-pi/pi-tui", dirname(base))).href;
		break;
	} catch {
		// 换下一个基准继续试。
	}
}

function sixelFrameLines(base64: string, size: ImageBox): string[] {
	const result = renderImage(
		base64,
		{ widthPx: size.widthPx, heightPx: size.heightPx },
		{ maxWidthCells: size.columns, maxHeightCells: size.rows },
	);
	if (!result) return [];
	if (result.lines) return [...result.lines];
	const cursorRows = Math.max(0, result.rows - 1);
	const lines: string[] = [];
	for (let i = 0; i < cursorRows; i++) lines.push(RESERVED_IMAGE_ROW);
	const moveUp = cursorRows > 0 ? `\x1b[${cursorRows}A` : "";
	const placement = moveUp + (result.sequence ?? "");
	lines.push(cursorRows > 0 ? `${SAVE_CURSOR}${placement}${RESTORE_CURSOR}` : placement);
	return lines;
}

/**
 * Decode the clip at the requested geometry. The resident budget may lower the frame
 * rate (never the duration); the caller only needs the frames and the rate it got.
 */
async function decodeClip(
	media: string,
	meta: MediaProbe,
	config: LaunchConfig,
	size: ImageBox,
	notes: string[],
): Promise<{ frames: VideoFrame[]; fps: number } | undefined> {
	const desired = targetFps(config, meta);
	let fps = desired;
	let frames = await decodeVideoFrames({
		path: media,
		widthPx: size.widthPx,
		heightPx: size.heightPx,
		fps,
		maxFrames: config.maxFrames,
		fit: config.fit,
	});
	if (frames.length === 0) return undefined;

	const total = frames.reduce((sum, frame) => sum + frame.base64.length, 0);
	const reduced = budgetedFps(fps, frames.length, total, config.frameBudget);
	if (reduced < fps) {
		fps = reduced;
		frames = await decodeVideoFrames({
			path: media,
			widthPx: size.widthPx,
			heightPx: size.heightPx,
			fps,
			maxFrames: config.maxFrames,
			fit: config.fit,
		});
		notes.push(`帧率按内存预算从 ${desired} 降到 ${fps}（可调 frameBudgetMb）`);
	}
	return { frames, fps };
}

/** The overlay rows a SIXEL frame occupies: the graphic plus the reserved row above it. */
function sixelLines(sequence: string, layoutRows: number): string[] {
	const cursorRows = Math.max(0, layoutRows - 1);
	if (cursorRows === 0) return [sequence];
	const placement = `\x1b[${cursorRows}A${sequence}`;
	return [
		...Array.from({ length: cursorRows }, () => RESERVED_IMAGE_ROW),
		`${SAVE_CURSOR}${placement}${RESTORE_CURSOR}`,
	];
}

/**
 * SIXEL playback stage: the only pixel renderer left. Decoding happens up front, then a
 * worker pool encodes the clip and playback starts as soon as {@link ENCODE_HEAD} frames
 * exist; the rest stream in while it plays, and a playhead that outruns the pool repeats
 * the newest ready frame. A pool that cannot start at all leaves the caller on blocks.
 */
async function loadSixelStage(
	media: string,
	meta: MediaProbe,
	config: LaunchConfig,
	columns: number,
	rows: number,
	cell: CellDimensions,
	notes: string[],
	trace: (message: string, data: Record<string, unknown>) => void,
): Promise<LaunchStage | undefined> {
	const size = imageFrameSize(meta, columns, rows, config.maxPixels, cell, config.fit);
	const decoded = await decodeClip(media, meta, config, size, notes);
	if (!decoded) return undefined;
	const { fps } = decoded;
	const frames = decoded.frames;
	notes.push(
		`渲染 ${size.widthPx}×${size.heightPx}px → 显示 ${size.columns}×${size.rows} 格（窗口 ${columns}×${rows}，源 ${meta.width}×${meta.height}）`,
	);

	// Encode off the main thread and in parallel (one thread caps playback near 6fps),
	// but hold playback only for the first {@link ENCODE_HEAD} frames: encoding the
	// whole clip up front kept the screen blank for 6s on a 1280×720 clip. The rest
	// stream in while it plays, so the decoded PNGs stay around until the pool is done.
	const candidate = new SixelPool({
		url: new URL("./sixel-worker.ts", import.meta.url),
		piTui: piTuiModuleUrl,
		frames: frames.map(frame => frame.base64),
		size,
		cell,
		workers: ENCODE_WORKERS,
		head: ENCODE_HEAD,
	});
	const startedAt = performance.now();
	await candidate.waitForHead();
	if (candidate.ready === 0) {
		notes.push(`SIXEL 并行编码未生效（${candidate.error ?? "无就绪帧"}），回退彩色块`);
		candidate.close();
		return undefined;
	}
	const pool = candidate;
	notes.push(
		candidate.ready < frames.length
			? `SIXEL 首批编码 ${candidate.ready}/${frames.length} 帧即开播，其余后台续编`
			: `SIXEL 预编码 ${candidate.ready} 帧`,
	);
	void candidate.finished().then(() => {
		// Ahead of the playhead or behind it decides whether playback ever repeats a
		// frame, and it is the only number that says so after the fact.
		trace("omp-launch: SIXEL 编码完成", {
			ready: candidate.ready,
			frames: frames.length,
			elapsedMs: Math.round(performance.now() - startedAt),
			clipMs: Math.round(frames.length * Math.max(16, Math.round(1000 / fps))),
			error: candidate.error ?? null,
		});
		if (candidate.error === undefined) frames.length = 0;
	});

	const frameCount = frames.length;
	const layoutRows = pool.rows > 0 ? pool.rows : size.rows;
	const frameMs = Math.max(16, Math.round(1000 / fps));
	// contain-center pushes the frame down by half the slack; contain and cover start at the top.
	const padTop = config.fit === "contain-center" ? Math.max(0, Math.floor((rows - size.rows) / 2)) : 0;
	const pad = Array.from({ length: padTop }, () => "");
	return {
		durationMs: frameCount * frameMs,
		frameMs,
		loop: config.loop,
		label: "image",
		dispose: () => pool.close(),
		render: elapsedMs => {
			const index = Math.min(frameCount - 1, Math.max(0, Math.floor(elapsedMs / frameMs)));
			// The pool usually stays ahead of the playhead; when it does not, the newest ready
			// frame repeats instead of going blank for a tick. A frame the pool never reached
			// (it died mid-clip) is encoded inline as a last resort.
			const ready = Math.min(index, pool.ready - 1);
			const pooled = pool.sequence(ready);
			const lines = pooled
				? sixelLines(pooled, layoutRows)
				: (() => {
						const frame = frames[index];
						return frame ? sixelFrameLines(frame.base64, size) : [];
					})();
			return padTop > 0 ? [...pad, ...lines] : lines;
		},
	};
}

async function loadBlockStage(
	media: string,
	meta: MediaProbe,
	config: LaunchConfig,
	columns: number,
	rows: number,
	cell: CellDimensions,
	notes: string[],
): Promise<LaunchStage | undefined> {
	const size = blockFrameSize(meta, columns, rows, cell, config.fit);
	const desired = targetFps(config, meta);
	let fps = desired;
	let frames = await decodeBlockFrames({
		path: media,
		columns: size.width,
		rows: size.rows,
		fps,
		maxFrames: config.maxFrames,
		fit: config.fit,
	});
	if (frames.length === 0) return undefined;

	const total = frames.reduce((sum, frame) => sum + frame.reduce((lineSum, line) => lineSum + line.length, 0), 0);
	const reduced = budgetedFps(fps, frames.length, total, config.frameBudget);
	if (reduced < fps) {
		fps = reduced;
		frames = await decodeBlockFrames({
			path: media,
			columns: size.width,
			rows: size.rows,
			fps,
			maxFrames: config.maxFrames,
			fit: config.fit,
		});
		notes.push(`帧率按内存预算从 ${desired} 降到 ${fps}（可调 frameBudgetMb）`);
	}
	notes.push(`画面 ${size.width}×${size.rows * 2} 逻辑像素（半块）`);

	// Only contain-center offsets the frame; contain starts at the top-left, cover fills the grid.
	const centered = config.fit === "contain-center";
	const padTop = centered ? Math.max(0, Math.floor((rows - size.rows) / 2)) : 0;
	const padLeft = centered ? Math.max(0, Math.floor((columns - size.width) / 2)) : 0;
	const gutter = " ".repeat(padLeft);
	const padded =
		padTop > 0 || padLeft > 0
			? frames.map(frame => [
					...Array.from({ length: padTop }, () => ""),
					...frame.map(line => gutter + line),
				])
			: frames;
	const frameMs = Math.max(16, Math.round(1000 / fps));
	return {
		durationMs: padded.length * frameMs,
		frameMs,
		loop: config.loop,
		label: "blocks",
		render: timeline(padded, frameMs),
	};
}

/** Plays straight out of the cache: no decode, no encode, no workers. */
function cachedStage(clip: CachedClip, config: LaunchConfig, rows: number, size: ImageBox): LaunchStage {
	const frameCount = clip.frames.length;
	const layoutRows = clip.layoutRows > 0 ? clip.layoutRows : size.rows;
	const padTop = config.fit === "contain-center" ? Math.max(0, Math.floor((rows - size.rows) / 2)) : 0;
	const pad = Array.from({ length: padTop }, () => "");
	return {
		durationMs: frameCount * clip.frameMs,
		frameMs: clip.frameMs,
		loop: config.loop,
		label: "cache",
		render: elapsedMs => {
			const index = Math.min(frameCount - 1, Math.max(0, Math.floor(elapsedMs / clip.frameMs)));
			const lines = sixelLines(clip.frames[index] ?? "", layoutRows);
			return padTop > 0 ? [...pad, ...lines] : lines;
		},
	};
}

/**
 * Shown when this launch has no usable cache file: the clip is encoded in the
 * background and the next launch plays it. The stage polls the job, so it lasts exactly
 * as long as the encode does — a fixed duration either cut the bar off half way (this
 * clip needs ~6s) or held the screen long after the file was written. Pressing a normal
 * key still leaves early (the encode keeps running and reports on its own).
 */
function noticeStage(
	title: string,
	job: PreencodeJob,
	columns: number,
	maxMs: number,
): LaunchStage {
	const barWidth = Math.max(12, Math.min(28, Math.floor(columns / 5)));
	const indent = " ".repeat(Math.max(2, Math.floor(columns / 6)));
	return {
		durationMs: maxMs,
		frameMs: 100,
		loop: 1,
		label: "notice",
		complete: () => job.settled(),
		render: () => {
			const { ready, total } = job.progress();
			const ratio = total > 0 ? Math.min(1, ready / total) : 0;
			const filled = Math.round(barWidth * ratio);
			const result = job.result();
			const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
			// Before the first frame is decoded there is no progress to show, and a 0/0 bar
			// reads as "stuck at zero" for the ~0.6s the decode takes.
			const detail = total > 0 ? `${Math.round(ratio * 100)}%（${ready}/${total} 帧）` : "正在解码素材…";
			const lines = [
				"",
				`${indent}正在预编码「${title}」…`,
				`${indent}${bar}  ${detail}`,
				`${indent}完成后下次启动显示，按任意字母/空格也可先进首页`,
			];
			if (result !== undefined) {
				lines[1] = `${indent}「${title}」预编码${result.ok ? "完成" : "失败"}`;
			}
			return lines;
		},
	};
}

interface PreencodeResult {
	ok: boolean;
	frames: number;
	/** Size of the stored file, 0 when nothing was written. */
	bytes: number;
	error?: string;
}

interface PreencodeJob {
	/** Frames encoded so far, for a progress display. */
	progress: () => { ready: number; total: number };
	/** The encode result once it is known, for the notice text. */
	result: () => PreencodeResult | undefined;
	/** True once the encode finished — held briefly so the final bar paints first. */
	settled: () => boolean;
	done: Promise<PreencodeResult>;
}

/** How long the finished notice stays up before the session UI takes over. */
const NOTICE_SETTLE_MS = 700;

/**
 * Encode a clip and store it for the next launch. Deliberately independent of the
 * overlay's lifetime: closing the notice, skipping the animation, or the startup
 * notice expiring must not abort the write in progress.
 */
function startPreencode(
	pi: ExtensionAPI,
	config: LaunchConfig,
	media: string,
	meta: MediaProbe,
	size: ImageBox,
	geometry: LaunchGeometry,
	key: CacheKey,
): PreencodeJob {
	let total = 0;
	let pool: SixelPool | undefined;
	let finished: PreencodeResult | undefined;
	let finishedAt = 0;
	const done = (async (): Promise<PreencodeResult> => {
		const notes: string[] = [];
		const startedAt = performance.now();
		const decoded = await decodeClip(media, meta, config, size, notes);
		if (!decoded) return { ok: false, frames: 0, bytes: 0, error: "解码失败" };
		total = decoded.frames.length;
		pool = new SixelPool({
			url: new URL("./sixel-worker.ts", import.meta.url),
			piTui: piTuiModuleUrl,
			frames: decoded.frames.map(frame => frame.base64),
			size,
			cell: geometry.cell,
			workers: ENCODE_WORKERS,
			head: total,
		});
		await pool.finished();
		if (pool.error !== undefined || pool.ready < total) {
			const error = pool.error ?? `仅编码 ${pool.ready}/${total} 帧`;
			pool.close();
			return { ok: false, frames: pool.ready, bytes: 0, error };
		}
		const frames = Array.from({ length: total }, (_, index) => pool?.sequence(index) ?? "");
		const frameMs = Math.max(16, Math.round(1000 / decoded.fps));
		const layoutRows = pool.rows > 0 ? pool.rows : size.rows;
		const written = await writeCache(cacheDirectory(config), key, { frames, layoutRows, frameMs });
		pi.logger.info("omp-launch: 预编码完成", {
			media,
			frames: total,
			layoutRows,
			frameMs,
			bytes: written.bytes,
			replaced: written.replaced,
			elapsedMs: Math.round(performance.now() - startedAt),
			file: written.file,
		});
		return { ok: true, frames: total, bytes: written.bytes };
	})();
	void done.then(result => {
		finished = result;
		finishedAt = performance.now();
	});
	return {
		progress: () => ({ ready: pool?.ready ?? 0, total }),
		result: () => finished,
		settled: () => finished !== undefined && performance.now() - finishedAt >= NOTICE_SETTLE_MS,
		done,
	};
}

/** Name shown on the panel's "默认素材" row and in notices. */
function mediaLabel(config: LaunchConfig): string {
	return config.mediaPath ? basename(config.mediaPath) : "无素材（启动时不播动画）";
}

/**
 * Startup path. The stored clip for this exact geometry plays with no decoding and no
 * encoding; without one, this launch shows a notice and encodes the clip in the
 * background so the next launch has something to play. Returns undefined when the
 * clip cannot be keyed or encoded at all, which leaves the caller on the built-in
 * animation.
 */
async function loadCachedStage(
	pi: ExtensionAPI,
	config: LaunchConfig,
	media: string,
	meta: MediaProbe,
	geometry: LaunchGeometry,
	notes: string[],
	report: { started: (title: string) => void; finished: (title: string, result: PreencodeResult) => void },
): Promise<LaunchStage | undefined> {
	const size = imageFrameSize(meta, geometry.columns, geometry.rows, config.maxPixels, geometry.cell, config.fit);
	const key = cacheKeyFor(media, config, meta, size, geometry);
	if (!key) return undefined;
	const title = basename(media);
	const cached = await readCache(cacheDirectory(config), key);
	if (cached) {
		notes.push(`命中预编码缓存（${cached.frames.length} 帧，${(cached.bytes / 1e6).toFixed(1)}MB）`);
		return cachedStage(cached, config, geometry.rows, size);
	}
	notes.push("无预编码缓存：本次不播素材，后台编码供下次启动");
	const job = startPreencode(pi, config, media, meta, size, geometry, key);
	// The notice can be left early with a key, so the encode announces itself as well.
	report.started(title);
	void job.done.then(result => report.finished(title, result));
	return noticeStage(title, job, geometry.columns, NOTICE_MAX_MS);
}

/**
 * Resolve the geometry, size and cache key for one clip at the current terminal shape,
 * growing the window the way playback would. Undefined when the clip cannot be
 * described (missing file, unusable probe).
 */
async function encodePlan(
	ctx: ExtensionContext | ExtensionCommandContext,
	config: LaunchConfig,
	media: string,
	meta: MediaProbe,
): Promise<{ size: ImageBox; geometry: LaunchGeometry; key: CacheKey } | undefined> {
	const geometry = await prepareGeometry(ctx as ExtensionContext, config, meta, []);
	const size = imageFrameSize(meta, geometry.columns, geometry.rows, config.maxPixels, geometry.cell, config.fit);
	const key = cacheKeyFor(media, config, meta, size, geometry);
	if (!key) return undefined;
	return { size, geometry, key };
}

function describePreencode(title: string, result: PreencodeResult): { message: string; level: "info" | "warning" } {
	return result.ok
		? {
				message: `omp-launch：「${title}」预编码完成（${result.frames} 帧，${(result.bytes / 1e6).toFixed(0)}MB），下次启动直接播放`,
				level: "info",
			}
		: {
				message: `omp-launch：「${title}」预编码失败（${result.error ?? "未知原因"}），可用 /launch encode 重试`,
				level: "warning",
			};
}

/**
 * Choosing a default clip is only cheap to start if a cache file exists for it, so the
 * choice checks and, when the file is missing, encodes it in the background. Never
 * blocks the command: the encode runs on its own and reports by notification.
 */
async function ensurePreencoded(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: LaunchConfig,
	media: string,
): Promise<void> {
	const title = basename(media);
	const meta = await probeMedia(media);
	if (!meta) {
		ctx.ui.notify(`omp-launch：无法探测「${title}」，启动时不会预编码`, "warning");
		return;
	}
	const plan = await encodePlan(ctx, config, media, meta);
	await restoreGeometry(plan?.geometry.restore);
	if (!plan) {
		ctx.ui.notify(`omp-launch：无法为「${title}」建立缓存键，启动时将回退内置动画`, "warning");
		return;
	}
	if (await hasCache(cacheDirectory(config), plan.key)) {
		ctx.ui.notify(`omp-launch：「${title}」已有预编码缓存，启动即可播放`, "info");
		return;
	}
	ctx.ui.notify(`omp-launch：正在后台预编码「${title}」，完成后下次启动直接播放`, "info");
	const job = startPreencode(pi, config, media, meta, plan.size, plan.geometry, plan.key);
	void job.done.then(result => {
		const { message, level } = describePreencode(title, result);
		ctx.ui.notify(message, level);
	});
}

/** `/launch encode [路径|all]`: encode now so the next start has a cache file. */
async function encodeTargets(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: LaunchConfig,
	value: string,
): Promise<void> {
	const targets: string[] = [];
	if (value.length === 0 || /^all$/i.test(value)) {
		// Everything the config can play from: the config directory's videos plus the file
		// that is active now (which may live elsewhere).
		for (const media of availableMedia(config.dir ?? userLaunchDir())) targets.push(media);
		const current = config.mediaPath;
		if (current && !targets.includes(current)) targets.push(current);
	} else {
		const resolved = existsSync(value) ? value : resolveExplicit(value, config.dir ?? ctx.cwd);
		if (!resolved || !MEDIA_RE.test(resolved)) {
			ctx.ui.notify(`omp-launch：找不到视频「${value}」（/launch list 看配置目录里的文件）`, "warning");
			return;
		}
		targets.push(resolved);
	}
	if (targets.length === 0) {
		ctx.ui.notify("omp-launch：没有可预编码的素材", "warning");
		return;
	}
	ctx.ui.notify(`omp-launch：开始预编码 ${targets.length} 个素材（按当前终端尺寸），逐个通知结果`, "info");
	let restore: WindowSize | undefined;
	let finished = 0;
	let usable = 0;
	for (const media of targets) {
		const title = basename(media);
		const meta = await probeMedia(media);
		if (!meta) {
			ctx.ui.notify(`omp-launch：跳过「${title}」（无法探测）`, "warning");
			continue;
		}
		const plan = await encodePlan(ctx, config, media, meta);
		restore ??= plan?.geometry.restore;
		if (!plan) {
			ctx.ui.notify(`omp-launch：跳过「${title}」（无法建立缓存键）`, "warning");
			continue;
		}
		finished++;
		if (await hasCache(cacheDirectory(config), plan.key)) {
			usable++;
			ctx.ui.notify(`omp-launch：${finished}/${targets.length}「${title}」已有缓存，跳过`, "info");
			continue;
		}
		const result = await startPreencode(pi, config, media, meta, plan.size, plan.geometry, plan.key).done;
		if (result.ok) usable++;
		const { message, level } = describePreencode(title, result);
		ctx.ui.notify(`${message}（${finished}/${targets.length}）`, level);
	}
	await restoreGeometry(restore);
	ctx.ui.notify(
		`omp-launch：预编码结束（可用 ${usable}/${targets.length}）｜缓存目录 ${cacheDirectory(config)}`,
		usable === targets.length ? "info" : "warning",
	);
}

/**
 * Play one animation behind a fullscreen overlay.
 *
 * `played` — something was shown (a cached clip, a live render, or the "预编码中"
 * notice). `skipped` — there was no clip to play, so nothing was shown at all.
 * `failed` — there was a clip and every renderer gave up; the caller reports that.
 */
type PlayOutcome = "played" | "skipped" | "failed";

async function play(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	config: LaunchConfig,
	diagnostics?: { reason?: string },
	mode: "cache" | "live" = "cache",
): Promise<PlayOutcome> {
	if (!ctx.hasUI) return "skipped";
	let outcome: PlayOutcome = "played";
	let savedWindow: WindowSize | undefined;

	await ctx.ui.custom<void>(
		(tui, _theme, _keybindings, done) => {
			const player = new LaunchPlayer({
				waitMaxMs: config.waitMaxMs,
				allowSkip: config.allowSkip,
				loadMain: async () => {
					const notes: string[] = [];
					const startedAt = performance.now();
					const media = config.mediaPath;
					const meta = media ? await probeMedia(media) : undefined;

					if (config.protocol === "auto") {
						await adoptGraphicsProtocol(ctx as ExtensionContext, notes);
					} else {
						setTerminalImageProtocol(PROTOCOL_VALUES[config.protocol]);
					}

					const geometry = await prepareGeometry(ctx as ExtensionContext, config, meta, notes);
					savedWindow = geometry.restore;
					const { columns, rows, cell } = geometry;
					const wantsGraphics = config.protocol !== "blocks" && TERMINAL.imageProtocol !== null;

					let stage: LaunchStage | undefined;
					if (!media || !meta) {
						// No clip, no animation: closing the overlay immediately is the "skip".
						notes.push("没有可用的视频素材，跳过启动动画");
					} else {
						if (!wantsGraphics) {
							stage = await loadBlockStage(media, meta, config, columns, rows, cell, notes);
						} else if (mode === "cache" && TERMINAL.imageProtocol === ImageProtocol.Sixel) {
							stage = await loadCachedStage(pi, config, media, meta, geometry, notes, {
								started: title =>
									ctx.ui.notify(
										`omp-launch：正在后台预编码「${title}」，完成后下次启动直接播放（按普通键可先进首页）`,
										"info",
									),
								finished: (title, result) => {
									const { message, level } = describePreencode(title, result);
									ctx.ui.notify(message, level);
								},
							});
						}
						stage ??=
							(await loadSixelStage(media, meta, config, columns, rows, cell, notes, (message, data) =>
								pi.logger.info(message, data),
							)) ?? (await loadBlockStage(media, meta, config, columns, rows, cell, notes));
						if (stage === undefined) notes.push("所有渲染路径都失败，跳过启动动画");
					}
					if (stage === undefined) outcome = media && meta ? "failed" : "skipped";
					notes.push(`首帧耗时 ${Math.round(performance.now() - startedAt)}ms`);
					pi.logger.info("omp-launch: playback", {
						path: stage?.label ?? "none",
						outcome,
						mode,
						protocol: protocolName(TERMINAL.imageProtocol),
						configured: config.protocol,
						fit: config.fit,
						grid: `${columns}x${rows}`,
						frameMs: stage?.frameMs ?? null,
						configuredFps: config.fps,
						resized: savedWindow !== undefined,
						media: media ?? null,
						notes: notes.length > 0 ? notes.join("; ") : null,
					});
					if (diagnostics) diagnostics.reason = notes.join("; ");
					return stage;
				},
				fallback: error => {
					const reason = error instanceof Error ? error.message : String(error);
					pi.logger.error?.("omp-launch: 素材加载失败", { error: reason });
					if (diagnostics) diagnostics.reason = `加载异常：${reason}`;
					outcome = "failed";
					// Undefined ends the overlay at once instead of showing an animation that
					// is not the one the config asked for.
					return undefined;
				},
				requestRender: () => tui.requestRender(),
				schedule: (callback, ms) => ctx.setTimeout(callback, ms),
				cancel: timer => ctx.clearTimer(timer),
				trace: (message, data) => pi.logger.info(message, data),
				onDone: () => done(undefined),
			});
			player.start();
			return player;
		},
		{
			overlay: true,
			overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true },
		},
	);

	await restoreGeometry(savedWindow);
	return outcome;
}

async function takeoverBuiltinSplash(pi: ExtensionAPI): Promise<string | undefined> {
	const setting = lookup("startup.showSplash");
	if (!setting || setting.get(pi.pi.settings) !== true) return undefined;
	try {
		await pi.exec("omp", ["config", "set", "startup.showSplash", "false"]);
		return "omp-launch：已关闭 omp 内置启动动画，后续启动由本插件接管";
	} catch {
		return "omp-launch：未能自动关闭内置启动动画，可手动执行 omp config set startup.showSplash false";
	}
}

/** Config for a one-off play: the target when it is a real video file, else unchanged. */
function forCommand(config: LaunchConfig, target: string): LaunchConfig {
	if (target.length === 0 || !existsSync(target) || !MEDIA_RE.test(target)) return config;
	return { ...config, mediaPath: target };
}

/** Report or persist which animation starts by default (`/launch default [target]`). */
function setDefaultAnimation(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: LaunchConfig,
	value: string,
): void {
	const dir = config.dir ?? userLaunchDir();
	const file = join(dir, "launch.json");
	if (value.length === 0) {
		const current = config.mediaPath ?? "无素材（启动时不播动画）";
		ctx.ui.notify(`omp-launch 默认素材：${current}｜设置：/launch default <视频路径|auto>`, "info");
		return;
	}
	if (/^auto$/i.test(value)) {
		saveLaunchConfig(dir, { source: "auto" });
		ctx.ui.notify(`omp-launch：默认素材已恢复自动（配置目录内首个视频）｜${file}`, "info");
		// `auto` resolves to whatever the directory holds now, which may differ from what was
		// playing (an explicit source is dropped), so the new default gets the same check.
		const media = config.dir ? availableMedia(config.dir)[0] : undefined;
		if (media) void ensurePreencoded(pi, ctx, config, media);
		return;
	}
	const resolved = resolveExplicit(value, config.dir ?? ctx.cwd);
	if (resolved && MEDIA_RE.test(resolved)) {
		saveLaunchConfig(dir, { source: resolved });
		ctx.ui.notify(`omp-launch：默认素材已设为 ${resolved}｜下次启动生效｜${file}`, "info");
		void ensurePreencoded(pi, ctx, config, resolved);
		return;
	}
	ctx.ui.notify(`omp-launch：找不到视频「${value}」（把文件放进配置目录，或用绝对路径）`, "warning");
}

/** Interactive settings panel (`/launch settings`): arrow keys, Enter to cycle or open a submenu. */
async function openSettings(pi: ExtensionAPI, ctx: ExtensionCommandContext, config: LaunchConfig): Promise<void> {
	await ctx.ui.custom<void>(
		(_tui, _theme, _keybindings, done) => {
			const host: SettingsHost = {
				config,
				save: patch => saveLaunchConfig(config.dir ?? userLaunchDir(), patch),
				preview: target => {
					// Leave the panel first: playback opens its own fullscreen overlay.
					done(undefined);
					ctx.setTimeout(() => {
						void play(pi, ctx, forCommand(config, target), undefined, "live");
					}, 0);
				},
				defaultChanged: target => {
					// Same guarantee as `/launch default`: a default with no cache file means the
					// next start shows the notice instead of the animation.
					const media = forCommand(config, target).mediaPath;
					if (media) void ensurePreencoded(pi, ctx, config, media);
				},
				cacheInvalidated: field => {
					ctx.ui.notify(
						`omp-launch：${field} 已改，预编码缓存不再匹配；下次启动会重新编码，想现在补建用 /launch encode`,
						"info",
					);
				},
				clearCache: () => {
					const usage = wipeCache(config);
					ctx.ui.notify(
						usage.files > 0
							? `omp-launch：已清理 ${usage.files} 个预编码文件（释放 ${(usage.bytes / 1e6).toFixed(0)}MB），下次启动会重新编码`
							: "omp-launch：缓存目录本来就是空的",
						"info",
					);
				},
				defaultLabel: mediaLabel(config),
				cacheLabel: cacheLabel(config),
			};
			return createSettingsPanel(
				host,
				() => done(undefined),
				() => {
					const fresh = loadConfig(ctx.cwd);
					return { ...host, config: fresh, defaultLabel: mediaLabel(fresh), cacheLabel: cacheLabel(fresh) };
				},
			);
		},
		{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true } },
	);
}

export default function ompLaunch(pi: ExtensionAPI) {
	pi.setLabel("omp-launch");

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.agent?.kind !== "main") return;
		const config = loadConfig(ctx.cwd);
		if (!config.enabled) return;

		// No await before play(): omp paints the welcome screen in InteractiveMode.init
		// (interactive-mode.ts:1767) before emitting session_start (:1871), so every
		// awaited millisecond here keeps that screen visible before the overlay covers it.
		const takeoverTask = config.takeover ? takeoverBuiltinSplash(pi) : undefined;
		const diagnostics: { reason?: string } = {};
		const outcome = await play(pi, ctx, config, diagnostics);
		if (outcome === "failed") {
			const reason = diagnostics.reason ?? "未记录到原因";
			pi.logger.warn?.("omp-launch: 未能播放素材", { reason });
			ctx.ui.notify(`omp-launch：未能播放素材（${reason}），已跳过启动动画`, "warning");
		}
		const takeoverMessage = await takeoverTask;
		if (takeoverMessage) ctx.ui.notify(takeoverMessage, "info");
	});

	pi.registerCommand("launch", {
		description:
			"启动动画设置（/launch 开面板；/launch <视频文件> 直接试播；/launch encode [路径|all] 预编码；/launch default <路径|auto> 设默认）",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const target = args.trim();
			const config = loadConfig(ctx.cwd);
			const lower = target.toLowerCase();

			// A bare `/launch` opens the settings panel: playback lives on its 预览 row,
			// and `/launch <文件>` still plays one directly.
			if (target.length === 0 || lower === "settings" || lower === "config") {
				await openSettings(pi, ctx as ExtensionCommandContext, config);
				return;
			}

			if (lower === "default" || lower.startsWith("default ")) {
				setDefaultAnimation(
					pi,
					ctx as ExtensionCommandContext,
					config,
					target.slice("default".length).trim(),
				);
				return;
			}

			if (lower === "encode" || lower.startsWith("encode ")) {
				await encodeTargets(pi, ctx as ExtensionCommandContext, config, target.slice("encode".length).trim());
				return;
			}

			if (lower === "list") {
				const dir = config.dir ?? userLaunchDir();
				const media = availableMedia(dir);
				ctx.ui.notify(
					media.length > 0
						? `omp-launch 配置目录内的视频：${media.map(basename).join("、")}｜设为默认：/launch default <路径>`
						: `omp-launch：${dir} 里没有视频文件｜把文件放进去，或用 /launch default <绝对路径>`,
					"info",
				);
				return;
			}

			if (lower === "info") {
				const source = config.mediaPath ?? "无素材（启动时不播动画）";
				const window = currentWindow();
				const pixels = await queryWindowPixels(ctx);
				const measured = measureCell(window, pixels);
				const cell = measured ?? getCellDimensions();
				const planned = planWindow({ width: 16, height: 9 }, pixels, measured);
				const cellText = measured
					? `${cell.widthPx.toFixed(1)}×${cell.heightPx.toFixed(1)}px（实测）`
					: `${cell.widthPx}×${cell.heightPx}px（估计）`;
				ctx.ui.notify(
					`omp-launch｜协议 ${protocolName(TERMINAL.imageProtocol)}（配置 ${config.protocol}）｜裁剪 ${config.fit}｜窗口 ${window.columns}×${window.rows}${pixels ? ` = ${pixels.widthPx}×${pixels.heightPx}px` : "（像素未知）"}｜cell ${cellText}｜16:9 可用网格 ${planned.columns}×${planned.rows}｜素材 ${source}｜预编码 ${cacheLabel(config)}（${cacheDirectory(config)}）`,
					"info",
				);
				return;
			}

			const outcome = await play(pi, ctx, forCommand(config, target), undefined, "live");
			if (outcome === "skipped") ctx.ui.notify("omp-launch：没有可播放的视频素材", "info");
			if (outcome === "failed") ctx.ui.notify("omp-launch：未能播放该视频（看日志 notes）", "warning");
		},
	});
}
