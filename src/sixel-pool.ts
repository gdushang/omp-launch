// omp-launch: SIXEL encode pool — workers stream each finished frame back as it is encoded.
import type { CellDimensions } from "@oh-my-pi/pi-tui";
import type { ImageBox } from "./window";

/** One message from a worker: a finished frame, the end of its batch, or a failure. */
export interface EncodeEvent {
	index?: number;
	sequence?: string;
	rows?: number;
	done?: boolean;
	error?: string;
}

export interface SixelPoolOptions {
	/** `sixel-worker.ts` module URL, resolved on the main thread. */
	url: URL;
	/** pi-tui module URL: a worker resolves imports against its own file, where pi-tui is absent. */
	piTui: string;
	frames: string[];
	size: ImageBox;
	cell: CellDimensions;
	workers: number;
	/** Frames that must be ready before playback starts; the rest keep arriving while it plays. */
	head: number;
}

/**
 * Splits the clip across workers and hands frames back one by one. Encoding every
 * frame up front is what turned the first seconds of the startup animation into a
 * blank screen; waiting only for {@link SixelPoolOptions.head} frames starts
 * playback ~5s earlier on a 1280×720 clip. Frames are dealt round-robin so the head
 * is spread over every worker instead of piling onto one, and they are addressed by
 * index, so a playhead that outruns the pool can repeat the newest ready frame
 * instead of stalling on a hole.
 */
export class SixelPool {
	readonly #count: number;
	readonly #sequences: Array<string | undefined>;
	readonly #workers: Worker[] = [];
	readonly #head: number;
	readonly #headReady: Promise<void>;
	readonly #finished: Promise<void>;
	#resolveHead: () => void;
	#resolveFinished: () => void;
	#ready = 0;
	#rows = 0;
	#alive = 0;
	#error: string | undefined;
	#closed = false;

	constructor(options: SixelPoolOptions) {
		const { url, piTui, frames, size, cell, workers } = options;
		this.#count = frames.length;
		this.#sequences = new Array<string | undefined>(frames.length);
		this.#head = Math.min(Math.max(0, options.head), frames.length);

		const head = Promise.withResolvers<void>();
		this.#headReady = head.promise;
		this.#resolveHead = head.resolve;
		const finished = Promise.withResolvers<void>();
		this.#finished = finished.promise;
		this.#resolveFinished = finished.resolve;

		const workerCount = Math.max(1, workers);
		const payload = {
			widthPx: size.widthPx,
			heightPx: size.heightPx,
			maxWidthCells: size.columns,
			maxHeightCells: size.rows,
			cell,
			piTui,
		};
		// Round-robin, not contiguous slices: with slices the head frames all land on the
		// first worker, so one slow worker (each pays a Bun worker start + a pi-tui import)
		// would delay playback by the whole head. Deal them out and every worker contributes
		// ~2 frames to the head.
		const buckets: Array<{ frames: string[]; indices: number[] }> = Array.from(
			{ length: workerCount },
			() => ({ frames: [], indices: [] }),
		);
		for (let index = 0; index < frames.length; index++) {
			const bucket = buckets[index % workerCount]!;
			bucket.frames.push(frames[index]!);
			bucket.indices.push(index);
		}
		for (const bucket of buckets) {
			if (bucket.frames.length === 0) continue;
			const worker = new Worker(url);
			this.#workers.push(worker);
			this.#alive++;
			worker.onmessage = (event: MessageEvent<EncodeEvent>) => {
				const data = event.data;
				if (data.done || data.error !== undefined) worker.terminate();
				this.#receive(data);
			};
			worker.onerror = (event: ErrorEvent) =>
				this.#close(`worker 启动失败：${event.message || "unknown"}`);
			worker.postMessage({ ...payload, frames: bucket.frames, indices: bucket.indices });
		}
		if (this.#alive === 0) {
			this.#resolveHead();
			this.#resolveFinished();
		}
	}

	/** Frames encoded contiguously from index 0; at least 1 once playback may start. */
	get ready(): number {
		return this.#ready;
	}

	/** Rows the encoder reported for a frame, or 0 before the first one arrives. */
	get rows(): number {
		return this.#rows;
	}

	/** Why the pool gave up; already-encoded frames stay usable. */
	get error(): string | undefined {
		return this.#error;
	}

	/** Encoded frame `index`, or undefined while its worker has not reached it yet. */
	sequence(index: number): string | undefined {
		return this.#sequences[index];
	}

	/** Resolves when {@link SixelPoolOptions.head} frames are ready, on failure, or on `close()`. */
	waitForHead(): Promise<void> {
		return this.#headReady;
	}

	/** Resolves once every worker has finished, failed, or been closed. */
	finished(): Promise<void> {
		return this.#finished;
	}

	/** Stop encoding; safe to call more than once and after every worker has finished. */
	close(): void {
		this.#close();
	}

	#receive(event: EncodeEvent): void {
		if (this.#closed) return;
		if (event.error !== undefined) {
			this.#close(event.error);
			return;
		}
		if (event.done) {
			this.#alive--;
			if (this.#alive <= 0) {
				this.#resolveHead();
				this.#resolveFinished();
			}
			return;
		}
		const { index, sequence } = event;
		if (index === undefined || sequence === undefined || index >= this.#count) return;
		this.#sequences[index] = sequence;
		if (this.#rows === 0 && event.rows) this.#rows = event.rows;
		while (this.#ready < this.#count && this.#sequences[this.#ready] !== undefined) this.#ready++;
		if (this.#ready >= this.#head) this.#resolveHead();
	}

	#close(reason?: string): void {
		if (this.#closed) return;
		this.#closed = true;
		if (reason !== undefined) this.#error = reason;
		for (const worker of this.#workers) worker.terminate();
		this.#workers.length = 0;
		this.#resolveHead();
		this.#resolveFinished();
	}
}
