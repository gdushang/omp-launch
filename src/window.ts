// omp-launch: temporary terminal window resize so the video gets the largest possible cell grid.
import { getCellDimensions, type CellDimensions } from "@oh-my-pi/pi-tui";
import type { FitMode } from "./config";

export interface WindowSize {
	columns: number;
	rows: number;
}

export interface PixelLimits {
	widthPx: number;
	heightPx: number;
}

/** Used when the terminal does not answer the pixel-size query. */
const FALLBACK_MAX_COLUMNS = 240;
const FALLBACK_MAX_ROWS = 80;
const MIN_COLUMNS = 60;
const MIN_ROWS = 18;
const POLL_MS = 40;

export function currentWindow(): WindowSize {
	return {
		columns: Math.max(1, process.stdout.columns ?? 80),
		rows: Math.max(1, process.stdout.rows ?? 24),
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Cell pixel size derived from the window's own geometry (`CSI 14 t` pixels over
 * the reported columns/rows). Exact where omp's advertised default is not: on a
 * 1790x1040 window of 179x52 cells the fallback 9x18 estimate plans a 198-column
 * request that no screen can satisfy, so the resize is silently dropped.
 */
export function measureCell(size: WindowSize, pixels: PixelLimits | undefined): CellDimensions | undefined {
	if (!pixels || size.columns < 1 || size.rows < 1) return undefined;
	const widthPx = pixels.widthPx / size.columns;
	const heightPx = pixels.heightPx / size.rows;
	if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) return undefined;
	return { widthPx, heightPx };
}

/**
 * Largest grid whose pixel aspect ratio matches the video. With real pixel
 * limits the window is driven to the screen maximum, which is what sets the
 * half-block resolution (columns × rows×2 pixels). `measured` is the cell size
 * read off the live window; omit it to fall back to omp's estimate.
 */
export function planWindow(
	meta: { width: number; height: number },
	limits?: PixelLimits,
	measured?: CellDimensions,
): WindowSize {
	const cell = measured ?? getCellDimensions();
	const maxColumns = Math.max(
		MIN_COLUMNS,
		limits ? Math.floor(limits.widthPx / cell.widthPx) : FALLBACK_MAX_COLUMNS,
	);
	const maxRows = Math.max(MIN_ROWS, limits ? Math.floor(limits.heightPx / cell.heightPx) : FALLBACK_MAX_ROWS);
	const aspect = meta.width / meta.height;

	let rows = maxRows;
	let columns = Math.round((aspect * rows * cell.heightPx) / cell.widthPx);
	if (columns > maxColumns) {
		columns = maxColumns;
		rows = Math.round((columns * cell.widthPx) / (aspect * cell.heightPx));
	}
	if (columns < MIN_COLUMNS) {
		columns = Math.min(MIN_COLUMNS, maxColumns);
		rows = Math.round((columns * cell.widthPx) / (aspect * cell.heightPx));
	}
	return { columns: clamp(columns, MIN_COLUMNS, maxColumns), rows: clamp(rows, MIN_ROWS, maxRows) };
}

export interface ImageBox {
	/** Decoded (and SIXEL-encoded) pixel size; the only thing `maxPixels` caps. */
	widthPx: number;
	heightPx: number;
	/** Cells the picture occupies. Fitted to the whole window, never capped. */
	columns: number;
	rows: number;
}

/**
 * Geometry for the graphics path. Two independent halves:
 *
 * - **Display grid** — what the picture covers on screen. Always laid out by
 *   `fit` against the full window, so the animation fills the window whatever
 *   `maxPixels` says.
 * - **Render pixels** — the frame ffmpeg decodes, capped by `maxPixels`
 *   (0 = uncapped) and scaled to the display box's aspect ratio. A 480p buffer
 *   in a 1790x1007 window is upscaled by pi-tui/the terminal rather than drawn
 *   as a 480p-sized patch, which is why raising the cap only sharpens the
 *   picture — it never grows or shrinks it.
 *
 * `cell` must be the measured cell size: an emulator's true cell (1790px / 179
 * columns = 10px) is larger than the 9x18 estimate, and assuming the small one
 * leaves a needless margin.
 */
export function imageFrameSize(
	meta: { width: number; height: number },
	columns: number,
	rows: number,
	maxPixels: number,
	cell: CellDimensions,
	fit: FitMode,
): ImageBox {
	const boxWidthPx = Math.max(1, columns * cell.widthPx);
	const boxHeightPx = Math.max(1, rows * cell.heightPx);
	// cover hands ffmpeg the whole box and crops back to it; everything else
	// inscribes the source aspect ratio in the box (width first, height if it spills).
	let displayWidthPx = boxWidthPx;
	let displayHeightPx = boxHeightPx;
	if (fit !== "cover") {
		const aspect = meta.width / meta.height;
		displayHeightPx = Math.round(displayWidthPx / aspect);
		if (displayHeightPx > boxHeightPx) {
			displayHeightPx = boxHeightPx;
			displayWidthPx = Math.round(displayHeightPx * aspect);
		}
	}
	const displayColumns = Math.max(1, Math.min(columns, Math.round(displayWidthPx / cell.widthPx)));
	const displayRows = Math.max(1, Math.min(rows, Math.ceil(displayHeightPx / cell.heightPx)));

	let widthPx = displayWidthPx;
	let heightPx = displayHeightPx;
	if (maxPixels > 0 && widthPx * heightPx > maxPixels) {
		const scale = Math.sqrt(maxPixels / (widthPx * heightPx));
		widthPx = Math.max(1, Math.floor(widthPx * scale));
		heightPx = Math.max(1, Math.floor(heightPx * scale));
	}
	return { widthPx, heightPx, columns: displayColumns, rows: displayRows };
}

/** `CSI 8 ; rows ; cols t` — terminals that do not implement it simply ignore this. */
export function applyWindow(size: WindowSize): void {
	process.stdout.write(`\x1b[8;${size.rows};${size.columns}t`);
}

/** Wait until the terminal actually reports the requested grid (SIGWINCH updates stdout). */
export function waitForWindow(size: WindowSize, timeoutMs = 900): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const started = performance.now();
	const check = (): void => {
		const now = currentWindow();
		if (Math.abs(now.columns - size.columns) <= 4 && Math.abs(now.rows - size.rows) <= 4) {
			resolve(true);
			return;
		}
		if (performance.now() - started > timeoutMs) {
			resolve(false);
			return;
		}
		setTimeout(check, POLL_MS);
	};
	setTimeout(check, POLL_MS);
	return promise;
}
