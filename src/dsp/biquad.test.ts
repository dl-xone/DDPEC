import { describe, expect, it } from "vitest";
import type { Band } from "../main.ts";
import {
	computeBiquad,
	magnitudeDb,
	toProtocolCoeffs,
	toQ30Bytes,
} from "./biquad.ts";

const SR = 96000;

function band(overrides: Partial<Band>): Band {
	return {
		index: 0,
		freq: 1000,
		gain: 0,
		q: 1,
		type: "PK",
		enabled: true,
		...overrides,
	};
}

describe("computeBiquad", () => {
	it("returns identity for disabled bands", () => {
		const c = computeBiquad(band({ enabled: false, gain: 6 }), SR);
		expect(c).toEqual({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 });
	});

	it("returns ~unity magnitude for 0 dB peak", () => {
		const c = computeBiquad(band({ gain: 0 }), SR);
		expect(magnitudeDb(c, 1000, SR)).toBeCloseTo(0, 6);
	});

	it("peaks at the centre frequency with positive gain", () => {
		const c = computeBiquad(band({ freq: 1000, gain: 6, q: 1 }), SR);
		expect(magnitudeDb(c, 1000, SR)).toBeCloseTo(6, 2);
		// Rolls off on either side
		expect(magnitudeDb(c, 200, SR)).toBeLessThan(1);
		expect(magnitudeDb(c, 5000, SR)).toBeLessThan(1);
	});

	it("low shelf boosts below the corner frequency", () => {
		const c = computeBiquad(
			band({ freq: 200, gain: 6, q: Math.SQRT1_2, type: "LSQ" }),
			SR,
		);
		expect(magnitudeDb(c, 50, SR)).toBeCloseTo(6, 0);
		expect(magnitudeDb(c, 8000, SR)).toBeCloseTo(0, 1);
	});

	it("high shelf boosts above the corner frequency", () => {
		const c = computeBiquad(
			band({ freq: 8000, gain: 6, q: Math.SQRT1_2, type: "HSQ" }),
			SR,
		);
		expect(magnitudeDb(c, 16000, SR)).toBeCloseTo(6, 0);
		expect(magnitudeDb(c, 100, SR)).toBeCloseTo(0, 1);
	});

	// Gainless filter types — each should ignore `band.gain` entirely and
	// produce the classic RBJ shape keyed off Fc and Q.
	it("high-pass is -3 dB at Fc with Q=0.707 and unity well above", () => {
		const c = computeBiquad(
			band({ freq: 1000, gain: 99, q: Math.SQRT1_2, type: "HPQ" }),
			SR,
		);
		expect(magnitudeDb(c, 1000, SR)).toBeCloseTo(-3, 1);
		expect(magnitudeDb(c, 16000, SR)).toBeCloseTo(0, 1);
		// Well below Fc → strongly attenuated.
		expect(magnitudeDb(c, 50, SR)).toBeLessThan(-20);
	});

	it("low-pass is -3 dB at Fc with Q=0.707 and unity well below", () => {
		const c = computeBiquad(
			band({ freq: 1000, gain: 99, q: Math.SQRT1_2, type: "LPQ" }),
			SR,
		);
		expect(magnitudeDb(c, 1000, SR)).toBeCloseTo(-3, 1);
		expect(magnitudeDb(c, 50, SR)).toBeCloseTo(0, 1);
		expect(magnitudeDb(c, 16000, SR)).toBeLessThan(-20);
	});

	it("notch is very deep at centre and unity away from Fc", () => {
		const c = computeBiquad(
			band({ freq: 1000, gain: 99, q: 5, type: "NO" }),
			SR,
		);
		expect(magnitudeDb(c, 1000, SR)).toBeLessThan(-40);
		expect(magnitudeDb(c, 100, SR)).toBeCloseTo(0, 1);
		expect(magnitudeDb(c, 8000, SR)).toBeCloseTo(0, 1);
	});

	it("band-pass (CPG) is 0 dB at centre and rolls off either side", () => {
		const c = computeBiquad(
			band({ freq: 1000, gain: 99, q: 1, type: "BPQ" }),
			SR,
		);
		expect(magnitudeDb(c, 1000, SR)).toBeCloseTo(0, 1);
		expect(magnitudeDb(c, 100, SR)).toBeLessThan(-10);
		expect(magnitudeDb(c, 10000, SR)).toBeLessThan(-10);
	});
});

describe("toProtocolCoeffs", () => {
	it("flips the sign of a1 and a2", () => {
		const coeffs = { b0: 0.5, b1: -0.3, b2: 0.2, a1: -0.1, a2: 0.4 };
		expect(toProtocolCoeffs(coeffs)).toEqual([0.5, -0.3, 0.2, 0.1, -0.4]);
	});
});

describe("toQ30Bytes", () => {
	it("packs 1.0 as 0x40000000 in little-endian", () => {
		expect(toQ30Bytes([1])).toEqual([0x00, 0x00, 0x00, 0x40]);
	});

	it("packs -1.0 as 0xC0000000 in little-endian (two's complement)", () => {
		expect(toQ30Bytes([-1])).toEqual([0x00, 0x00, 0x00, 0xc0]);
	});

	it("packs 0 as four zero bytes", () => {
		expect(toQ30Bytes([0])).toEqual([0x00, 0x00, 0x00, 0x00]);
	});
});
