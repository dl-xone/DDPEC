import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addUserPreset,
	applyPreset,
	deleteUserPreset,
	eqToPresetBands,
	getAllPresets,
	isUserPresetId,
	loadUserPresets,
	PRESETS,
	updateUserPreset,
} from "./presets.ts";

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

// --- user preset CRUD ---------------------------------------------------

function installLocalStorage(store: Map<string, string>) {
	const shim = {
		getItem(key: string) {
			return store.has(key) ? (store.get(key) ?? null) : null;
		},
		setItem(key: string, value: string) {
			store.set(key, String(value));
		},
		removeItem(key: string) {
			store.delete(key);
		},
		clear() {
			store.clear();
		},
		key(i: number) {
			return Array.from(store.keys())[i] ?? null;
		},
		get length() {
			return store.size;
		},
	};
	(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;
}

describe("user presets", () => {
	let store: Map<string, string>;
	beforeEach(() => {
		store = new Map();
		installLocalStorage(store);
	});
	afterEach(() => {
		delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
	});

	it("round-trips add + load", () => {
		const saved = addUserPreset({
			name: "My tuning",
			description: "hand-tuned",
			bands: [{ freq: 100, gain: 3, q: 0.7, type: "PK" }],
			preamp: -2,
		});
		expect(isUserPresetId(saved.id)).toBe(true);
		expect(saved.isUser).toBe(true);

		const list = loadUserPresets();
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe("My tuning");
		expect(list[0].preamp).toBe(-2);
	});

	it("update patches an existing user preset", () => {
		const saved = addUserPreset({
			name: "v1",
			description: "",
			bands: [],
		});
		const updated = updateUserPreset(saved.id, {
			name: "v2",
			bands: [{ freq: 500, gain: 1, q: 1, type: "PK" }],
		});
		expect(updated?.name).toBe("v2");
		expect(loadUserPresets()[0].bands).toHaveLength(1);
	});

	it("update rejects built-in ids", () => {
		expect(updateUserPreset("flat", { name: "hacked" })).toBeNull();
	});

	it("delete removes the user preset and rejects built-ins", () => {
		const saved = addUserPreset({ name: "gone", description: "", bands: [] });
		expect(deleteUserPreset(saved.id)).toBe(true);
		expect(loadUserPresets()).toHaveLength(0);
		expect(deleteUserPreset("flat")).toBe(false);
	});

	it("getAllPresets concatenates built-ins then user presets", () => {
		addUserPreset({ name: "mine", description: "", bands: [] });
		const all = getAllPresets();
		expect(all.length).toBe(PRESETS.length + 1);
		expect(all[PRESETS.length].name).toBe("mine");
	});

	it("eqToPresetBands trims trailing flat bands", () => {
		const eq = [
			{ freq: 100, gain: 2, q: 0.7, type: "PK", enabled: true },
			{ freq: 1000, gain: 0, q: 0.7, type: "PK", enabled: true },
			{ freq: 8000, gain: 0, q: 0.7, type: "PK", enabled: true },
		];
		const bands = eqToPresetBands(eq);
		expect(bands).toHaveLength(1);
		expect(bands[0].gain).toBe(2);
	});
});
