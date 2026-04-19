import { SAMPLE_RATE } from "./constants.ts";
import {
	computeBiquad,
	magnitudeDb,
	phaseRad,
	typeHasGain,
} from "./dsp/biquad.ts";
import type { Band } from "./main.ts";
import { measurementDbAt, targetDbAt } from "./measurements.ts";
import peqTemplate from "./peq.template.html?raw";
import { getLoadedPresetSnapshot, isBandChangedVsPreset, isEqEnabled } from "./state.ts";

/**
 * CONFIG & CONSTANTS
 */
const CONFIG = {
	minFreq: 20,
	maxFreq: 20000,
	minGain: -20,
	gainRange: 20,
	padding: 40,
};

// Insertion order drives the `<select>` dropdown order. Keep gainful types
// first (Peaking / shelves), then gainless filters.
const BAND_TYPE_LABELS: Record<string, string> = {
	PK: "Peaking",
	LSQ: "Low Shelf",
	HSQ: "High Shelf",
	HPQ: "High-pass",
	LPQ: "Low-pass",
	BPQ: "Band-pass",
	NO: "Notch",
};

// Read a CSS custom property from :root so canvas drawing tracks
// light/dark theme without a second source of truth.
function themeColor(name: string, fallback: string): string {
	const v = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
	return v || fallback;
}

/**
 * STATE MANAGEMENT
 */
let localBands: Band[] = [];
let inactiveBands: Band[] | null = null;
// Feature 7/8 — canvas-overlay toggles. Set on each `renderPEQ` call from
// the session-state values. Local cache avoids reaching into session on
// every frame of a drag.
let showDelta = false;
let showPhase = false;
// selectedIndex tracks a band by its *hardware slot* (band.index) so that
// re-sorting the display after a frequency edit keeps the same band
// highlighted, rather than jumping to whatever band is now at the old
// display position.
let selectedIndex: number | null = null;
let draggingIndex: number | null = null;
let onUpdateCallback:
	| ((index: number, key: string, value: number | string | boolean) => void)
	| null = null;
// Optional add/remove handlers — supplied by renderPEQ. When undefined the
// header's +/- buttons hide so the band-count UI can stay off for tests.
let onAddBandCallback: (() => void) | null = null;
let onRemoveBandCallback: (() => void) | null = null;
let onDeleteBandCallback: ((arrayIdx: number) => void) | null = null;
let getBandCountCapCallback: (() => { min: number; max: number }) | null = null;

// Feature 3 — solo/mute + ergonomic wins. `soloedIndex` points at a band's
// hardware slot (band.index) so sort shuffles don't drop solo. When solo
// engages we snapshot every band's enabled state so exiting solo restores
// exactly the prior state rather than blindly enabling all bands.
let soloedIndex: number | null = null;
let prevSoloEnabled: boolean[] | null = null;

// Drag-start state captured on mousedown. Used by shift-drag (mutate Q
// instead of freq/gain), the click-vs-drag discriminator, and the
// drag-off-canvas delete check on mouseup.
let dragStartX = 0;
let dragStartY = 0;
let dragStartQ = 1;
let dragMoved = false;
// Modifier keys captured at mousedown (for click-time decisions) and
// refreshed on each mousemove via the event's live `altKey` / `shiftKey`
// (so a user can press/release modifiers mid-drag to switch modes).
let dragAltAtStart = false;
let dragShiftAtStart = false;

// DOM refs
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let bandTable: HTMLElement | null = null;
let bandCountControls: {
	addBtn: HTMLButtonElement;
	removeBtn: HTMLButtonElement;
	countLabel: HTMLElement;
} | null = null;

// Cached per-band input refs. Indexed by the band's position in the sorted
// display list — NOT by `band.index` (hardware slot). Each ref closes over
// the originalIndex (position in the unsorted eqState array) so the update
// callback still targets the correct underlying state entry.
const cellRefs: Array<{
	type: HTMLSelectElement;
	gain: HTMLInputElement;
	freq: HTMLInputElement;
	q: HTMLInputElement;
	enable: HTMLInputElement;
	header: HTMLElement;
	typeLabel: HTMLElement;
	originalIndex: number;
}> = [];

// Fingerprint of the current sort — a comma-joined list of hardware indices
// in ascending-frequency order. Changes when a frequency edit moves a band
// past a neighbour; we rebuild the table DOM on change so labels stay in
// ascending order. Stored separately from cellRefs.length so a pure
// length-change rebuild doesn't depend on sort state.
let lastSortFingerprint = "";

type SortedView = Array<{ band: Band; originalIndex: number }>;

// Produce a stable ascending-frequency ordering with tie-break on original
// index so a spurious re-sort doesn't scramble equal-freq bands.
function sortedView(bands: Band[]): SortedView {
	return bands
		.map((band, originalIndex) => ({ band, originalIndex }))
		.sort(
			(a, b) =>
				a.band.freq - b.band.freq ||
				a.originalIndex - b.originalIndex,
		);
}

function sortFingerprint(view: SortedView): string {
	return view.map((v) => v.originalIndex).join(",");
}

/**
 * MATH & DSP (delegates to shared biquad module)
 */
function freqToX(freq: number, width: number) {
	const logMin = Math.log10(CONFIG.minFreq);
	const logMax = Math.log10(CONFIG.maxFreq);
	const logFreq = Math.log10(Math.max(freq, CONFIG.minFreq));
	return (
		CONFIG.padding +
		((logFreq - logMin) / (logMax - logMin)) * (width - 2 * CONFIG.padding)
	);
}

function xToFreq(x: number, width: number) {
	const logMin = Math.log10(CONFIG.minFreq);
	const logMax = Math.log10(CONFIG.maxFreq);
	const ratio = (x - CONFIG.padding) / (width - 2 * CONFIG.padding);
	return 10 ** (logMin + ratio * (logMax - logMin));
}

function gainToY(gain: number, height: number) {
	return height / 2 - (gain / CONFIG.gainRange) * (height / 2 - CONFIG.padding);
}

function yToGain(y: number, height: number) {
	return (-(y - height / 2) * CONFIG.gainRange) / (height / 2 - CONFIG.padding);
}

