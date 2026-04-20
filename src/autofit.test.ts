import { describe, expect, it } from "vitest";
import { autoFitBands, fitMse, LOG_FREQS } from "./autofit.ts";
import type { Measurement } from "./measurements.ts";
import type { Band } from "./main.ts";

// Build a log-spaced synthetic measurement with `fn(freq)` applied.
function synthMeasurement(
	fn: (freq: number) => number,
	name = "synthetic",
): Measurement {
	return {
		name,
		points: LOG_FREQS.map((freq) => ({ freq, db: fn(freq) })),
	};
}

function flatTarget(): Measurement {
	return synthMeasurement(() => 0, "flat-target");
}

// Synthetic: a Gaussian bump in dB centered on `centerHz` with `peakDb`
// peak and width `sigmaOctaves`. Mimics a real measurement with a
// midrange bump we want the fit to flatten.
function bump(
	centerHz: number,
	peakDb: number,
	sigmaOctaves = 0.3,
): (freq: number) => number {
	return (freq) => {
		const octavesAway = Math.log2(freq / centerHz);
		return peakDb * Math.exp(-(octavesAway * octavesAway) / (2 * sigmaOctaves ** 2));
	};
}

function makeBlankBands(n: number): Band[] {
	const out: Band[] = [];
	for (let i = 0; i < n; i++) {
		out.push({
			index: i,
			freq: 1000,
			gain: 0,
			q: 0.75,
			type: "PK",
			enabled: true,
		});
	}
	return out;
}

describe("autoFitBands", () => {
	it("places a band near 1 kHz with ~-6 dB gain for a +6 dB bump", () => {
		const target = flatTarget();
		const measurement = synthMeasurement(bump(1000, 6));
		const result = autoFitBands(target, measurement, makeBlankBands(4), {
			tierB: false,
			maxBands: 4,
		});
		expect(result.length).toBeGreaterThan(0);
		// The first (strongest) band should land near 1 kHz with negative gain.
		const strongest = result.reduce((best, b) =>
			Math.abs(b.gain) > Math.abs(best.gain) ? b : best,
		);
		expect(strongest.gain).toBeLessThan(0); // cutting the bump
		// ±1/3 octave window around 1 kHz.
		expect(strongest.freq).toBeGreaterThan(1000 / 1.26);
		expect(strongest.freq).toBeLessThan(1000 * 1.26);
	});

	it("reduces MSE vs doing nothing", () => {
		const target = flatTarget();
		const measurement = synthMeasurement(bump(2000, 8));
		const blank = makeBlankBands(6);
		const before = fitMse(target, measurement, blank);
		const fit = autoFitBands(target, measurement, blank, {
			tierB: false,
			maxBands: 6,
		});
		const after = fitMse(target, measurement, fit);
		expect(after).toBeLessThan(before);
		expect(after).toBeLessThan(before * 0.5); // at least halve the error
	});

	it("Tier B MSE is <= Tier A MSE", () => {
		const target = flatTarget();
		const measurement = synthMeasurement(bump(500, 5, 0.4));
		const blank = makeBlankBands(4);
		const fitA = autoFitBands(target, measurement, blank, {
			tierB: false,
			maxBands: 4,
		});
		const fitB = autoFitBands(target, measurement, blank, {
			tierB: true,
			maxBands: 4,
		});
		const mseA = fitMse(target, measurement, fitA);
		const mseB = fitMse(target, measurement, fitB);
		// Refine shouldn't make things worse. Allow a tiny float wiggle.
		expect(mseB).toBeLessThanOrEqual(mseA + 1e-9);
	});

	it("returns [] when maxBands is 0", () => {
		const target = flatTarget();
		const measurement = synthMeasurement(bump(1000, 3));
		const result = autoFitBands(target, measurement, [], { maxBands: 0 });
		expect(result).toEqual([]);
	});

	it("returns no bands when target matches measurement perfectly", () => {
		const target = flatTarget();
		const measurement = flatTarget();
		const result = autoFitBands(target, measurement, makeBlankBands(4), {
			maxBands: 4,
		});
		// Greedy picker bails out below 1e-6 dB error — so the result is
		// empty. MSE should be effectively zero for both any band set and
		// the empty result.
		expect(result.length).toBe(0);
		expect(fitMse(target, measurement, result)).toBeLessThan(1e-6);
	});

	it("assigns unique hardware slot indices", () => {
		const target = flatTarget();
		const measurement = synthMeasurement((f) => bump(200, 6)(f) + bump(5000, -4)(f));
		const result = autoFitBands(target, measurement, makeBlankBands(6), {
			maxBands: 6,
		});
		const indices = new Set(result.map((b) => b.index));
		expect(indices.size).toBe(result.length);
	});

	it("chooses shelves at the frequency extremes", () => {
		const target = flatTarget();
		// Bass rise + treble rise — the fit should have at least one shelf.
		const measurement = synthMeasurement(
			(f) => bump(40, 8, 0.6)(f) + bump(15000, 6, 0.5)(f),
		);
		const result = autoFitBands(target, measurement, makeBlankBands(6), {
			tierB: false,
			maxBands: 6,
		});
		// Expect any band placed below 60 Hz to be LSQ, above 10 kHz to be HSQ.
		for (const b of result) {
			if (b.freq < 60) expect(b.type).toBe("LSQ");
			else if (b.freq > 10000) expect(b.type).toBe("HSQ");
			else expect(b.type).toBe("PK");
		}
	});
});
