import { describe, expect, it } from "vitest";
import { evaluateNumericInput } from "./numericInput.ts";

describe("evaluateNumericInput", () => {
	it("parses bare numbers", () => {
		expect(evaluateNumericInput("42")).toBe(42);
		expect(evaluateNumericInput("-3.5")).toBe(-3.5);
		expect(evaluateNumericInput("  7  ")).toBe(7);
	});

	it("evaluates arithmetic expressions", () => {
		expect(evaluateNumericInput("3+2")).toBe(5);
		expect(evaluateNumericInput("10 - 4")).toBe(6);
		expect(evaluateNumericInput("2*3")).toBe(6);
		expect(evaluateNumericInput("20/4")).toBe(5);
	});

	it("honors operator precedence", () => {
		expect(evaluateNumericInput("2+3*4")).toBe(14);
		expect(evaluateNumericInput("(2+3)*4")).toBe(20);
	});

	it("handles unary minus on numbers and in subexpressions", () => {
		expect(evaluateNumericInput("-5+3")).toBe(-2);
		expect(evaluateNumericInput("2*(-3)")).toBe(-6);
	});

	it("rejects unsafe characters", () => {
		expect(evaluateNumericInput("alert(1)")).toBeNull();
		expect(evaluateNumericInput("1+a")).toBeNull();
		expect(evaluateNumericInput("window")).toBeNull();
	});

	it("rejects division by zero", () => {
		expect(evaluateNumericInput("1/0")).toBeNull();
	});

	it("returns null for empty / whitespace", () => {
		expect(evaluateNumericInput("")).toBeNull();
		expect(evaluateNumericInput("   ")).toBeNull();
	});

	it("returns null for malformed expressions", () => {
		expect(evaluateNumericInput("1+")).toBeNull();
		expect(evaluateNumericInput("(1+2")).toBeNull();
		expect(evaluateNumericInput("*3")).toBeNull();
	});
});