function getMagnitude(
	freq: number,
	coeffsList: ReturnType<typeof computeBiquad>[],
	sampleRate: number = SAMPLE_RATE,
) {
	let totalDb = 0;
	for (const c of coeffsList) totalDb += magnitudeDb(c, freq, sampleRate);
	return totalDb;
}

/**
 * CANVAS RENDERING
 */
export function resizeCanvas() {
	if (!canvas || !ctx) return;
	const parent = canvas.parentElement;
	if (!parent) return;

	const rect = canvas.getBoundingClientRect();
	const dpr = window.devicePixelRatio || 1;

	canvas.width = Math.round(rect.width * dpr);
	canvas.height = Math.round(rect.height * dpr);

	ctx.scale(dpr, dpr);

	(canvas as any).logicalWidth = rect.width;
	(canvas as any).logicalHeight = rect.height;

	draw();
}

function drawGrid(c: CanvasRenderingContext2D, width: number, height: number) {
	const fine = themeColor("--color-grid-fine", "#1f1f22");
	const zero = themeColor("--color-grid-zero", "#333338");
	const label = themeColor("--color-grid-label", "#5a5a5f");

	c.strokeStyle = fine;
	c.lineWidth = 1;
	c.font = "10px ui-monospace, monospace";
	c.fillStyle = label;
	c.textAlign = "right";

	for (let g = -CONFIG.gainRange; g <= CONFIG.gainRange; g += 10) {
		const y = gainToY(g, height);
		c.beginPath();
		c.moveTo(CONFIG.padding, y);
		c.lineTo(width - CONFIG.padding, y);
		c.stroke();
		if (g !== 0) c.fillText(`${g}`, CONFIG.padding - 5, y + 3);
	}

	const zeroY = gainToY(0, height);
	c.strokeStyle = zero;
	c.lineWidth = 1;
	c.beginPath();
	c.moveTo(CONFIG.padding, zeroY);
	c.lineTo(width - CONFIG.padding, zeroY);
	c.stroke();
	c.fillText("0", CONFIG.padding - 5, zeroY + 3);

	const freqs = [20, 30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
	c.strokeStyle = fine;
	c.lineWidth = 1;
	c.textAlign = "center";

	for (const f of freqs) {
		const x = freqToX(f, width);
		c.beginPath();
		c.moveTo(x, CONFIG.padding);
		c.lineTo(x, height - CONFIG.padding);
		c.stroke();
		const lbl = f >= 1000 ? `${f / 1000}k` : f.toString();
		c.fillText(lbl, x, height - CONFIG.padding + 16);
	}
}

function drawCurveFor(
	c: CanvasRenderingContext2D,
	width: number,
	height: number,
	bands: Band[],
	style: { stroke: string; lineWidth: number; shadowColor?: string },
) {
	const coeffs = bands.map((b) => computeBiquad(b, SAMPLE_RATE));
	const startX = CONFIG.padding;
	const endX = width - CONFIG.padding;

	c.beginPath();
	c.strokeStyle = style.stroke;
	c.lineWidth = style.lineWidth;
	c.shadowBlur = style.shadowColor ? 8 : 0;
	c.shadowColor = style.shadowColor ?? "transparent";

	for (let i = 0; i <= endX - startX; i++) {
		const x = startX + i;
		const freq = xToFreq(x, width);
		const totalGain = getMagnitude(freq, coeffs);
		const y = gainToY(totalGain, height);
		if (i === 0) c.moveTo(x, y);
		else c.lineTo(x, y);
	}
	c.stroke();
	c.shadowBlur = 0;
}

function drawMeasurement(
	c: CanvasRenderingContext2D,
	width: number,
	height: number,
	eqBands: Band[] | null,
	style: { stroke: string; lineWidth: number; shadowColor?: string },
) {
	const eqCoeffs = eqBands
		? eqBands.map((b) => computeBiquad(b, SAMPLE_RATE))
		: null;
	const startX = CONFIG.padding;
	const endX = width - CONFIG.padding;

	c.beginPath();
	c.strokeStyle = style.stroke;
	c.lineWidth = style.lineWidth;
	c.shadowBlur = style.shadowColor ? 8 : 0;
	c.shadowColor = style.shadowColor ?? "transparent";

	let started = false;
	for (let i = 0; i <= endX - startX; i++) {
		const x = startX + i;
		const freq = xToFreq(x, width);
		const frDb = measurementDbAt(freq);
		if (frDb === null) continue;
		const eqDb = eqCoeffs ? getMagnitude(freq, eqCoeffs) : 0;
		const y = gainToY(frDb + eqDb, height);
		if (!started) {
			c.moveTo(x, y);
			started = true;
		} else {
			c.lineTo(x, y);
		}
	}
	c.stroke();
	c.shadowBlur = 0;
}

// Wave 4 — Q-width indicator. Drop a faint vertical line from the zero
// axis to below the chart for each band; line length encodes Q (wider Q
// = shorter line, narrow Q = longer line). Small dot terminates it.
function drawQLines(
	c: CanvasRenderingContext2D,
	width: number,
	height: number,
) {
	const accent = themeColor("--color-accent", "#cf4863");
	const zeroY = gainToY(0, height);
	const footY = height - CONFIG.padding + 4;
	c.strokeStyle = accent;
	c.globalAlpha = 0.5;
	c.lineWidth = 1.5;
	for (const band of localBands) {
		if (!band.enabled) continue;
		const x = freqToX(band.freq, width);
		// Q of 0.1 → full line, Q of 10 → tiny stub. Map log(Q) → 0..1.
		const qNorm = Math.min(1, Math.max(0, 1 - Math.log10(band.q) / 1.3));
		const endY = zeroY + (footY - zeroY) * qNorm;
		c.beginPath();
		c.moveTo(x, zeroY);
		c.lineTo(x, endY);
		c.stroke();

		c.globalAlpha = 0.85;
		c.fillStyle = accent;
		c.beginPath();
		c.arc(x, endY, 2.5, 0, 2 * Math.PI);
		c.fill();
		c.globalAlpha = 0.5;
	}
	c.globalAlpha = 1;
}

// Draw the loaded target curve (separate from measurement) as a dashed
// goal line. Color reads from the theme so it shifts between modes.
function drawTarget(
	c: CanvasRenderingContext2D,
	width: number,
	height: number,
) {
	const startX = CONFIG.padding;
	const endX = width - CONFIG.padding;
	c.save();
	c.beginPath();
	c.strokeStyle = themeColor("--color-target", "#5eb8c4");
	c.lineWidth = 2;
	c.setLineDash([6, 4]);
	let started = false;
	for (let i = 0; i <= endX - startX; i++) {
		const x = startX + i;
		const freq = xToFreq(x, width);
		const db = targetDbAt(freq);
		if (db === null) continue;
		const y = gainToY(db, height);
		if (!started) {
			c.moveTo(x, y);
			started = true;
		} else {
			c.lineTo(x, y);
		}
	}
	c.stroke();
	c.restore();
}

function drawCurve(c: CanvasRenderingContext2D, width: number, height: number) {
	const accent = themeColor("--color-accent", "#cf4863");
	const inactive = themeColor("--color-curve-inactive", "rgba(220,220,225,0.16)");
	const measurement = themeColor("--color-measurement", "#e5b850");
	const measurementDim = themeColor(
		"--color-measurement-dim",
		"rgba(229,184,80,0.3)",
	);

	const bypassed = !isEqEnabled();

	// Target curve — dashed goal line (if loaded).
	drawTarget(c, width, height);

	// Raw measurement (dim).
	drawMeasurement(c, width, height, null, {
		stroke: measurementDim,
		lineWidth: 2,
	});
	// Predicted FR-after-EQ. Bypassed → show the raw measurement only by
	// passing null so the EQ contribution is zeroed.
	drawMeasurement(c, width, height, bypassed ? null : localBands, {
		stroke: measurement,
		lineWidth: 2,
	});

	// Inactive slot curve.
	if (inactiveBands) {
		drawCurveFor(c, width, height, inactiveBands, {
			stroke: inactive,
			lineWidth: 1.5,
		});
	}
	if (bypassed) {
		// Bypassed: draw the EQ curve in a muted color so the user can still
		// see what their tuning would do, plus a subtle horizontal line at
		// 0 dB indicating the effective output.
		drawCurveFor(c, width, height, localBands, {
			stroke: inactive,
			lineWidth: 1.5,
		});
		const zeroY = gainToY(0, height);
		c.save();
		c.strokeStyle = inactive;
		c.setLineDash([4, 4]);
		c.lineWidth = 1;
		c.beginPath();
		c.moveTo(CONFIG.padding, zeroY);
		c.lineTo(width - CONFIG.padding, zeroY);
		c.stroke();
		c.restore();
	} else {
		// Active slot curve — the softened red hero line.
		drawCurveFor(c, width, height, localBands, {
			stroke: accent,
			lineWidth: 2.5,
			shadowColor: "rgba(207, 72, 99, 0.25)",
		});
	}
}

// Feature 7 — delta line (active − inactive) in dB. Scaled so ±10 dB maps
// to ±20% of the chart height: drawn relative to the 0 dB axis to read as
// a "delta indicator" rather than competing with the main EQ curve.
function drawDelta(
	c: CanvasRenderingContext2D,
	width: number,
	height: number,
) {
	if (!inactiveBands) return;
	const accent = themeColor("--color-delta", "#8e7cc3");
	const zeroY = gainToY(0, height);
	const chartH = height - 2 * CONFIG.padding;
	// ±10 dB → ±20% of chart height, so 1 dB ≈ 2% of chart height in pixels.
	const dbToPx = (chartH * 0.2) / 10;
	const activeCoeffs = localBands.map((b) => computeBiquad(b, SAMPLE_RATE));
	const inactiveCoeffs = inactiveBands.map((b) => computeBiquad(b, SAMPLE_RATE));
	const startX = CONFIG.padding;
	const endX = width - CONFIG.padding;
	c.save();
	c.beginPath();
	c.strokeStyle = accent;
	c.lineWidth = 1;
	for (let i = 0; i <= endX - startX; i++) {
		const x = startX + i;
		const freq = xToFreq(x, width);
		const delta = getMagnitude(freq, activeCoeffs) - getMagnitude(freq, inactiveCoeffs);
		const clampedDelta = Math.max(-20, Math.min(20, delta));
		const y = zeroY - clampedDelta * dbToPx;
		if (i === 0) c.moveTo(x, y);
		else c.lineTo(x, y);
	}
	c.stroke();
	c.restore();
}

// Feature 8 — summed phase response. Walks pixel columns, sums per-band
// phase, unwraps left-to-right so adjacent columns don't jump by 2π, and
// maps ±π to ±0.5 of the pixel height around the canvas vertical middle.
function drawPhase(
	c: CanvasRenderingContext2D,
	width: number,
	height: number,
) {
	const enabled = localBands.filter((b) => b.enabled);
	const coeffs = enabled.map((b) => computeBiquad(b, SAMPLE_RATE));
	const startX = CONFIG.padding;
	const endX = width - CONFIG.padding;
	const midY = height / 2;
	const halfH = height / 2 - CONFIG.padding;
	const color = themeColor("--color-phase", "#7ac7a8");

	c.save();
	c.beginPath();
	c.strokeStyle = color;
	c.lineWidth = 1.5;
	c.setLineDash([5, 4]);

	let last: number | null = null;
	for (let i = 0; i <= endX - startX; i++) {
		const x = startX + i;
		const freq = xToFreq(x, width);
		let p = 0;
		for (const co of coeffs) p += phaseRad(co, freq, SAMPLE_RATE);
		if (last !== null) {
			// Minimum-distance unwrap: pick the 2π multiple that keeps us
			// closest to the previous column's value. Prevents the jump
			// from appearing when per-band phases roll past ±π.
			const k = Math.round((last - p) / (2 * Math.PI));
			p += k * 2 * Math.PI;
		}
		last = p;
		// Clamp to ±π for display so large unwrapped values don't run off
		// the chart. Users reading a second-order EQ rarely need > ±π; at
		// the extreme we cap so the line stays visible.
		const clamped = Math.max(-Math.PI, Math.min(Math.PI, p));
		const y = midY - (clamped / Math.PI) * halfH;
		if (i === 0) c.moveTo(x, y);
		else c.lineTo(x, y);
	}
	c.stroke();
	c.restore();
}

// Feature 8 — right-side "±π" scale labels when phase is on. Drawn so
// users can read the phase scale independently of the dB axis on the
// left. Keep small and dim so they don't steal attention.
function drawPhaseScale(
	c: CanvasRenderingContext2D,
	width: number,
	height: number,
) {
	const label = themeColor("--color-grid-label", "#5a5a5f");
	c.save();
	c.fillStyle = label;
	c.font = "10px ui-monospace, monospace";
	c.textAlign = "left";
	const rightX = width - CONFIG.padding + 6;
	c.fillText("+π", rightX, CONFIG.padding + 4);
	c.fillText("−π", rightX, height - CONFIG.padding + 2);
	c.restore();
}

function drawHandles(
	c: CanvasRenderingContext2D,
	width: number,
	height: number,
) {
	const accent = themeColor("--color-accent", "#e11d48");
	const bandFill = themeColor("--color-band-fill", "#1e2844");
	const bandNumber = themeColor("--color-band-number", "#f4f5f8");
	const bandRing = themeColor("--color-band-ring", "rgba(255,255,255,0.35)");
	const surfaceDisabled = themeColor("--color-surface-3", "#2a2a2f");
	const text3 = themeColor("--color-text-3", "#5a5a5f");

	// Bypassed: band circles still draw (so drag-editing remains possible)
	// but de-emphasized at 0.45 alpha so the canvas reads as neutral.
	const bypassed = !isEqEnabled();
	const hasPresetSnapshot = getLoadedPresetSnapshot() !== null;
	c.save();
	if (bypassed) c.globalAlpha = 0.45;

	// Handle numbers follow the sorted display order so they match the
	// tabular editor's "Band N" labels. Lowest-freq band is #1.
	const view = sortedView(localBands);
	view.forEach(({ band }, sortedPos) => {
		const x = freqToX(band.freq, width);
		const y = gainToY(band.gain, height);
		const isSelected = band.index === selectedIndex;
		const isDisabled = !band.enabled;
		const r = isSelected ? 13 : 11;

		// Subtle outer ring — 1.5px halo around the fill circle.
		c.beginPath();
		c.arc(x, y, r + 1.5, 0, 2 * Math.PI);
		c.strokeStyle = bandRing;
		c.lineWidth = 1.5;
		c.stroke();

		// Fill circle — dark navy (light navy-tint on light theme).
		c.beginPath();
		c.arc(x, y, r, 0, 2 * Math.PI);
		c.fillStyle = isDisabled ? surfaceDisabled : bandFill;
		c.strokeStyle = isSelected ? accent : bandRing;
		c.lineWidth = isSelected ? 2 : 1;
		c.fill();
		c.stroke();

		// Number — white on dark, navy on light (via token).
		c.fillStyle = isDisabled ? text3 : bandNumber;
		c.font = "11px ui-monospace, monospace";
		c.textAlign = "center";
		c.textBaseline = "middle";
		c.fillText(String(sortedPos + 1), x, y + 0.5);

		// Feature 3 — soloed band gets a thin accent ring outside the
		// standard halo so it reads as "the one that matters".
		if (band.index === soloedIndex) {
			c.beginPath();
			c.arc(x, y, r + 5, 0, 2 * Math.PI);
			c.strokeStyle = accent;
			c.lineWidth = 2;
			c.stroke();
		}

		// Feature 4 — "changed vs preset" indicator. Dot sits just inside
		// the halo ring (offset r*0.6) so it stays visible for bands at
		// canvas extremes. Skipped entirely when no preset is loaded.
		if (hasPresetSnapshot && isBandChangedVsPreset(band.index)) {
			c.save();
			c.globalAlpha = 0.7;
			c.fillStyle = accent;
			c.beginPath();
			c.arc(x + r * 0.6, y - r * 0.6, 3, 0, 2 * Math.PI);
			c.fill();
			c.restore();
		}
	});
	c.textBaseline = "alphabetic";
	c.restore();
}

function drawLegend(
	c: CanvasRenderingContext2D,
	width: number,
	_height: number,
) {
	const accent = themeColor("--color-accent", "#cf4863");
	const inactiveCol = themeColor("--color-curve-inactive", "rgba(220,220,225,0.16)");
	const measurement = themeColor("--color-measurement", "#e5b850");
	const target = themeColor("--color-target", "#5eb8c4");
	const plateBg = themeColor("--color-legend-bg", "rgba(17,17,19,0.78)");
	const plateBorder = themeColor("--color-legend-border", "#26262b");
	const plateText = themeColor("--color-legend-text", "#b0b0b5");

	const deltaCol = themeColor("--color-delta", "#8e7cc3");
	const phaseCol = themeColor("--color-phase", "#7ac7a8");
	const items: Array<{ label: string; color: string; dashed?: boolean }> = [
		{ label: `EQ (${inactiveBands ? "active" : "slot A"})`, color: accent },
	];
	if (inactiveBands) {
		items.push({ label: "EQ (inactive)", color: inactiveCol });
	}
	if (measurementDbAt(1000) !== null) {
		items.push({ label: "FR + EQ", color: measurement });
	}
	if (targetDbAt(1000) !== null) {
		items.push({ label: "Target", color: target, dashed: true });
	}
	if (showDelta && inactiveBands) {
		items.push({ label: "Δ (A − B)", color: deltaCol });
	}
	if (showPhase) {
		items.push({ label: "Phase (rad)", color: phaseCol, dashed: true });
	}
	if (items.length < 2) return;

	c.save();
	c.font = "10px ui-monospace, monospace";
	c.textAlign = "left";
	c.textBaseline = "middle";
	const padX = 10;
	const padY = 8;
	const rowH = 14;
	const x = width - CONFIG.padding - 140;
	let y = CONFIG.padding + padY;

	c.fillStyle = plateBg;
	c.strokeStyle = plateBorder;
	c.lineWidth = 1;
	const w = 132;
	const h = items.length * rowH + padY * 2;
	c.beginPath();
	c.rect(x, y - padY, w, h);
	c.fill();
	c.stroke();

	for (const item of items) {
		c.strokeStyle = item.color;
		c.lineWidth = 2;
		c.setLineDash(item.dashed ? [4, 3] : []);
		c.beginPath();
		c.moveTo(x + padX, y + rowH / 2 - padY);
		c.lineTo(x + padX + 18, y + rowH / 2 - padY);
		c.stroke();
		c.setLineDash([]);
		c.fillStyle = plateText;
		c.fillText(item.label, x + padX + 24, y + rowH / 2 - padY);
		y += rowH;
	}
	c.restore();
}

function draw() {
	if (!canvas || !ctx) return;
	const width = (canvas as any).logicalWidth || canvas.width;
	const height = (canvas as any).logicalHeight || canvas.height;

	ctx.clearRect(0, 0, canvas.width, canvas.height);
	drawGrid(ctx, width, height);
	drawQLines(ctx, width, height);
	drawCurve(ctx, width, height);
	if (showDelta) drawDelta(ctx, width, height);
	if (showPhase) {
		drawPhase(ctx, width, height);
		drawPhaseScale(ctx, width, height);
	}
	drawHandles(ctx, width, height);
	drawLegend(ctx, width, height);
}

/**
 * TABULAR EDITOR — replaces the legacy band-list + edit-form sidebar.
 *
 * Iterates a frequency-ascending sorted view of `bands`, but keeps a handle
 * back to each band's `originalIndex` (position in the unsorted eqState
 * array) so update callbacks mutate the right slot. The hardware slot ID
 * (`band.index`) is NOT touched — it's load-bearing for sync packets.
 */
function buildBandTable(table: HTMLElement, bands: Band[]) {
	table.replaceChildren();
	cellRefs.length = 0;

	const view = sortedView(bands);
	lastSortFingerprint = sortFingerprint(view);

	const columns = `grid-template-columns: 44px repeat(${view.length}, minmax(68px, 1fr));`;
	const grid = document.createElement("div");
	grid.className = "grid gap-x-1.5 gap-y-0.5 items-center";
	grid.setAttribute("style", columns);

	// Header row — band number, type label, and an enable-power toggle.
	grid.appendChild(rowLabel(""));
	view.forEach(({ band, originalIndex }, sortedPos) => {
		const h = document.createElement("div");
		h.className = "flex flex-col items-center gap-0 py-0.5 cursor-pointer";
		h.dataset.band = String(sortedPos);
		h.dataset.originalIndex = String(originalIndex);

		const typeLabel = document.createElement("div");
		typeLabel.className = "text-[9px] uppercase tracking-wider text-text-3 font-mono";
		typeLabel.textContent = BAND_TYPE_LABELS[band.type] ?? "Peaking";

		const bandRow = document.createElement("div");
		bandRow.className = "flex items-center gap-1";

		const bandNum = document.createElement("span");
		bandNum.className = "text-[10px] font-mono text-text-2";
		bandNum.textContent = `Band ${sortedPos + 1}`;

		const enable = document.createElement("input");
		enable.type = "checkbox";
		enable.checked = band.enabled;
		enable.className = "h-2.5 w-2.5 accent-accent cursor-pointer";
		enable.title = "Enable / disable this band";
		enable.addEventListener("change", (e) => {
			e.stopPropagation();
			onUpdateCallback?.(originalIndex, "enabled", enable.checked);
			draw();
		});

		bandRow.append(bandNum, enable);
		h.append(typeLabel, bandRow);
		h.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).tagName !== "INPUT") selectBand(band.index);
		});
		grid.appendChild(h);

		cellRefs[sortedPos] = {
			type: null as unknown as HTMLSelectElement,
			gain: null as unknown as HTMLInputElement,
			freq: null as unknown as HTMLInputElement,
			q: null as unknown as HTMLInputElement,
			enable,
			header: h,
			typeLabel,
			originalIndex,
		};
	});

	// TYPE row
	grid.appendChild(rowLabel("Type"));
	view.forEach(({ band, originalIndex }, sortedPos) => {
		const sel = document.createElement("select");
		sel.className =
			"bg-transparent rounded text-[10px] font-mono text-text-1 px-1 py-0.5 border border-transparent hover:border-border focus:outline-none focus:border-accent";
		for (const [code, label] of Object.entries(BAND_TYPE_LABELS)) {
			const opt = document.createElement("option");
			opt.value = code;
			opt.textContent = label;
			sel.appendChild(opt);
		}
		sel.value = band.type;
		sel.addEventListener("change", () => {
			onUpdateCallback?.(originalIndex, "type", sel.value);
			if (cellRefs[sortedPos]) {
				cellRefs[sortedPos].typeLabel.textContent =
					BAND_TYPE_LABELS[sel.value] ?? "Peaking";
				// Live-swap the gain cell between an editable input and the
				// muted em-dash placeholder when toggling to/from a gainless
				// type. Row layout stays stable because we flip the input's
				// visibility in place rather than re-rendering the DOM.
				paintGainCell(cellRefs[sortedPos].gain, sel.value, band.gain);
			}
			draw();
		});
		grid.appendChild(sel);
		cellRefs[sortedPos].type = sel;
	});

	// GAIN row — gainless types (HP/LP/NO/BP) render a muted em-dash via
	// paintGainCell while keeping the input element so the DOM grid is
	// stable. The input stays disabled for those types so the user can
	// see the row layout without accidentally editing.
	grid.appendChild(rowLabel("Gain"));
	view.forEach(({ band, originalIndex }, sortedPos) => {
		const inp = numericInput(formatGain(band.gain), -20, 20, 0.1);
		inp.addEventListener("input", () => {
			// Gainless types ignore the input (it's disabled anyway, but
			// a programmatic .value change shouldn't bleed into state).
			if (!typeHasGain(inp.dataset.bandType ?? "PK")) return;
			const v = Number(inp.value);
			if (Number.isFinite(v)) {
				onUpdateCallback?.(originalIndex, "gain", v);
				draw();
			}
		});
		grid.appendChild(inp);
		cellRefs[sortedPos].gain = inp;
		paintGainCell(inp, band.type, band.gain);
	});

	// FREQ row — edits flow into state on `input`, but we only re-sort the
	// display on blur (`change`). Re-sorting per keystroke is jarring when
	// the user is still typing (e.g. typing "500" transiently parses as
	// "5" → "50" → "500" and the band would hop across the chart each time).
	// The blur handler's sole job is to force a sort-order rebuild via
	// renderPEQ's fingerprint check — no state mutation, since `input`
	// already committed the final value.
	grid.appendChild(rowLabel("Freq"));
	view.forEach(({ band, originalIndex }, sortedPos) => {
		const inp = numericInput(String(Math.round(band.freq)), 10, 24000, 1);
		inp.addEventListener("input", () => {
			const v = Number(inp.value);
			if (Number.isFinite(v) && v > 0) {
				onUpdateCallback?.(originalIndex, "freq", v);
				draw();
			}
		});
		// On blur: force a table rebuild if the sort has shifted. No state
		// mutation — `input` already pushed the value. This handler just
		// unblocks the fingerprint-based rebuild that `input` deliberately
		// skipped (see renderPEQ's `midInteraction` gate).
		inp.addEventListener("blur", () => {
			if (!bandTable) return;
			const currentFingerprint = sortFingerprint(sortedView(localBands));
			if (currentFingerprint !== lastSortFingerprint) {
				buildBandTable(bandTable, localBands);
			}
			draw();
		});
		grid.appendChild(inp);
		cellRefs[sortedPos].freq = inp;
	});

	// Q row
	grid.appendChild(rowLabel("Q"));
	view.forEach(({ band, originalIndex }, sortedPos) => {
		const inp = numericInput(formatQ(band.q), 0.1, 10, 0.01);
		inp.addEventListener("input", () => {
			const v = Number(inp.value);
			if (Number.isFinite(v) && v > 0) {
				onUpdateCallback?.(originalIndex, "q", v);
				draw();
			}
		});
		grid.appendChild(inp);
		cellRefs[sortedPos].q = inp;
	});

	table.appendChild(grid);
}

