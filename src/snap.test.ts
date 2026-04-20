import { describe, expect, it } from "vitest";
import { applySnap } from "./peq.ts";

// Identity pixel-mapper so we can drive the snap math directly in
// "value units" without simulating a log-frequency canvas.
const identity = (v: number) => v;

describe("applySnap (Feature E magnetic snap)", () => {
	it("returns input untouched when no snap is within threshold", () => {
		const out = applySnap(7.5, [0, 10], 1, identity);
		expect(out.value).toBe(7.5);
		expect(out.captured).toBeNull();
	});

	it("snaps fully to the target when value sits on the snap", () => {
		const out = applySnap(10, [0, 10], 4, identity);
		expect(out.value).toBeCloseTo(10, 6);
		expect(out.captured).toBe(10);
	});

	it("biases proportionally to distance — half-way blends 50/50", () => {
		// 8 is 2 px from 10, threshold is 4 → t = 0.5 → blended halfway.
		const out = applySnap(8, [0, 10], 4, identity);
		expect(out.captured).toBe(10);
		expect(out.value).toBeCloseTo(9, 6); // 8 + (10-8)*0.5
	});

	it("picks the nearest snap when multiple are within threshold", () => {
		const out = applySnap(2, [0, 3, 10], 5, identity);
		// Distances: 2, 1, 8 → nearest is 3.
		expect(out.captured).toBe(3);
	});

	it("uses the supplied pixel mapper when comparing distance", () => {
		// Map "value" to 100x its own scale; threshold 5 px means snap window
		// shrinks from 5 value-units to 0.05 value-units.
		const out = applySnap(0.04, [0], 5, (v) => v * 100);
		expect(out.captured).toBe(0); // 4 px from 0 → snaps
		expect(out.value).toBeLessThan(0.04); // pulled toward 0
	});

	it("does not snap when distance equals threshold", () => {
		// At exactly threshold the bias is zero and snap should not register.
		const out = applySnap(4, [0], 4, identity);
		expect(out.captured).toBeNull();
		expect(out.value).toBe(4);
	});
});
