import { SAMPLE_RATE } from "./constants.ts";
import { computeBiquad, magnitudeDb } from "./dsp/biquad.ts";
import type { Band } from "./main.ts";
import { measurementDbAt, targetDbAt } from "./measurements.ts";
import peqTemplate from "./peq.template.html?raw";

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

const BAND_TYPE_LABELS: Record<string, string> = {
	PK: "Peaking",
	LSQ: "Low Shelf",
	HSQ: "High Shelf",
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
let selectedIndex: number | null = null;
let draggingIndex: number | null = null;
let onUpdateCallback:
	| ((index: number, key: string, value: number | string | boolean) => void)
	| null = null;

// DOM refs
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let bandTable: HTMLElement | null = null;

// Cached per-band input refs, for O(1) updates without DOM rebuilds.
const cellRefs: Array<{
	type: HTMLSelectElement;
	gain: HTMLInputElement;
	freq: HTMLInputElement;
	q: HTMLInputElement;
	enable: HTMLInputElement;
	header: HTMLElement;
	typeLabel: HTMLElement;
}> = [];

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

	// Target curve — dashed goal line (if loaded).
	drawTarget(c, width, height);

	// Raw measurement (dim).
	drawMeasurement(c, width, height, null, {
		stroke: measurementDim,
		lineWidth: 2,
	});
	// Predicted FR-after-EQ.
	drawMeasurement(c, width, height, localBands, {
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
	// Active slot curve — the softened red hero line.
	drawCurveFor(c, width, height, localBands, {
		stroke: accent,
		lineWidth: 2.5,
		shadowColor: "rgba(207, 72, 99, 0.25)",
	});
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

	localBands.forEach((band) => {
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
		c.fillText(String(band.index + 1), x, y + 0.5);
	});
	c.textBaseline = "alphabetic";
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
	drawHandles(ctx, width, height);
	drawLegend(ctx, width, height);
}

/**
 * TABULAR EDITOR — replaces the legacy band-list + edit-form sidebar.
 */
function buildBandTable(table: HTMLElement, bands: Band[]) {
	table.replaceChildren();
	cellRefs.length = 0;

	const columns = `grid-template-columns: 44px repeat(${bands.length}, minmax(68px, 1fr));`;
	const grid = document.createElement("div");
	grid.className = "grid gap-x-1.5 gap-y-0.5 items-center";
	grid.setAttribute("style", columns);

	// Header row — band number, type label, and an enable-power toggle.
	grid.appendChild(rowLabel(""));
	bands.forEach((band, i) => {
		const h = document.createElement("div");
		h.className = "flex flex-col items-center gap-0 py-0.5 cursor-pointer";
		h.dataset.band = String(i);

		const typeLabel = document.createElement("div");
		typeLabel.className = "text-[9px] uppercase tracking-wider text-text-3 font-mono";
		typeLabel.textContent = BAND_TYPE_LABELS[band.type] ?? "Peaking";

		const bandRow = document.createElement("div");
		bandRow.className = "flex items-center gap-1";

		const bandNum = document.createElement("span");
		bandNum.className = "text-[10px] font-mono text-text-2";
		bandNum.textContent = `Band ${i + 1}`;

		const enable = document.createElement("input");
		enable.type = "checkbox";
		enable.checked = band.enabled;
		enable.className = "h-2.5 w-2.5 accent-accent cursor-pointer";
		enable.title = "Enable / disable this band";
		enable.addEventListener("change", (e) => {
			e.stopPropagation();
			onUpdateCallback?.(i, "enabled", enable.checked);
			draw();
		});

		bandRow.append(bandNum, enable);
		h.append(typeLabel, bandRow);
		h.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).tagName !== "INPUT") selectBand(i);
		});
		grid.appendChild(h);

		cellRefs[i] = {
			type: null as unknown as HTMLSelectElement,
			gain: null as unknown as HTMLInputElement,
			freq: null as unknown as HTMLInputElement,
			q: null as unknown as HTMLInputElement,
			enable,
			header: h,
			typeLabel,
		};
	});

	// TYPE row
	grid.appendChild(rowLabel("Type"));
	bands.forEach((band, i) => {
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
			onUpdateCallback?.(i, "type", sel.value);
			if (cellRefs[i]) {
				cellRefs[i].typeLabel.textContent =
					BAND_TYPE_LABELS[sel.value] ?? "Peaking";
			}
			draw();
		});
		grid.appendChild(sel);
		cellRefs[i].type = sel;
	});

	// GAIN row
	grid.appendChild(rowLabel("Gain"));
	bands.forEach((band, i) => {
		const inp = numericInput(formatGain(band.gain), -20, 20, 0.1);
		inp.addEventListener("input", () => {
			const v = Number(inp.value);
			if (Number.isFinite(v)) {
				onUpdateCallback?.(i, "gain", v);
				draw();
			}
		});
		grid.appendChild(inp);
		cellRefs[i].gain = inp;
	});

	// FREQ row
	grid.appendChild(rowLabel("Freq"));
	bands.forEach((band, i) => {
		const inp = numericInput(String(Math.round(band.freq)), 10, 24000, 1);
		inp.addEventListener("input", () => {
			const v = Number(inp.value);
			if (Number.isFinite(v) && v > 0) {
				onUpdateCallback?.(i, "freq", v);
				draw();
			}
		});
		grid.appendChild(inp);
		cellRefs[i].freq = inp;
	});

	// Q row
	grid.appendChild(rowLabel("Q"));
	bands.forEach((band, i) => {
		const inp = numericInput(formatQ(band.q), 0.1, 10, 0.01);
		inp.addEventListener("input", () => {
			const v = Number(inp.value);
			if (Number.isFinite(v) && v > 0) {
				onUpdateCallback?.(i, "q", v);
				draw();
			}
		});
		grid.appendChild(inp);
		cellRefs[i].q = inp;
	});

	table.appendChild(grid);
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
function syncBandTable(bands: Band[]) {
	const focused = document.activeElement;
	for (let i = 0; i < bands.length; i++) {
		const refs = cellRefs[i];
		const b = bands[i];
		if (!refs || !b) continue;
		if (focused !== refs.type && refs.type.value !== b.type) {
			refs.type.value = b.type;
		}
		if (focused !== refs.gain) refs.gain.value = formatGain(b.gain);
		if (focused !== refs.freq) refs.freq.value = String(Math.round(b.freq));
		if (focused !== refs.q) refs.q.value = formatQ(b.q);
		refs.enable.checked = b.enabled;
		refs.typeLabel.textContent = BAND_TYPE_LABELS[b.type] ?? "Peaking";
		refs.header.classList.toggle("text-accent", i === selectedIndex);
	}
}