// Paint the gain input for a band. Gainless types render a muted em-dash
// and disable the input; gainful types restore the numeric value. Stored
// `dataset.bandType` is read by the input handler to skip writes while a
// gainless type is active.
function paintGainCell(inp: HTMLInputElement, type: string, gain: number) {
	inp.dataset.bandType = type;
	if (typeHasGain(type)) {
		inp.disabled = false;
		inp.classList.remove("gain-cell-dash");
		inp.value = formatGain(gain);
	} else {
		inp.disabled = true;
		inp.classList.add("gain-cell-dash");
		inp.value = "—";
	}
}

// Display helpers — strip trailing zeros so "12.0" reads as "12".
function formatGain(v: number): string {
	return parseFloat(v.toFixed(1)).toString();
}
function formatQ(v: number): string {
	return parseFloat(v.toFixed(2)).toString();
}

function rowLabel(text: string): HTMLElement {
	const d = document.createElement("div");
	d.className = "text-[10px] uppercase tracking-wider text-text-3 font-mono";
	d.textContent = text;
	return d;
}

function numericInput(
	value: string,
	min: number,
	max: number,
	step: number,
): HTMLInputElement {
	const inp = document.createElement("input");
	inp.type = "number";
	inp.value = value;
	inp.min = String(min);
	inp.max = String(max);
	inp.step = String(step);
	inp.className = "num-input";
	return inp;
}

