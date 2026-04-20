import { describe, expect, it } from "vitest";
import { binomialPmf, computeAbxResult } from "./abx.ts";

describe("binomialPmf", () => {
	it("sums to 1 across all outcomes", () => {
		let total = 0;
		for (let k = 0; k <= 10; k++) total += binomialPmf(k, 10, 0.5);
		expect(total).toBeCloseTo(1, 10);
	});

	it("matches known values: C(10,5) * 0.5^10 ≈ 0.2461", () => {
		expect(binomialPmf(5, 10, 0.5)).toBeCloseTo(252 / 1024, 6);
	});

	it("zero probability outside [0, n]", () => {
		expect(binomialPmf(-1, 10, 0.5)).toBe(0);
		expect(binomialPmf(11, 10, 0.5)).toBe(0);
	});
});

describe("computeAbxResult", () => {
	it("perfect score → very low p-value", () => {
		const r = computeAbxResult(10, 10);
		expect(r.rounds).toBe(10);
		expect(r.correct).toBe(10);
		// 0.5^10 = 1/1024 ≈ 0.000977
		expect(r.pValue).toBeCloseTo(1 / 1024, 6);
	});

	it("at-chance score → p-value near 0.62", () => {
		// P(X >= 5 | 10, 0.5) = sum k=5..10 of C(10,k)/1024.
		// = (252 + 210 + 120 + 45 + 10 + 1) / 1024 = 638/1024 ≈ 0.6230
		const r = computeAbxResult(5, 10);
		expect(r.pValue).toBeCloseTo(638 / 1024, 6);
	});

	it("strong-signal 8/10 → p-value ≈ 0.0547", () => {
		// P(X >= 8) = (C(10,8) + C(10,9) + C(10,10)) / 1024
		// = (45 + 10 + 1) / 1024 = 56/1024 ≈ 0.0547
		const r = computeAbxResult(8, 10);
		expect(r.pValue).toBeCloseTo(56 / 1024, 6);
	});

	it("zero correct → p-value of 1.0", () => {
		// P(X >= 0) = 1 by definition.
		const r = computeAbxResult(0, 10);
		expect(r.pValue).toBeCloseTo(1, 10);
	});

	it("pValue is always in [0, 1]", () => {
		for (let k = 0; k <= 20; k++) {
			const r = computeAbxResult(k, 20);
			expect(r.pValue).toBeGreaterThanOrEqual(0);
			expect(r.pValue).toBeLessThanOrEqual(1);
		}
	});
});
