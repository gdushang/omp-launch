// omp-launch: truecolor half-block rendering (works on any truecolor terminal, no graphics protocol needed).
import { spawn } from "node:child_process";
import type { FitMode } from "./config";
import { ffmpegPath } from "./ffmpeg";

export interface BlockDecodeOptions {
	path: string;
	columns: number;
	rows: number;
	fps: number;
	maxFrames: number;
	/** `cover` scales past the grid and crops back to it; everything else letterboxes inside it. */
	fit?: FitMode;
}

const UPPER_HALF = "\u2580";
const FULL_BLOCK = "\u2588";
const RESET = "\x1b[0m";
/** Treat the two half-pixels as one color when they differ by less than this per channel. */
const SAME_COLOR_TOLERANCE = 10;

function packColor(r: number, g: number, b: number): number {
	return (r << 16) | (g << 8) | b;
}

/** One RGB frame -> `rows` lines of half-block cells, colors emitted only when they change. */
function frameToBlocks(buffer: Buffer, columns: number, rows: number): string[] {
	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		let line = "";
		let lastForeground = -1;
		let lastBackground = -1;
		for (let column = 0; column < columns; column++) {
			const top = (row * 2 * columns + column) * 3;
			const bottom = ((row * 2 + 1) * columns + column) * 3;
			const tr = buffer[top]!;
			const tg = buffer[top + 1]!;
			const tb = buffer[top + 2]!;
			const br = buffer[bottom]!;
			const bg = buffer[bottom + 1]!;
			const bb = buffer[bottom + 2]!;
			const topColor = packColor(tr, tg, tb);
			const uniform =
				Math.abs(tr - br) <= SAME_COLOR_TOLERANCE &&
				Math.abs(tg - bg) <= SAME_COLOR_TOLERANCE &&
				Math.abs(tb - bb) <= SAME_COLOR_TOLERANCE;

			if (topColor !== lastForeground) {
				line += `\x1b[38;2;${tr};${tg};${tb}m`;
				lastForeground = topColor;
			}
			if (uniform) {
				line += FULL_BLOCK;
				continue;
			}
			const bottomColor = packColor(br, bg, bb);
			if (bottomColor !== lastBackground) {
				line += `\x1b[48;2;${br};${bg};${bb}m`;
				lastBackground = bottomColor;
			}
			line += UPPER_HALF;
		}
		lines.push(line + RESET);
	}
	return lines;
}

export function decodeBlockFrames(options: BlockDecodeOptions): Promise<string[][]> {
	const { promise, resolve } = Promise.withResolvers<string[][]>();
	const pixelWidth = options.columns;
	const pixelHeight = options.rows * 2;
	const frameSize = pixelWidth * pixelHeight * 3;
	const scale =
		options.fit === "cover"
			? `scale=${pixelWidth}:${pixelHeight}:flags=bilinear:force_original_aspect_ratio=increase,crop=${pixelWidth}:${pixelHeight}`
			: `scale=${pixelWidth}:${pixelHeight}:flags=bilinear`;
	const proc = spawn(ffmpegPath(), [
		"-v",
		"error",
		"-i",
		options.path,
		"-vf",
		`fps=${options.fps},${scale}`,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		"-",
	]);
	let buffered = Buffer.alloc(0);
	const frames: string[][] = [];
	proc.stdout.on("data", (chunk: Buffer) => {
		if (frames.length >= options.maxFrames) return;
		buffered = Buffer.concat([buffered, chunk]);
		while (buffered.length >= frameSize && frames.length < options.maxFrames) {
			const frame = buffered.subarray(0, frameSize);
			buffered = buffered.subarray(frameSize);
			frames.push(frameToBlocks(frame, pixelWidth, options.rows));
		}
		if (frames.length >= options.maxFrames) proc.kill();
	});
	proc.on("error", () => resolve(frames));
	proc.on("close", () => resolve(frames));
	return promise;
}