// Push current band values back into the table without rebuilding DOM.
// Skips the input currently holding focus so typing isn't clobbered.
//
// Iterates in sorted-display order. Each cellRef carries the originalIndex
// of the underlying eqState slot, so looking up `bands[refs.originalIndex]`
// yields the correct live band regardless of table position.
function syncBandTable(bands: Band[]) {
	const focused = document.activeElement;
	for (let i = 0; i < cellRefs.length; i++) {
		const refs = cellRefs[i];
		const b = bands[refs.originalIndex];
		if (!refs || !b) continue;
		if (focused !== refs.type && refs.type.value !== b.type) {
			refs.type.value = b.type;
		}
		if (focused !== refs.gain) paintGainCell(refs.gain, b.type, b.gain);
		if (focused !== refs.freq) refs.freq.value = String(Math.round(b.freq));
		if (focused !== refs.q) refs.q.value = formatQ(b.q);
		refs.enable.checked = b.enabled;
		refs.typeLabel.textContent = BAND_TYPE_LABELS[b.type] ?? "Peaking";
		refs.header.classList.toggle("text-accent", b.index === selectedIndex);
	}
}

// selectedIndex tracks the hardware slot (band.index) so a freq edit that
// re-sorts the display doesn't drop the highlight.
function selectBand(hardwareIndex: number) {
	selectedIndex = hardwareIndex;
	syncBandTable(localBands);
	draw();
}