function selectBand(index: number) {
	selectedIndex = index;
	syncBandTable(localBands);
	draw();
}

/**
 * PUBLIC API
 */
export interface RenderPEQOptions {
	inactiveBands?: Band[] | null;
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

	if (isFirstRender) {
		const parsed = new DOMParser().parseFromString(peqTemplate, "text/html");
		container.replaceChildren(...Array.from(parsed.body.children));

		canvas = container.querySelector("#eqCanvas");
		ctx = canvas?.getContext("2d") || null;
		bandTable = container.querySelector("#bandTable");

		const resizeObserver = new ResizeObserver(() => resizeCanvas());
		if (canvas?.parentElement) resizeObserver.observe(canvas.parentElement);
		resizeCanvas();

		if (canvas) wireCanvasInteraction(canvas);
	}

	if (bandTable) {
		if (cellRefs.length !== bands.length) {
			buildBandTable(bandTable, bands);
		} else {
			syncBandTable(bands);
		}
	}
	draw();
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

		let closestIdx = -1;
		let minDst = 1000;
		localBands.forEach((band) => {
			const bx = freqToX(band.freq, w);
			const by = gainToY(band.gain, h);
			const dist = Math.sqrt((x - bx) ** 2 + (y - by) ** 2);
			if (dist < 22 && dist < minDst) {
				minDst = dist;
				closestIdx = band.index;
			}
		});

		if (closestIdx !== -1) {
			draggingIndex = closestIdx;
			selectBand(closestIdx);
		}
	});

	window.addEventListener("mousemove", (e) => {
		if (draggingIndex === null || !canvas) return;
		const rect = canvas.getBoundingClientRect();
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
		const gain = Math.round(yToGain(clampedY, rect.height) * 10) / 10;
		handleUpdate(draggingIndex, "freq", freq);
		handleUpdate(draggingIndex, "gain", gain);
	});

	window.addEventListener("mouseup", () => {
		draggingIndex = null;
	});
}

function handleUpdate(index: number, key: string, value: any) {
	onUpdateCallback?.(index, key, value);
	const band = localBands[index];
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
