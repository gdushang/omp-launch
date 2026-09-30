// omp-launch: pre-encoded SIXEL cache — one file per clip + geometry, written in the background.
import { createHash } from "node:crypto";
import { mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Everything a SIXEL sequence depends on. A single changed field means the stored
 * frames would be encoded for a terminal that is no longer there, so the file is
 * ignored rather than played back squashed — cell size is measured per terminal and
 * font, and the fit inside `renderImage` runs against the grid the overlay draws.
 */
export interface CacheKey {
	source: string;
	/** Byte size and mtime of the source: an edited clip must miss instead of replaying stale frames. */
	size: number;
	mtimeMs: number;
	/** Frame rate the clip is sampled at (the configured target, before any memory budget cut). */
	fps: number;
	/** Rendering resolution the sequences were encoded from. */
	widthPx: number;
	heightPx: number;
	/** Display grid the encoder fitted to. */
	columns: number;
	rows: number;
	cellWidthPx: number;
	cellHeightPx: number;
	fit: string;
}

export interface CachedClip {
	frames: string[];
	/** Rows the encoder reported for one frame: what the overlay has to reserve. */
	layoutRows: number;
	frameMs: number;
	durationMs: number;
	/** Size of the cache file, for the log. */
	bytes: number;
}

export interface CacheWriteResult {
	file: string;
	bytes: number;
	/** Older geometries of the same source that were dropped to keep one file per clip. */
	replaced: number;
}

const MAGIC = "OMP-LAUNCH-SIXEL\n";
/** Bump when the file layout or the meaning of a stored sequence changes. */
const FORMAT = 1;
/** Enough for the header: magic + length + the key JSON. */
const PEEK_BYTES = 4096;

interface Header {
	format: number;
	key: CacheKey;
	layoutRows: number;
	frameMs: number;
	frames: number;
	durationMs: number;
}

function digest(value: string): string {
	return createHash("sha1").update(value).digest("hex");
}

function keyString(key: CacheKey): string {
	// Fixed field order, so the digest is stable across call sites.
	return JSON.stringify([
		key.source,
		key.size,
		key.mtimeMs,
		key.fps,
		key.widthPx,
		key.heightPx,
		key.columns,
		key.rows,
		key.cellWidthPx,
		key.cellHeightPx,
		key.fit,
	]);
}

/** Identifies the source file alone, so a re-encode of it can replace older geometries. */
function sourceTag(key: CacheKey): string {
	return digest(`${basename(key.source)}:${key.size}`).slice(0, 8);
}

export function cacheFilePath(dir: string, key: CacheKey): string {
	return join(dir, `${sourceTag(key)}-${digest(keyString(key)).slice(0, 16)}.seq`);
}

/** Read and validate a header without pulling in the frame data. */
function readHeader(buffer: Buffer, key: CacheKey): { header: Header; offset: number } | undefined {
	const magicBytes = Buffer.byteLength(MAGIC, "latin1");
	if (buffer.length < magicBytes + 4) return undefined;
	if (buffer.toString("latin1", 0, magicBytes) !== MAGIC) return undefined;
	const headerLength = buffer.readUInt32BE(magicBytes);
	const end = magicBytes + 4 + headerLength;
	if (end > buffer.length) return undefined;
	let header: Header;
	try {
		header = JSON.parse(buffer.toString("utf8", magicBytes + 4, end)) as Header;
	} catch {
		return undefined;
	}
	if (header.format !== FORMAT || keyString(header.key) !== keyString(key)) return undefined;
	return { header, offset: end };
}

/** Read exactly `length` bytes at `position`, or undefined when the file ends early. */
async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer | undefined> {
	const buffer = Buffer.alloc(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
		if (bytesRead <= 0) return undefined;
		filled += bytesRead;
	}
	return buffer;
}

function closeQuietly(handle: FileHandle | undefined): Promise<void> {
	if (!handle) return Promise.resolve();
	return handle.close().catch(() => {});
}

/** Whether a usable file for this key exists, without reading its frames. */
export async function hasCache(dir: string, key: CacheKey): Promise<boolean> {
	const file = cacheFilePath(dir, key);
	let handle: FileHandle | undefined;
	try {
		handle = await open(file, "r");
		const head = Buffer.alloc(PEEK_BYTES);
		const { bytesRead } = await handle.read(head, 0, PEEK_BYTES, 0);
		return readHeader(head.subarray(0, bytesRead), key) !== undefined;
	} catch {
		return false;
	} finally {
		await closeQuietly(handle);
	}
}

/**
 * The stored clip for this key, or undefined when it is missing, stale, or damaged.
 * Frames are read one at a time: a single 290MB read would hold the whole file as a
 * Buffer next to the 290MB of strings it decodes into, doubling the startup peak.
 */
export async function readCache(dir: string, key: CacheKey): Promise<CachedClip | undefined> {
	const file = cacheFilePath(dir, key);
	let handle: FileHandle | undefined;
	let frames: string[] | undefined;
	try {
		handle = await open(file, "r");
		const { size } = await handle.stat();
		const head = await readExact(handle, Math.min(PEEK_BYTES, size), 0);
		if (!head) return undefined;
		const decoded = readHeader(head, key);
		if (!decoded) return undefined;
		const { header } = decoded;
		let position = decoded.offset;
		const loaded: string[] = [];
		for (let index = 0; index < header.frames; index++) {
			const lengthBuffer = await readExact(handle, 4, position);
			if (!lengthBuffer) return undefined;
			position += 4;
			const length = lengthBuffer.readUInt32BE(0);
			const data = await readExact(handle, length, position);
			if (!data) return undefined;
			position += length;
			loaded.push(data.toString("utf8"));
		}
		// A truncated tail means the writer was interrupted; the file is not usable as is.
		if (position !== size) return undefined;
		frames = loaded;
		return {
			frames: loaded,
			layoutRows: header.layoutRows,
			frameMs: header.frameMs,
			durationMs: header.durationMs,
			bytes: size,
		};
	} catch {
		return undefined;
	} finally {
		await closeQuietly(handle);
		if (frames === undefined) await rm(file, { force: true }).catch(() => {});
	}
}

/** Drop older geometries of the same source; the cache keeps one file per clip. */
async function pruneSource(dir: string, key: CacheKey, keep: string): Promise<number> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return 0;
	}
	const tag = `${sourceTag(key)}-`;
	let removed = 0;
	for (const entry of entries) {
		if (!entry.startsWith(tag) || entry === keep) continue;
		try {
			await rm(join(dir, entry), { force: true });
			removed++;
		} catch {
			// A file we cannot remove only costs disk space.
		}
	}
	return removed;
}