/**
 * PUBLIC API
 */
export interface RenderPEQOptions {
	inactiveBands?: Band[] | null;
	// Optional add/remove-band wiring. All three must be provided together
	// for the +/- header controls to appear. The cap callback returns the
	// current min/max band count (device-connected vs lab-mode differs).
	onAddBand?: () => void;
	onRemoveBand?: () => void;
	getBandCountCap?: () => { min: number; max: number };
	// Feature 3 — drag-off-canvas delete. Called with the array position
	// (not hardware slot) of the band that was dragged past the canvas
	// bounds. The caller handles snapshot + removal + rerender.
	onDeleteBand?: (arrayIdx: number) => void;
	// Feature 7 — render the delta (active − inactive) line in dB.
	showDelta?: boolean;
	// Feature 8 — render the summed-phase response.
	showPhase?: boolean;
}

export function renderPEQ(
	container: HTMLElement,
	bands: Band[],
	updateCallback: (index: number, key: string, value: any) => void,
	options: RenderPEQOptions = {},
) {
	if (!container) return;

	const isFirstRender = !container.querySelector("#peq-root");
	localBands = bands;
	onUpdateCallback = updateCallback;
	inactiveBands = options.inactiveBands ?? null;
	onAddBandCallback = options.onAddBand ?? null;
	onRemoveBandCallback = options.onRemoveBand ?? null;
	onDeleteBandCallback = options.onDeleteBand ?? null;
	getBandCountCapCallback = options.getBandCountCap ?? null;
	showDelta = options.showDelta ?? false;
	showPhase = options.showPhase ?? false;

	if (isFirstRender) {
		const parsed = new DOMParser().parseFromString(peqTemplate, "text/html");
		container.replaceChildren(...Array.from(parsed.body.children));

		canvas = container.querySelector("#eqCanvas");
		ctx = canvas?.getContext("2d") || null;
		bandTable = container.querySelector("#bandTable");

		const editorBar = container.querySelector<HTMLElement>("#bandEditorHeader");
		if (editorBar) bandCountControls = buildBandCountControls(editorBar);

		const resizeObserver = new ResizeObserver(() => resizeCanvas());
		if (canvas?.parentElement) resizeObserver.observe(canvas.parentElement);
		resizeCanvas();

		if (canvas) wireCanvasInteraction(canvas);
	}

	if (bandTable) {
		// Rebuild on length change OR on sort order change (a freq edit moved
		// a band past a neighbour). Otherwise just push current values into
		// the existing inputs.
		//
		// EXCEPT: skip the sort-order rebuild while the user is mid-interaction
		// (typing in a freq input, or dragging a handle on the canvas). A
		// rebuild would blow away focus on keystroke, and rebuilding N times
		// per mousemove during a drag is wasteful. The drag-end and blur
		// paths both re-render after settle, at which point the fingerprint
		// check fires cleanly.
		const currentFingerprint = sortFingerprint(sortedView(bands));
		const focused = document.activeElement;
		const freqInputFocused = cellRefs.some(
			(r) => r?.freq === focused,
		);
		const midInteraction = freqInputFocused || draggingIndex !== null;
		const needsRebuild =
			cellRefs.length !== bands.length ||
			(currentFingerprint !== lastSortFingerprint && !midInteraction);
		if (needsRebuild) {
			buildBandTable(bandTable, bands);
		} else {
			syncBandTable(bands);
		}
	}
	syncBandCountControls();
	draw();
}

