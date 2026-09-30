// omp-launch: media probe via ffprobe (bundled binary, then PATH).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface MediaProbe {
	width: number;
	height: number;
	/** Source frame rate; 0 when ffprobe reported no usable one. */
	fps: number;
	durationSeconds: number | null;
}

let resolved: string | undefined;

function ffprobePath(): string {
	if (resolved) return resolved;
	let bundled: string | undefined;
	try {
		const mod = require("ffprobe-static") as { path?: string };
		if (typeof mod.path === "string" && existsSync(mod.path)) bundled = mod.path;
	} catch {}
	resolved = bundled ?? "ffprobe";
	return resolved;
}

interface FfprobeJson {
	streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
	format?: { duration?: string };
}

export function probeMedia(path: string): Promise<MediaProbe | undefined> {
	const { promise, resolve } = Promise.withResolvers<MediaProbe | undefined>();
	const proc = spawn(ffprobePath(), [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height,r_frame_rate",
		"-show_entries",
		"format=duration",
		"-of",
		"json",
		path,
	]);
	let stdout = "";
	proc.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	proc.on("error", () => resolve(undefined));
	proc.on("close", code => {
		if (code !== 0) {
			resolve(undefined);
			return;
		}
		try {
			const parsed = JSON.parse(stdout) as FfprobeJson;
			const stream = parsed.streams?.[0];
			if (!stream?.width || !stream.height) {
				resolve(undefined);
				return;
			}
			const raw = stream.r_frame_rate ?? "";
			const [numerator, denominator] = raw.split("/").map(Number);
			const rate = denominator ? (numerator ?? 0) / denominator : (numerator ?? 0);
			const duration = Number(parsed.format?.duration);
			resolve({
				width: stream.width,
				height: stream.height,
				fps: Number.isFinite(rate) && rate > 0 ? rate : 0,
				durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
			});
		} catch {
			resolve(undefined);
		}
	});
	return promise;
}