/**
 * Write the clip for this key, replacing any older geometry of the same source.
 * Written to a temporary file first: a launch that reads the cache mid-write must
 * see either the previous file or the complete new one, never a half of either.
 */
export async function writeCache(
	dir: string,
	key: CacheKey,
	clip: { frames: string[]; layoutRows: number; frameMs: number },
): Promise<CacheWriteResult> {
	await mkdir(dir, { recursive: true });
	const target = cacheFilePath(dir, key);
	const replaced = await pruneSource(dir, key, basename(target));
	const header: Header = {
		format: FORMAT,
		key,
		layoutRows: clip.layoutRows,
		frameMs: clip.frameMs,
		frames: clip.frames.length,
		durationMs: clip.frames.length * clip.frameMs,
	};
	const headerBuffer = Buffer.from(JSON.stringify(header), "utf8");
	const magicBuffer = Buffer.from(MAGIC, "latin1");
	const lengthBuffer = Buffer.alloc(4);
	lengthBuffer.writeUInt32BE(headerBuffer.length, 0);
	const temp = `${target}.tmp`;
	const handle = await open(temp, "w");
	let bytes = 0;
	try {
		for (const buffer of [magicBuffer, lengthBuffer, headerBuffer]) {
			await handle.write(buffer);
			bytes += buffer.length;
		}
		for (const frame of clip.frames) {
			const data = Buffer.from(frame, "utf8");
			const size = Buffer.alloc(4);
			size.writeUInt32BE(data.length, 0);
			await handle.write(size);
			await handle.write(data);
			bytes += size.length + data.length;
		}
	} finally {
		await handle.close();
	}
	await rm(target, { force: true });
	await rename(temp, target);
	return { file: target, bytes, replaced };
}