// Header controls — "+ Add band" / "− Remove" + band count label. Inserted
// into the static band-editor header slot so existing layout stays intact.
function buildBandCountControls(host: HTMLElement): {
	addBtn: HTMLButtonElement;
	removeBtn: HTMLButtonElement;
	countLabel: HTMLElement;
} {
	host.replaceChildren();
	host.className =
		"flex items-center justify-end gap-2 px-4 pt-2 pb-1";

	const countLabel = document.createElement("span");
	countLabel.className =
		"text-[10px] font-mono uppercase tracking-wider text-text-3";
	host.appendChild(countLabel);

	const removeBtn = document.createElement("button");
	removeBtn.type = "button";
	removeBtn.className = "btn-outline";
	removeBtn.textContent = "− Remove";
	removeBtn.title = "Remove the selected band (or the highest-frequency one)";
	removeBtn.addEventListener("click", () => onRemoveBandCallback?.());

	const addBtn = document.createElement("button");
	addBtn.type = "button";
	addBtn.className = "btn-outline";
	addBtn.textContent = "+ Add band";
	addBtn.title = "Append a new band";
	addBtn.addEventListener("click", () => onAddBandCallback?.());

	host.append(removeBtn, addBtn);
	return { addBtn, removeBtn, countLabel };
}

