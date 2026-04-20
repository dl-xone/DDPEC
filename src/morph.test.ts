import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Band } from "./main.ts";
import {
	clamp01,
	easeOutCubic,
	interpBands,
	lerp,
	logLerp,
	morphToBands,
} from "./morph.ts";
import { defaultEqState, getEqState, resetSlots, setEqState } from "./state.ts";

beforeEach(() => {
	resetSlots(defaultEqState(null), 0);
});

describe("morph math", () => {
	it("clamp01 saturates outside [0, 1]", () => {
		expect(clamp01(-0.5)).toBe(0);
		expect(clamp01(0)).toBe(0);
		expect(clamp01(0.4)).toBe(0.4);
		expect(clamp01(1)).toBe(1);
		expect(clamp01(1.7)).toBe(1);
	});

	it("easeOutCubic anchors at endpoints and bows above the diagonal", () => {
		expect(easeOutCubic(0)).toBeCloseTo(0, 12);
		expect(easeOutCubic(1)).toBeCloseTo(1, 12);
		// Ease-out → midpoint should be > 0.5 (front-loaded).
		expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
	});

	it("lerp is linear in t", () => {
		expect(lerp(0, 10, 0)).toBe(0);
		expect(lerp(0, 10, 1)).toBe(10);
		expect(lerp(0, 10, 0.5)).toBe(5);
		expect(lerp(-4, 4, 0.25)).toBe(-2);
	});

	it("logLerp is exponential in t — geometric mean at 0.5", () => {
		expect(logLerp(100, 10000, 0)).toBeCloseTo(100, 6);
		expect(logLerp(100, 10000, 1)).toBeCloseTo(10000, 6);
		// Geometric mean of 100 and 10000 is 1000.
		expect(logLerp(100, 10000, 0.5)).toBeCloseTo(1000, 6);
	});
});

describe("interpBands", () => {
	const A: Band[] = [
		{ index: 0, freq: 100, gain: 0, q: 1, type: "PK", enabled: true },
		{ index: 1, freq: 1000, gain: 6, q: 0.7, type: "PK", enabled: true },
	];
	const B: Band[] = [
		{ index: 0, freq: 200, gain: -3, q: 2, type: "PK", enabled: true },
		{ index: 1, freq: 4000, gain: 0, q: 1.5, type: "LSQ", enabled: false },
	];

	it("returns the snapshot exactly at e=0", () => {
		const out = interpBands(A, B, 0);
		expect(out[0].freq).toBeCloseTo(100, 6);
		expect(out[0].gain).toBeCloseTo(0, 6);
		expect(out[0].q).toBeCloseTo(1, 6);
		expect(out[1].freq).toBeCloseTo(1000, 6);
		expect(out[1].gain).toBeCloseTo(6, 6);
	});

	it("returns the target exactly at e=1", () => {
		const out = interpBands(A, B, 1);
		expect(out[0].freq).toBeCloseTo(200, 6);
		expect(out[0].gain).toBeCloseTo(-3, 6);
		expect(out[0].q).toBeCloseTo(2, 6);
		expect(out[1].freq).toBeCloseTo(4000, 6);
	});

	it("type and enabled come from the target (no tween)", () => {
		const out = interpBands(A, B, 0.5);
		expect(out[1].type).toBe("LSQ");
		expect(out[1].enabled).toBe(false);
	});

	it("freq interpolation is logarithmic — midpoint is geometric mean", () => {
		const out = interpBands(A, B, 0.5);
		expect(out[1].freq).toBeCloseTo(2000, 4); // geo mean of 1000 & 4000
	});

	it("gain and Q interpolation is linear", () => {
		const out = interpBands(A, B, 0.5);
		expect(out[0].gain).toBeCloseTo(-1.5, 6);
		expect(out[0].q).toBeCloseTo(1.5, 6);
	});
});

describe("morphToBands", () => {
	beforeEach(() => {
		// Default reset puts identical bands across slots; install a clean
		// 2-band starting point so we can measure changes.
		setEqState([
			{ index: 0, freq: 100, gain: 0, q: 1, type: "PK", enabled: true },
			{ index: 1, freq: 1000, gain: 0, q: 1, type: "PK", enabled: true },
		]);
	});

	it("snaps instantly when band counts differ", () => {
		const target: Band[] = [
			{ index: 0, freq: 200, gain: 3, q: 0.7, type: "PK", enabled: true },
		];
		morphToBands(target, { duration: 300 });
		const live = getEqState();
		expect(live.length).toBe(1);
		expect(live[0].freq).toBe(200);
	});

	it("snaps instantly when duration is zero", () => {
		const target: Band[] = [
			{ index: 0, freq: 200, gain: 3, q: 1, type: "PK", enabled: true },
			{ index: 1, freq: 4000, gain: -2, q: 1, type: "PK", enabled: true },
		];
		morphToBands(target, { duration: 0 });
		expect(getEqState()[0].freq).toBe(200);
		expect(getEqState()[1].freq).toBe(4000);
	});

	it("calls onDone after a synchronous skip", () => {
		const target: Band[] = [
			{ index: 0, freq: 200, gain: 3, q: 1, type: "PK", enabled: true },
			{ index: 1, freq: 4000, gain: -2, q: 1, type: "PK", enabled: true },
		];
		const done = vi.fn();
		morphToBands(target, { duration: 0, onDone: done });
		expect(done).toHaveBeenCalledTimes(1);
	});

	describe("with mocked rAF", () => {
		let frameCallbacks: Array<(t: number) => void> = [];
		let nowMs = 0;

		beforeEach(() => {
			frameCallbacks = [];
			nowMs = 0;
			vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
				frameCallbacks.push(cb);
				return frameCallbacks.length;
			});
			vi.stubGlobal("cancelAnimationFrame", () => {});
			vi.stubGlobal("performance", { now: () => nowMs });
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		// Run the next pending frame at the supplied time.
		function tick(advanceTo: number) {
			nowMs = advanceTo;
			const next = frameCallbacks.shift();
			if (next) next(nowMs);
		}

		it("cancel halts further setEqState writes", () => {
			const target: Band[] = [
				{ index: 0, freq: 200, gain: 3, q: 1, type: "PK", enabled: true },
				{ index: 1, freq: 4000, gain: -2, q: 1, type: "PK", enabled: true },
			];
			const cancel = morphToBands(target, { duration: 300 });
			// One initial frame queued.
			tick(50);
			const midFreq = getEqState()[0].freq;
			expect(midFreq).toBeGreaterThan(100);
			expect(midFreq).toBeLessThan(200);

			cancel();
			// Even if more frames were queued before cancel, drain them — the
			// cancelled flag should prevent further state mutation.
			tick(300);
			tick(600);
			expect(getEqState()[0].freq).toBe(midFreq);
		});

		it("final frame writes the exact target values", () => {
			const target: Band[] = [
				{ index: 0, freq: 200, gain: 3, q: 1, type: "PK", enabled: true },
				{ index: 1, freq: 4000, gain: -2, q: 1, type: "PK", enabled: true },
			];
			const done = vi.fn();
			morphToBands(target, { duration: 100, onDone: done });
			tick(50);
			tick(150); // past duration → final frame
			expect(getEqState()[0].freq).toBe(200);
			expect(getEqState()[1].freq).toBe(4000);
			expect(done).toHaveBeenCalledTimes(1);
		});
	});
});
