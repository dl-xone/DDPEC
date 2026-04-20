import { describe, expect, it } from "vitest";
import {
	describeInlineEdit,
	parseInlineEdit,
} from "./commandPaletteInline.ts";

describe("parseInlineEdit", () => {
	it("parses gain edits", () => {
		const parsed = parseInlineEdit("gain 3 -5");
		expect(parsed).toEqual({ kind: "gain", bandIdx: 3, value: -5 });
	});

	it("parses freq edits", () => {
		expect(parseInlineEdit("freq 1 200")).toEqual({
			kind: "freq",
			bandIdx: 1,
			value: 200,
		});
	});

	it("parses q edits with decimals", () => {
		expect(parseInlineEdit("q 2 1.2")).toEqual({
			kind: "q",
			bandIdx: 2,
			value: 1.2,
		});
	});

	it("parses type edits and upper-cases the type", () => {
		expect(parseInlineEdit("type 4 lsq")).toEqual({
			kind: "type",
			bandIdx: 4,
			value: "LSQ",
		});
	});

	it("parses preamp edits (no band index)", () => {
		expect(parseInlineEdit("preamp -4")).toEqual({
			kind: "preamp",
			bandIdx: 0,
			value: -4,
		});
	});

	it("tolerates multi-space whitespace", () => {
		expect(parseInlineEdit("  gain   3   -5  ")).toEqual({
			kind: "gain",
			bandIdx: 3,
			value: -5,
		});
	});

	it("returns null for unknown keywords", () => {
		expect(parseInlineEdit("foo 1 2")).toBeNull();
		expect(parseInlineEdit("random text")).toBeNull();
	});

	it("returns null for empty / whitespace-only queries", () => {
		expect(parseInlineEdit("")).toBeNull();
		expect(parseInlineEdit("   ")).toBeNull();
	});

	it("returns null for malformed values (non-numeric where number required)", () => {
		expect(parseInlineEdit("gain 1 abc")).toBeNull();
		expect(parseInlineEdit("freq xyz 200")).toBeNull();
		expect(parseInlineEdit("preamp abc")).toBeNull();
	});

	it("returns null for non-positive / non-integer band indices", () => {
		expect(parseInlineEdit("gain 0 -5")).toBeNull();
		expect(parseInlineEdit("gain -2 3")).toBeNull();
		expect(parseInlineEdit("gain 1.5 3")).toBeNull();
	});

	it("returns null for out-of-bounds values", () => {
		expect(parseInlineEdit("gain 1 500")).toBeNull(); // above max
		expect(parseInlineEdit("gain 1 -500")).toBeNull(); // below min
		expect(parseInlineEdit("freq 1 1")).toBeNull(); // below min (10 Hz)
		expect(parseInlineEdit("q 1 0")).toBeNull(); // below min Q
		expect(parseInlineEdit("preamp 1000")).toBeNull(); // above max
	});

	it("returns null for invalid filter types", () => {
		expect(parseInlineEdit("type 1 BOGUS")).toBeNull();
		expect(parseInlineEdit("type 1 ")).toBeNull();
	});

	it("returns null for wrong token count", () => {
		expect(parseInlineEdit("gain 3")).toBeNull();
		expect(parseInlineEdit("gain 3 -5 extra")).toBeNull();
		expect(parseInlineEdit("preamp")).toBeNull();
		expect(parseInlineEdit("preamp -4 extra")).toBeNull();
	});
});

describe("describeInlineEdit", () => {
	it("labels each kind readably", () => {
		expect(
			describeInlineEdit({ kind: "gain", bandIdx: 3, value: -5 }),
		).toBe("Set band 3 gain to -5 dB");
		expect(
			describeInlineEdit({ kind: "freq", bandIdx: 2, value: 1000 }),
		).toBe("Set band 2 freq to 1000 Hz");
		expect(describeInlineEdit({ kind: "q", bandIdx: 1, value: 1.2 })).toBe(
			"Set band 1 Q to 1.2",
		);
		expect(
			describeInlineEdit({ kind: "type", bandIdx: 4, value: "LSQ" }),
		).toBe("Set band 4 type to LSQ");
		expect(
			describeInlineEdit({ kind: "preamp", bandIdx: 0, value: -4 }),
		).toBe("Set pre-amp to -4 dB");
	});
});