function syncBandCountControls() {
	if (!bandCountControls) return;
	const hasAddRemove = !!(onAddBandCallback && onRemoveBandCallback);
	bandCountControls.addBtn.hidden = !hasAddRemove;
	bandCountControls.removeBtn.hidden = !hasAddRemove;
	if (!hasAddRemove) {
		bandCountControls.countLabel.textContent = "";
		return;
	}
	const cap = getBandCountCapCallback?.() ?? { min: 1, max: 20 };
	const n = localBands.length;
	bandCountControls.countLabel.textContent = `${n} / ${cap.max} bands`;
	bandCountControls.addBtn.disabled = n >= cap.max;
	bandCountControls.removeBtn.disabled = n <= cap.min;
}

// Pixel-delta threshold below which a mouseup is treated as a click (not
// a drag). Chosen to feel forgiving for touchpads without accidentally
// eating a short-but-real drag.
const CLICK_DRAG_THRESHOLD_PX = 3;

// Feature 3 — engage solo on the given hardware slot. Snapshots the
// enabled state first so exiting restores exactly what was there. All
// mutations route through the update callback so history + persistence
// capture the toggle, matching the plan's "no direct eqState writes".
function enterSolo(hardwareIndex: number) {
	prevSoloEnabled = localBands.map((b) => b.enabled);
	soloedIndex = hardwareIndex;
	localBands.forEach((b, arrayIdx) => {
		const shouldBeEnabled = b.index === hardwareIndex;
		if (b.enabled !== shouldBeEnabled) {
			handleUpdate(arrayIdx, "enabled", shouldBeEnabled);
		}
	});
}

// Restore the enabled-state snapshot taken when solo engaged. Safe to call
// when solo isn't active (no-op). After restore, clears the snapshot.
function exitSolo() {
	if (prevSoloEnabled) {
		localBands.forEach((b, arrayIdx) => {
			const target = prevSoloEnabled?.[arrayIdx] ?? b.enabled;
			if (b.enabled !== target) {
				handleUpdate(arrayIdx, "enabled", target);
			}
		});
	}
	soloedIndex = null;
	prevSoloEnabled = null;
}

