// omp-launch: SIXEL encoding pool worker — encodes a batch of frames off the main thread.
import type { CellDimensions } from "@oh-my-pi/pi-tui";

interface EncodeJob {
	frames: string[];
	/** Clip position of each entry in `frames`: frames are dealt round-robin, not in order. */
	indices: number[];
	widthPx: number;
	heightPx: number;
	maxWidthCells: number;
	maxHeightCells: number;
	/** Main thread's measured cell size; this thread's pi-tui state starts at the 9x18 guess. */
	cell: CellDimensions;
	/**
	 * pi-tui module URL, resolved on the main thread. A worker resolves imports
	 * against its own file, where `@oh-my-pi/pi-tui` does not exist — it ships with
	 * the host omp, not with this extension — so the specifier has to arrive as an
	 * absolute URL and be imported dynamically.
	 */
	piTui: string;
}

// Worker global scope: the DOM lib types `self` as a window here, without postMessage.
const scope = self as unknown as {
	onmessage: ((event: MessageEvent<EncodeJob>) => void) | null;
	postMessage: (value: unknown) => void;
};

function describe(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

scope.onmessage = async event => {
	try {
		const { frames, indices, widthPx, heightPx, maxWidthCells, maxHeightCells, cell, piTui } = event.data;
		// Runtime-selected specifier: the URL is resolved by the main thread's module
		// graph, which the worker cannot see. A static import fails at startup instead.
		const tui = await import(piTui);
		tui.setTerminalImageProtocol(tui.ImageProtocol.Sixel);
		tui.setCellDimensions(cell);
		for (const [offset, base64] of frames.entries()) {
			const result = tui.renderImage(base64, { widthPx, heightPx }, { maxWidthCells, maxHeightCells });
			if (!result?.sequence) {
				scope.postMessage({ error: "renderImage 返回空（编码器未就绪或协议未启用）" });
				return;
			}
			// One frame per message: the main thread starts playback as soon as its
			// first frames exist instead of waiting out the whole batch.
			scope.postMessage({
				index: indices[offset] ?? offset,
				sequence: result.sequence,
				rows: result.rows,
			});
		}
		scope.postMessage({ done: true });
	} catch (error) {
		scope.postMessage({ error: describe(error) });
	}
};
