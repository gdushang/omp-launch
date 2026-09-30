// omp-launch: ffmpeg binary resolution (ascii-stream's bundled ffmpeg-static, then PATH).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let resolved: string | undefined;

export function ffmpegPath(): string {
	if (resolved) return resolved;
	let bundled: string | undefined;
	try {
		const candidate = require("ffmpeg-static");
		if (typeof candidate === "string" && existsSync(candidate)) bundled = candidate;
	} catch {}
	resolved = bundled ?? "ffmpeg";
	return resolved;
}
