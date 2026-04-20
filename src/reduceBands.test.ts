import { describe, expect, it } from "vitest";
import type { Band } from "./main.ts";
import { reduceToNBands } from "./reduceBands.ts";

function band(partial: Partial<Band> & { index: number }): Band {
	return {
		index: partial.index,
		freq: partial.freq ?? 1000,
		gain: partial.gain ?? 0,
		q: partial.q ?? 1,
		type: partial.type ?? "PK",
		enabled: partial.enabled ?? true,
	};
}

describe("reduceToNBands", () => {
	it("returns input unchanged when n >= length", () => {
		const bands = [band({ index: 0, gain: 3, q: 1 }), band({ index: 1, gain: 6, q: 2 })];
		const { reduced, dropped } = reduceToNBands(bands, 5);
		expect(reduced).toEqual(bands);
		expect(dropped).toEqual([]);
	});

	it("drops the lowest-impact band by |gain * Q| for peaking types", () => {
		const low = band({ index: 0, gain: 1, q: 0.5 }); // impact 0.5
		const mid = band({ index: 1, gain: 3, q: 1 }); // impact 3
		const high = band({ index: 2, gain: 6, q: 2 }); // impact 12
		const { reduced, dropped } = reduceToNBands([low, mid, high], 2);
		expect(reduced.map((b) => b.index)).toEqual([1, 2]);
		expect(dropped.map((b) => b.index)).toEqual([0]);
	});

	it("uses |Q| for gainless types (HP / LP / NO / BP)", () => {
		const hp = band({ index: 0, type: "HPQ", gain: 99, q: 0.5 }); // gain ignored → |Q| = 0.5
		const pk = band({ index: 1, type: "PK", gain: 1, q: 1 }); // impact 1
		const { reduced, dropped } = reduceToNBands([hp, pk], 1);
		expect(reduced.map((b) => b.index)).toEqual([1]);
		expect(dropped.map((b) => b.index)).toEqual([0]);
	});

	it("drops disabled bands before any enabled band", () => {
		const disabled = band({ index: 0, gain: 12, q: 2, enabled: false });
		const tiny = band({ index: 1, gain: 0.1, q: 0.1 });
		const { reduced, dropped } = reduceToNBands([disabled, tiny], 1);
		expect(reduced.map((b) => b.index)).toEqual([1]);
		expect(dropped.map((b) => b.index)).toEqual([0]);
	});

	it("clamps n < 1 up to 1", () => {
		const bands = [band({ index: 0, gain: 1 }), band({ index: 1, gain: 2 })];
		const { reduced } = reduceToNBands(bands, 0);
		expect(reduced.length).toBe(1);
	});

	it("preserves surviving-band order", () => {
		const a = band({ index: 0, gain: 2, q: 1 });
		const b = band({ index: 1, gain: 10, q: 2 });
		const c = band({ index: 2, gain: 5, q: 1 });
		const { reduced } = reduceToNBands([a, b, c], 2);
		// impact: a=2, b=20, c=5 → keep b and c. Order preserved.
		expect(reduced.map((band) => band.index)).toEqual([1, 2]);
	});

	it("handles empty input", () => {
		const { reduced, dropped } = reduceToNBands([], 3);
		expect(reduced).toEqual([]);
		expect(dropped).toEqual([]);
	});
});
