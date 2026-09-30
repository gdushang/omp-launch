// omp-launch: config resolution (env > project > user > defaults) and asset discovery.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProtocolMode = "auto" | "sixel" | "blocks";

/** How the frame is fitted into the window box. */
export type FitMode = "contain" | "contain-center" | "cover";

export interface LaunchConfig {
	enabled: boolean;
	dir: string | undefined;
	/** The video to play. Undefined means there is no animation and startup is skipped. */
	mediaPath: string | undefined;
	/** auto = graphics protocol when available, else half-blocks; blocks = force half-blocks. */
	protocol: ProtocolMode;
	/** 0 = follow the source frame rate. */
	fps: number;
	/** Per-frame pixel cap for the graphics path (0 = the window box, i.e. full screen). */
	maxPixels: number;
	resizeWindow: boolean;
	/** contain = whole frame, top-aligned; contain-center = whole frame, centered; cover = fill the box and crop. */
	fit: FitMode;
	maxFrames: number;
	/** Resident budget for decoded frames, in characters (base64/ANSI ≈ bytes). */
	frameBudget: number;
	loop: number;
	waitMaxMs: number;
	allowSkip: boolean;
	takeover: boolean;
}

const MEDIA_RE = /\.(gif|mp4|webm|mkv|mov|m4v|avi|wmv|apng|webp)$/i;
/** Shipped defaults. These match the maintainer's own setup: 60fps cap, window-sized frames, 512MB budget, skip on a plain key. */
const DEFAULTS = {
	protocol: "auto" as ProtocolMode,
	fps: 60,
	maxPixels: 0,
	resizeWindow: true,
	fit: "contain" as FitMode,
	maxFrames: 900,
	frameBudgetMb: 512,
	loop: 1,
	waitMaxMs: 15000,
	allowSkip: true,
	takeover: true,
};

interface RawConfig {
	source?: string;
	protocol?: string;
	fps?: number;
	maxPixels?: number;
	resizeWindow?: boolean;
	fit?: string;
	maxFrames?: number;
	frameBudgetMb?: number;
	loop?: number;
	waitMaxMs?: number;
	allowSkip?: boolean;
	takeover?: boolean;
}

function readJson(path: string): RawConfig | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as RawConfig) : undefined;
	} catch {
		return undefined;
	}
}

/** Video files in a directory, by name: what `source: auto` picks up and the panel lists. */
export function availableMedia(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter(name => MEDIA_RE.test(name))
		.sort()
		.map(name => join(dir, name));
}

function positive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Non-negative variant, where 0 has a documented meaning per field. */
function nonNegative(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function protocolMode(value: string | undefined): ProtocolMode {
	const normalized = value?.toLowerCase();
	if (normalized === "sixel" || normalized === "blocks") return normalized;
	return DEFAULTS.protocol;
}

function fitMode(value: string | undefined): FitMode {
	const normalized = value?.toLowerCase();
	if (normalized === "cover") return "cover";
	if (normalized === "contain-center" || normalized === "center" || normalized === "centre") return "contain-center";
	return DEFAULTS.fit;
}

/** Expand `~` and resolve a relative path against `base`; undefined when nothing is there. */
export function resolveExplicit(source: string, base: string): string | undefined {
	const expanded = source.startsWith("~") ? join(homedir(), source.slice(1)) : source;
	const candidate = /[/\\]/.test(expanded) ? expanded : join(base, expanded);
	return existsSync(candidate) ? candidate : undefined;
}

/** User-level config directory, the fallback when no launch.json exists anywhere yet. */
export function userLaunchDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	return agentDir ? join(agentDir, "launch") : join(homedir(), ".omp", "agent", "launch");
}

/**
 * Merge `patch` into that directory's `launch.json`, creating the directory and
 * file when absent. Only the named keys are touched, so unrelated settings and
 * keys this build does not know about survive a round trip.
 */
export function saveLaunchConfig(dir: string, patch: Record<string, unknown>): void {
	const path = join(dir, "launch.json");
	const existing = readJson(path) ?? {};
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, "utf8");
}

export function loadConfig(cwd: string): LaunchConfig {
	const envValue = process.env.OMP_LAUNCH?.trim();
	if (envValue && /^(off|0|false|none)$/i.test(envValue)) {
		return { enabled: false, dir: undefined, mediaPath: undefined, ...DEFAULTS };
	}

	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const userDir = agentDir ? join(agentDir, "launch") : join(homedir(), ".omp", "agent", "launch");
	const projectDir = join(cwd, ".omp", "launch");
	const dir = existsSync(projectDir) ? projectDir : existsSync(userDir) ? userDir : undefined;
	const raw = (dir ? readJson(join(dir, "launch.json")) : undefined) ?? {};

	const explicit = (raw.source ?? envValue)?.trim();
	/** `source: "builtin"` (or "skip") means no video and no animation: startup is skipped. */
	const noAnimation = explicit !== undefined && /^(builtin|skip)$/i.test(explicit);
	let mediaPath: string | undefined;

	if (!noAnimation) {
		if (explicit && !/^auto$/i.test(explicit)) {
			const resolved = resolveExplicit(explicit, dir ?? cwd);
			if (resolved && MEDIA_RE.test(resolved)) mediaPath = resolved;
		}
		if (dir) mediaPath ??= availableMedia(dir)[0];
	}

	return {
		enabled: true,
		dir,
		mediaPath,
		protocol: protocolMode(raw.protocol),
		fps: nonNegative(raw.fps, DEFAULTS.fps),
		maxPixels: nonNegative(raw.maxPixels, DEFAULTS.maxPixels),
		resizeWindow: raw.resizeWindow ?? DEFAULTS.resizeWindow,
		fit: fitMode(raw.fit),
		maxFrames: positive(raw.maxFrames, DEFAULTS.maxFrames),
		frameBudget: positive(raw.frameBudgetMb, DEFAULTS.frameBudgetMb) * 1_000_000,
		loop: positive(raw.loop, DEFAULTS.loop),
		waitMaxMs: positive(raw.waitMaxMs, DEFAULTS.waitMaxMs),
		allowSkip: raw.allowSkip ?? DEFAULTS.allowSkip,
		takeover: raw.takeover ?? DEFAULTS.takeover,
	};
}
