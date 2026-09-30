// omp-launch: overlay component playing one animation stage; any key skips when allowed.
import { truncateToWidth, type Component } from "@oh-my-pi/pi-tui";

export type FrameRenderer = (elapsedMs: number, width: number) => readonly string[];

export interface LaunchStage {
	durationMs: number;
	frameMs: number;
	loop: number;
	render: FrameRenderer;
	/** Diagnostic label for logs: image | cache | notice | blocks. */
	label?: string;
	/**
	 * Ends the stage early when it returns true. A stage whose length is decided by work
	 * it does not own (a notice tracking a background encode) uses this instead of
	 * guessing a `durationMs` that will be wrong on a slower clip.
	 */
	complete?: () => boolean;
	/** Release work the stage still holds (an encode pool mid-clip) when it stops being shown. */
	dispose?: () => void;
}

export interface LaunchPlayerOptions {
	/** Optional pre-roll stage played while the main stage loads; omit to hold a blank screen. */
	intro?: LaunchStage;
	/** Stop waiting for the main stage after this long; with no intro this ends playback. */
	waitMaxMs: number;
	loadMain: () => Promise<LaunchStage | undefined>;
	/**
	 * Built when `loadMain` rejects. Without it a load failure leaves the player
	 * with nothing to show while the host still reports a fallback, and the
	 * rejection is swallowed without leaving a trace anywhere.
	 */
	fallback?: (error: unknown) => LaunchStage | undefined;
	allowSkip: boolean;
	requestRender: () => void;
	schedule: (callback: () => void, ms: number) => Timer;
	cancel: (timer: Timer) => void;
	/** Why playback ended (duration | wait | empty | skip | dispose), for the log. */
	trace?: (event: string, detail: Record<string, unknown>) => void;
	onDone: () => void;
}

/**
 * A plain key arrives as itself; everything the terminal sends on its own — focus and
 * mouse reports, replies to the startup probes (`CSI 14 t`, XTSMGRAPHICS) — arrives as
 * an escape sequence, and so do the arrow and function keys. Only the former ends the
 * animation: matching on the specific reports missed replies that start with a digit
 * and still cut the animation off whenever the window gained focus.
 */
const TERMINAL_SEQUENCE_RE = /^\x1b/;

export class LaunchPlayer implements Component {
	readonly #options: LaunchPlayerOptions;
	#stage: LaunchStage | undefined;
	#inIntro: boolean;
	#introStartedAt = performance.now();
	#waitStartedAt = performance.now();
	#mainStartedAt = 0;
	#cycle = 0;
	#main: LaunchStage | undefined;
	#mainResolved = false;
	#handle: Timer | undefined;
	#disposed = false;
	#finished = false;

	constructor(options: LaunchPlayerOptions) {
		this.#options = options;
		this.#stage = options.intro;
		this.#inIntro = options.intro !== undefined;
		options
			.loadMain()
			.then(stage => {
				this.#main = stage;
				this.#mainResolved = true;
			})
			.catch((error: unknown) => {
				this.#main = this.#options.fallback?.(error);
				this.#mainResolved = true;
			});
	}

	start(): void {
		const now = performance.now();
		this.#introStartedAt = now;
		this.#waitStartedAt = now;
		this.#options.requestRender();
		this.#arm();
	}

	#arm(): void {
		if (this.#disposed || this.#finished) return;
		this.#handle = this.#options.schedule(() => this.#advance(), this.#stage?.frameMs ?? 60);
	}

	/** Replace the shown stage and release what the previous one still held. */
	#swap(stage: LaunchStage | undefined): void {
		if (this.#stage === stage) return;
		this.#stage?.dispose?.();
		this.#stage = stage;
	}

	#advance(): void {
		if (this.#disposed || this.#finished) return;
		const now = performance.now();
		const stage = this.#stage;

		if (stage === undefined) {
			// No intro: hold blank until the main stage is ready.
			if (this.#mainResolved) {
				const next = this.#main;
				if (next === undefined) {
					this.#finish("empty");
					return;
				}
				this.#swap(next);
				this.#mainStartedAt = now;
			} else if (now - this.#waitStartedAt >= this.#options.waitMaxMs) {
				this.#finish("wait");
				return;
			}
		} else if (this.#inIntro) {
			if (now - this.#introStartedAt >= stage.durationMs) {
				if (this.#mainResolved) {
					const next = this.#main;
					if (next === undefined) {
						this.#finish("empty");
						return;
					}
					this.#inIntro = false;
					this.#swap(next);
					this.#mainStartedAt = now;
				} else if (now - this.#introStartedAt >= this.#options.waitMaxMs) {
					// The main stage never arrived: the intro becomes the whole animation.
					this.#mainResolved = true;
				} else {
					this.#introStartedAt = now;
				}
			}
		} else if (stage.complete?.() === true) {
			// The work this stage was waiting for is done: leave on the next tick so the
			// last frame (a 100% bar) is actually painted.
			this.#finish("settled");
			return;
		} else if (now - this.#mainStartedAt >= stage.durationMs) {
			this.#cycle++;
			if (this.#cycle >= stage.loop) {
				this.#finish("duration");
				return;
			}
			this.#mainStartedAt = now;
		}

		this.#options.requestRender();
		this.#arm();
	}

	#finish(reason: "duration" | "wait" | "empty" | "skip" | "settled"): void {
		if (this.#finished) return;
		this.#finished = true;
		if (this.#handle !== undefined) this.#options.cancel(this.#handle);
		this.#stage?.dispose?.();
		this.#options.trace?.("omp-launch: 播放结束", {
			reason,
			elapsedMs: Math.round(performance.now() - this.#elapsedBase()),
			cycles: this.#cycle,
			stage: this.#stage?.label ?? "none",
		});
		this.#options.onDone();
	}

	/** When the currently shown stage started: the intro until the main one takes over. */
	#elapsedBase(): number {
		return this.#inIntro || this.#mainStartedAt === 0 ? this.#introStartedAt : this.#mainStartedAt;
	}

	render(width: number): readonly string[] {
		const stage = this.#stage;
		if (stage === undefined) return [];
		const elapsed = performance.now() - (this.#inIntro ? this.#introStartedAt : this.#mainStartedAt);
		return stage.render(elapsed, width).map(line => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (!this.#options.allowSkip) return;
		// Wait until something is on screen: replies to the startup probes land in this
		// window too, and skipping on those ended the overlay before the main stage existed.
		if (!this.#mainResolved) return;
		// Focus changes, mouse motion and late query replies are not key presses; skipping on
		// them cut the animation off a few seconds in whenever the window gained focus.
		if (TERMINAL_SEQUENCE_RE.test(data)) return;
		this.#finish("skip");
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#handle !== undefined) this.#options.cancel(this.#handle);
		this.#stage?.dispose?.();
		// The host unmounting the overlay is only an interruption if playback had not ended.
		if (!this.#finished) {
			this.#options.trace?.("omp-launch: 播放中断", {
				elapsedMs: Math.round(performance.now() - this.#elapsedBase()),
				stage: this.#stage?.label ?? "none",
			});
		}
	}
}
