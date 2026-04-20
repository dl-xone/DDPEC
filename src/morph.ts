// Curve morph animation — interpolates band values from current to target
// over a short duration so preset / AutoEQ / reset transitions feel smooth.
//
// Pure math helpers are exported separately so they can be unit-tested
// without a DOM or rAF loop.

import type { Band } from "./main.ts";
import { getEqState, setEqState } from "./state.ts";

export interface MorphOptions {
	duration?: number;
	onStep?: (bands: Band[]) => void;
	onDone?: () => void;
}

const DEFAULT_DURATION_MS = 300;

export function clamp01(t: number): number {
	if (t <= 0) return 0;
	if (t >= 1) return 1;
	return t;
}

// Ease-out-cubic — fast at start, settles at end. Matches the "snap into
// place" feel that reads as deliberate rather than springy.
export function easeOutCubic(t: number): number {
	const c = clamp01(t);
	const inv = 1 - c;
	return 1 - inv * inv * inv;
}

export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

// Frequency feels natural in log space (an octave is an octave at 100 Hz
// or 10 kHz). Linear lerp on freq makes high-end edits feel sluggish.
export function logLerp(a: number, b: number, t: number): number {
	if (a <= 0 || b <= 0) return lerp(a, b, t);
	return Math.exp(lerp(Math.log(a), Math.log(b), t));
}

// Interpolate a band tuple at eased progress `e` (0..1). Type and `index`
// + `enabled` are taken from the target — they're discrete, no tween.
export function interpBands(
	snapshot: Band[],
	target: Band[],
	e: number,
): Band[] {
	const out: Band[] = [];
	const n = Math.min(snapshot.length, target.length);
	for (let i = 0; i < n; i++) {
		const a = snapshot[i];
		const b = target[i];
		out.push({
			index: b.index,
			freq: logLerp(a.freq, b.freq, e),
			gain: lerp(a.gain, b.gain, e),
			q: lerp(a.q, b.q, e),
			type: b.type,
			enabled: b.enabled,
		});
	}
	return out;
}

function prefersReducedMotion(): boolean {
	if (typeof window === "undefined" || !window.matchMedia) return false;
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	} catch {
		return false;
	}
}

// Animate from the current EQ state toward `targetBands` over `duration` ms.
// Returns a cancel function — calling it halts further frames; the caller
// is responsible for clean-up of any pending side-effects past the cancel.
export function morphToBands(
	targetBands: Band[],
	opts: MorphOptions = {},
): () => void {
	const duration = opts.duration ?? DEFAULT_DURATION_MS;
	const snapshot = getEqState().map((b) => ({ ...b }));
	const target = targetBands.map((b) => ({ ...b }));

	// Skip-to-snap conditions: reduced motion, length mismatch (interp only
	// covers shared indices — partial morphs would look wrong), or zero/neg
	// duration. Final state still goes through the noisy setEqState so the
	// dirty-change observers fire.
	const lengthMismatch = snapshot.length !== target.length;
	if (
		duration <= 0 ||
		lengthMismatch ||
		prefersReducedMotion() ||
		typeof requestAnimationFrame === "undefined"
	) {
		setEqState(target);
		opts.onStep?.(target);
		opts.onDone?.();
		return () => {};
	}

	let cancelled = false;
	let rafId = 0;
	const start =
		typeof performance !== "undefined" ? performance.now() : Date.now();

	const step = (now: number) => {
		if (cancelled) return;
		const t = clamp01((now - start) / duration);
		const e = easeOutCubic(t);
		if (t >= 1) {
			// Final write goes noisy so dirty-change fires once at the end.
			setEqState(target);
			opts.onStep?.(target);
			opts.onDone?.();
			return;
		}
		const interp = interpBands(snapshot, target, e);
		setEqState(interp, { silent: true });
		opts.onStep?.(interp);
		rafId = requestAnimationFrame(step);
	};

	rafId = requestAnimationFrame(step);

	return () => {
		cancelled = true;
		if (rafId && typeof cancelAnimationFrame !== "undefined") {
			cancelAnimationFrame(rafId);
		}
	};
}
