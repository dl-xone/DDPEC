import { describe, expect, it } from "vitest";
import {
	magnitudeAt,
	normalizeAt,
	parseMeasurement,
} from "./measurements.ts";

describe("parseMeasurement", () => {
	it("parses simple two-column CSV", () => {
		const m = parseMeasurement("20,78\n1000,80\n10000,75");
		expect(m.points.length).toBe(3);
		expect(m.points[0]).toEqual({ freq: 20, db: 78 });
	});

	it("skips header rows that aren't numeric", () => {
		const m = parseMeasurement("frequency,SPL\n100,80\n1000,82");
		expect(m.points.length).toBe(2);
		expect(m.points[0].freq).toBe(100);
	});

	it("skips comment lines", () => {
		const m = parseMeasurement("# AutoEQ export\n100,70\n% sidecar\n1000,72");
		expect(m.points.length).toBe(2);
	});

	it("handles tabs and semicolons", () => {
		const m = parseMeasurement("100\t70\n1000;72");
		expect(m.points.length).toBe(2);
	});

	it("uses the first two columns even when more are present", () => {
		const m = parseMeasurement("100,70,68.5,65\n1000,72,71.2,70");
		expect(m.points[0].db).toBe(70);
		expect(m.points[1].db).toBe(72);
	});

	it("sorts frequencies ascending", () => {
		const m = parseMeasurement("1000,80\n100,75\n10000,70");
		expect(m.points.map((p) => p.freq)).toEqual([100, 1000, 10000]);
	});

	it("throws if there are fewer than two valid points", () => {
		expect(() => parseMeasurement("# only comments")).toThrow();
	});
});

describe("magnitudeAt", () => {
	const sample = parseMeasurement("100,60\n1000,80\n10000,70");

	it("returns the endpoint at or below the minimum frequency", () => {
		expect(magnitudeAt(sample, 50)).toBe(60);
		expect(magnitudeAt(sample, 100)).toBe(60);
	});

	it("returns the endpoint at or above the maximum frequency", () => {
		expect(magnitudeAt(sample, 20000)).toBe(70);
	});

	it("interpolates in log-freq space", () => {
		// 1000 Hz is the geometric mean of 100 and 10000, so the
		// interpolated value is the average of the endpoints.
		expect(magnitudeAt(sample, 1000)).toBeCloseTo(80, 6);
		// Halfway (log-space) between 100 and 1000 is ~316 Hz → midpoint of 60 and 80.
		expect(magnitudeAt(sample, Math.sqrt(100 * 1000))).toBeCloseTo(70, 6);
	});
});

describe("normalizeAt", () => {
	it("shifts the measurement so the ref freq lands at 0 dB", () => {
		const m = parseMeasurement("100,60\n1000,80\n10000,70");
		const norm = normalizeAt(m, 1000);
		expect(magnitudeAt(norm, 1000)).toBeCloseTo(0, 6);
		expect(magnitudeAt(norm, 100)).toBeCloseTo(-20, 6);
		expect(magnitudeAt(norm, 10000)).toBeCloseTo(-10, 6);
	});
});
