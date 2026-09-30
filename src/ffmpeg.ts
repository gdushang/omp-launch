// omp-launch: ffmpeg binary resolution (FFMPEG_BIN, then PATH, then the copy fetched at install time).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { userLaunchDir } from "./config";

let resolved: string | undefined;

/** `Bun.which` behind a `typeof` guard, so the module still loads under plain node. */
function findOnPath(): string | undefined {
	if (typeof Bun === "undefined" || typeof Bun.which !== "function") return undefined;
	try {
		const found = Bun.which("ffmpeg");
		return typeof found === "string" && found.length > 0 ? found : undefined;
	} catch {
		return undefined;
	}
}

export function ffmpegPath(): string {
	if (resolved) return resolved;
	const explicit = process.env.FFMPEG_BIN;
	if (explicit && existsSync(explicit)) {
		resolved = explicit;
		return resolved;
	}
	const fromPath = findOnPath();
	if (fromPath) {
		resolved = fromPath;
		return resolved;
	}
	// Last resort: whatever `scripts/ensure-ffmpeg.mjs` downloaded for us at install time.
	const local = join(userLaunchDir(), "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
	resolved = existsSync(local) ? local : "ffmpeg";
	return resolved;
}
