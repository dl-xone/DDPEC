import { describe, expect, it } from "vitest";
import { applyPreset, PRESETS } from "./presets.ts";

const DEFAULT_FREQS_8 = [40, 100, 250, 500, 1000, 3000, 8000, 16000];

describe("applyPreset", () => {
	it("fills the device with flat bands when the preset is empty", () => {
		const flat = PRESETS.find((p) => p.id === "flat");
		if (!flat) throw new Error("flat preset missing");
		const eq = applyPreset(flat, 8, DEFAULT_FREQS_8);
		expect(eq).toHaveLength(8);
		for (let i = 0; i < 8; i++) {
			expect(eq[i].gain).toBe(0);
			expect(eq[i].freq).toBe(DEFAULT_FREQS_8[i]);
			expect(eq[i].type).toBe("PK");
			expect(eq[i].index).toBe(i);
		}
	});

	it("occupies leading slots and leaves trailing slots flat", () => {
		const warm = PRESETS.find((p) => p.id === "warm");
		if (!warm) throw new Error("warm preset missing");
		const eq = applyPreset(warm, 8, DEFAULT_FREQS_8);
		expect(eq).toHaveLength(8);
		// Two preset bands at slot 0-1
		expect(eq[0].gain).toBe(3);
		expect(eq[0].type).toBe("LSQ");
		expect(eq[1].gain).toBe(-2);
		expect(eq[1].type).toBe("HSQ");
		// Remaining slots flat
		for (let i = 2; i < 8; i++) {
			expect(eq[i].gain).toBe(0);
			expect(eq[i].freq).toBe(DEFAULT_FREQS_8[i]);
		}
	});

	it("truncates preset bands that exceed the device slot count", () => {
		const truncate = {
			id: "synthetic",
			name: "syn",
			description: "",
			bands: Array.from({ length: 12 }, (_, i) => ({
				freq: 100 + i * 100,
				gain: 1,
				q: 0.7,
				type: "PK" as const,
			})),
		};
		const eq = applyPreset(truncate, 8, DEFAULT_FREQS_8);
		expect(eq).toHaveLength(8);
		// All 8 slots occupied with preset values
		for (let i = 0; i < 8; i++) expect(eq[i].gain).toBe(1);
	});

	it("respects band indices", () => {
		const eq = applyPreset(
			PRESETS[0], // flat
			5,
			[100, 200, 300, 400, 500],
		);
		eq.forEach((band, i) => expect(band.index).toBe(i));
	});
});