function wireCanvasInteraction(el: HTMLCanvasElement) {
	el.addEventListener("mousedown", (e) => {
		const rect = el.getBoundingClientRect();
		const scaleX = (el as any).logicalWidth / rect.width;
		const scaleY = (el as any).logicalHeight / rect.height;
		const x = (e.clientX - rect.left) * scaleX;
		const y = (e.clientY - rect.top) * scaleY;

		const w = (el as any).logicalWidth;
		const h = (el as any).logicalHeight;

		// Hit-test returns the *array position* of the closest band. That's
		// what the drag handler passes to the update callback and into
		// `localBands[arrayIdx]` below.
		let closestArrayIdx = -1;
		let minDst = 1000;
		localBands.forEach((band, arrayIdx) => {
			const bx = freqToX(band.freq, w);
			const by = gainToY(band.gain, h);
			const dist = Math.sqrt((x - bx) ** 2 + (y - by) ** 2);
			if (dist < 22 && dist < minDst) {
				minDst = dist;
				closestArrayIdx = arrayIdx;
			}
		});

		if (closestArrayIdx !== -1) {
			draggingIndex = closestArrayIdx;
			selectBand(localBands[closestArrayIdx].index);
			// Capture drag start state for click-vs-drag + shift-drag Q work.
			dragStartX = e.clientX;
			dragStartY = e.clientY;
			dragStartQ = localBands[closestArrayIdx].q;
			dragMoved = false;
			dragAltAtStart = e.altKey;
			dragShiftAtStart = e.shiftKey;
		}
	});

	// Double-click → snap gain to 0 (unless gainless type). Uses the native
	// dblclick event so the existing drag state machine stays out of its way.
	el.addEventListener("dblclick", (e) => {
		const rect = el.getBoundingClientRect();
		const scaleX = (el as any).logicalWidth / rect.width;
		const scaleY = (el as any).logicalHeight / rect.height;
		const x = (e.clientX - rect.left) * scaleX;
		const y = (e.clientY - rect.top) * scaleY;
		const w = (el as any).logicalWidth;
		const h = (el as any).logicalHeight;
		let arrayIdx = -1;
		let minDst = 1000;
		localBands.forEach((band, idx) => {
			const bx = freqToX(band.freq, w);
			const by = gainToY(band.gain, h);
			const dist = Math.sqrt((x - bx) ** 2 + (y - by) ** 2);
			if (dist < 22 && dist < minDst) {
				minDst = dist;
				arrayIdx = idx;
			}
		});
		if (arrayIdx === -1) return;
		const band = localBands[arrayIdx];
		if (!typeHasGain(band.type)) return;
		handleUpdate(arrayIdx, "gain", 0);
	});

	window.addEventListener("mousemove", (e) => {
		if (draggingIndex === null || !canvas) return;
		const rect = canvas.getBoundingClientRect();

		// Once the pointer has moved more than a few pixels we commit to
		// "this is a drag" and suppress the click handler on mouseup.
		const dx = e.clientX - dragStartX;
		const dy = e.clientY - dragStartY;
		if (!dragMoved && Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) {
			dragMoved = true;
		}
		if (!dragMoved) return;

		// Shift-drag → mutate Q instead of freq/gain. Sensitivity is
		// +/- 0.005 per pixel of vertical motion from the drag-start Y.
		if (e.shiftKey) {
			const delta = (dragStartY - e.clientY) * 0.005;
			const q = Math.max(0.1, Math.min(10, dragStartQ + delta));
			const rounded = Math.round(q * 100) / 100;
			handleUpdate(draggingIndex, "q", rounded);
			return;
		}

		const relX = e.clientX - rect.left;
		const relY = e.clientY - rect.top;
		const clampedX = Math.max(
			CONFIG.padding,
			Math.min(rect.width - CONFIG.padding, relX),
		);
		const clampedY = Math.max(
			CONFIG.padding,
			Math.min(rect.height - CONFIG.padding, relY),
		);
		const freq = Math.round(xToFreq(clampedX, rect.width));
		// Alt-drag reduces the gain quantization step from 0.1 to 0.02 per
		// pixel so users can dial in small boosts without a fine-control
		// input. Freq stays at 1 Hz per pixel in both modes.
		const gainRaw = yToGain(clampedY, rect.height);
		const gain = e.altKey
			? Math.round(gainRaw * 50) / 50
			: Math.round(gainRaw * 10) / 10;
		handleUpdate(draggingIndex, "freq", freq);
		// Gainless types: freq-only drags. Don't write a gain that's
		// ignored by computeBiquad — stays cleaner in history.
		const band = localBands[draggingIndex];
		if (band && typeHasGain(band.type)) {
			handleUpdate(draggingIndex, "gain", gain);
		}
	});

	window.addEventListener("mouseup", (e) => {
		if (draggingIndex === null) return;
		const finishedIdx = draggingIndex;
		draggingIndex = null;

		// If the pointer never moved past threshold, this was a click —
		// dispatch modifier-click actions. Regular clicks fall through to
		// no extra action (selection already happened on mousedown).
		if (!dragMoved && canvas) {
			const band = localBands[finishedIdx];
			if (band) {
				if (dragAltAtStart) {
					// Alt-click → toggle enabled.
					handleUpdate(finishedIdx, "enabled", !band.enabled);
				} else if (dragShiftAtStart) {
					// Shift-click → solo / un-solo. Clicking the already-
					// soloed band exits; clicking another switches target.
					if (soloedIndex === band.index) {
						exitSolo();
					} else {
						// If solo was active on a different band, restore the
						// snapshot first so `enterSolo` records the *original*
						// enabled state (not the post-mute one).
						if (soloedIndex !== null) exitSolo();
						enterSolo(band.index);
					}
				}
			}
			if (bandTable) {
				const currentFingerprint = sortFingerprint(sortedView(localBands));
				if (currentFingerprint !== lastSortFingerprint) {
					buildBandTable(bandTable, localBands);
				}
			}
			draw();
			return;
		}

		// Drag-off-canvas delete: if the final pointer position is outside
		// the canvas with a 20px margin of grace, fire the delete callback.
		// Reset solo if the deleted band was the soloed one.
		if (canvas && onDeleteBandCallback) {
			const rect = canvas.getBoundingClientRect();
			const margin = 20;
			const outside =
				e.clientX < rect.left - margin ||
				e.clientX > rect.right + margin ||
				e.clientY < rect.top - margin ||
				e.clientY > rect.bottom + margin;
			if (outside) {
				const band = localBands[finishedIdx];
				if (band && soloedIndex === band.index) {
					soloedIndex = null;
					prevSoloEnabled = null;
				}
				onDeleteBandCallback(finishedIdx);
				return;
			}
		}

		// Drag ended inside the canvas — run the fingerprint rebuild as
		// before (the dragged band may have crossed a neighbour).
		if (bandTable) {
			const currentFingerprint = sortFingerprint(sortedView(localBands));
			if (currentFingerprint !== lastSortFingerprint) {
				buildBandTable(bandTable, localBands);
			}
		}
		draw();
	});
}

// `arrayIdx` is the position in the unsorted eqState array — the same index
// the update callback expects, since state.setBandField is array-indexed.
function handleUpdate(arrayIdx: number, key: string, value: any) {
	onUpdateCallback?.(arrayIdx, key, value);
	const band = localBands[arrayIdx];
	if (band) {
		if (key === "freq") band.freq = Number(value);
		if (key === "gain") band.gain = Number(value);
		if (key === "q") band.q = Number(value);
		if (key === "type") band.type = String(value);
		if (key === "enabled") band.enabled = Boolean(value);
		syncBandTable(localBands);
		draw();
	}
}
