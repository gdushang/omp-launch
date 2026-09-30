// omp-launch: decode video frames as PNG for terminal graphics protocols.
import { spawn } from "node:child_process";
import type { FitMode } from "./config";
import { ffmpegPath } from "./ffmpeg";

export interface VideoFrame {
	base64: string;
	widthPx: number;
	heightPx: number;
}

export interface VideoDecodeOptions {
	path: string;
	widthPx: number;
	heightPx: number;
	fps: number;
	maxFrames: number;
	/** `cover` scales past the box and crops back to it; everything else letterboxes inside it. */
	fit?: FitMode;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Split a PNG byte stream at chunk boundaries; keeps the trailing partial frame. */
function takePngFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer } {
	const frames: Buffer[] = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = buffer.indexOf(PNG_SIGNATURE, offset);
		if (start === -1) break;
		let cursor = start + PNG_SIGNATURE.length;
		let end = -1;
		while (cursor + 8 <= buffer.length) {
			const length = buffer.readUInt32BE(cursor);
			const type = buffer.toString("latin1", cursor + 4, cursor + 8);
			const next = cursor + 12 + length;
			if (next > buffer.length) break;
			cursor = next;
			if (type === "IEND") {
				end = cursor;
				break;
			}
		}
		if (end === -1) return { frames, rest: buffer.subarray(start) };
		frames.push(buffer.subarray(start, end));
		offset = end;
	}
	return { frames, rest: Buffer.alloc(0) };
}

export function decodeVideoFrames(options: VideoDecodeOptions): Promise<VideoFrame[]> {
	const { promise, resolve } = Promise.withResolvers<VideoFrame[]>();
	const { widthPx, heightPx } = options;
	const scale =
		options.fit === "cover"
			? `scale=${widthPx}:${heightPx}:force_original_aspect_ratio=increase,crop=${widthPx}:${heightPx}`
			: `scale=${widthPx}:${heightPx}`;
	const proc = spawn(ffmpegPath(), [
		"-v",
		"error",
		"-i",
		options.path,
		"-vf",
		`fps=${options.fps},${scale}`,
		"-f",
		"image2pipe",
		"-vcodec",
		"png",
		"-",
	]);
	let buffered = Buffer.alloc(0);
	const frames: VideoFrame[] = [];
	proc.stdout.on("data", (chunk: Buffer) => {
		if (frames.length >= options.maxFrames) return;
		buffered = Buffer.concat([buffered, chunk]);
		const taken = takePngFrames(buffered);
		buffered = taken.rest;
		for (const png of taken.frames) {
			if (frames.length >= options.maxFrames) break;
			frames.push({
				base64: png.toString("base64"),
				widthPx: options.widthPx,
				heightPx: options.heightPx,
			});
		}
		if (frames.length >= options.maxFrames) proc.kill();
	});
	proc.on("error", () => resolve(frames));
	proc.on("close", () => resolve(frames));
	return promise;
}
