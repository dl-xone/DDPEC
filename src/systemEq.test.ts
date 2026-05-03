import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Band } from "./main.ts";

// Vitest's default `node` env doesn't expose localStorage. Stub it before
// importing systemEq.ts so module-level loadPreferences() finds the API.
class MemoryStorage {
	private store = new Map<string, string>();
	get length(): number {
		return this.store.size;
	}
	clear(): void {
		this.store.clear();
	}
	getItem(key: string): string | null {
		return this.store.has(key) ? (this.store.get(key) ?? null) : null;
	}
	setItem(key: string, value: string): void {
		this.store.set(key, String(value));
	}
	removeItem(key: string): void {
		this.store.delete(key);
	}
	key(idx: number): string | null {
		return Array.from(this.store.keys())[idx] ?? null;
	}
}
if (typeof globalThis.localStorage === "undefined") {
	(globalThis as unknown as { localStorage: Storage }).localStorage =
		new MemoryStorage() as unknown as Storage;
}

import {
	_internal,
	DEFAULT_LATENCY,
	getSystemEqState,
	isSystemEqActive,
	setSystemEqInput,
	setSystemEqLatency,
} from "./systemEq.ts";

const KEY = _internal.STORAGE_KEY;

describe("systemEq — pure logic", () => {
	it("gainDbToLinear matches 10^(db/20)", () => {
		expect(_internal.gainDbToLinear(0)).toBeCloseTo(1, 6);
		expect(_internal.gainDbToLinear(20)).toBeCloseTo(10, 6);
		expect(_internal.gainDbToLinear(-20)).toBeCloseTo(0.1, 6);
		expect(_internal.gainDbToLinear(6)).toBeCloseTo(1.9952, 3);
	});

	it("isValidLatency accepts the three string tokens and rejects everything else", () => {
		expect(_internal.isValidLatency("tight")).toBe(true);
		expect(_internal.isValidLatency("balanced")).toBe(true);
		expect(_internal.isValidLatency("comfortable")).toBe(true);
		expect(_internal.isValidLatency("ultra")).toBe(false);
		expect(_internal.isValidLatency(0)).toBe(false);
		expect(_internal.isValidLatency(undefined)).toBe(false);
	});

	it("TYPE_MAP covers every internal filter token", () => {
		// If the band schema grows new types, this test should fail loudly
		// so the chain builder isn't silently downgrading them to peaking.
		const expected = ["PK", "LSQ", "HSQ", "HPQ", "LPQ", "NO", "BPQ"];
		for (const t of expected) {
			expect(_internal.TYPE_MAP[t]).toBeDefined();
		}
	});
});

describe("systemEq — preferences persistence", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		localStorage.clear();
	});

	it("loadPreferences returns safe defaults when storage is empty", () => {
		const prefs = _internal.loadPreferences();
		expect(prefs.active).toBe(false);
		expect(prefs.inputDeviceId).toBeNull();
		expect(prefs.outputDeviceId).toBeNull();
		expect(prefs.latency).toBe(DEFAULT_LATENCY);
	});

	it("loadPreferences hydrates from storage but never auto-activates", () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({
				active: true, // attempt to restore active=true
				inputDeviceId: "blackhole-id",
				outputDeviceId: "akl-id",
				latency: "tight",
			}),
		);
		const prefs = _internal.loadPreferences();
		// active is forced to false — engagement requires a user gesture.
		expect(prefs.active).toBe(false);
		expect(prefs.inputDeviceId).toBe("blackhole-id");
		expect(prefs.outputDeviceId).toBe("akl-id");
		expect(prefs.latency).toBe("tight");
	});

	it("loadPreferences ignores malformed JSON", () => {
		localStorage.setItem(KEY, "not-json{{{");
		const prefs = _internal.loadPreferences();
		expect(prefs.latency).toBe(DEFAULT_LATENCY);
		expect(prefs.inputDeviceId).toBeNull();
	});

	it("loadPreferences sanitises bogus latency values", () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({ latency: "ultra-fast", inputDeviceId: null }),
		);
		const prefs = _internal.loadPreferences();
		expect(prefs.latency).toBe(DEFAULT_LATENCY);
	});

	it("setSystemEqInput persists without engaging", () => {
		setSystemEqInput("test-device");
		expect(getSystemEqState().inputDeviceId).toBe("test-device");
		expect(isSystemEqActive()).toBe(false);
		const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		expect(stored.inputDeviceId).toBe("test-device");
	});

	it("setSystemEqLatency persists the chosen latency", () => {
		setSystemEqLatency("tight");
		expect(getSystemEqState().latency).toBe("tight");
		const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		expect(stored.latency).toBe("tight");
	});

	it("persisted state never includes active=true", () => {
		setSystemEqInput("x");
		setSystemEqLatency("balanced");
		const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		// active is intentionally not part of the persisted shape — engagement
		// is per-session and gated on user gesture (mic permission).
		expect(stored.active).toBeUndefined();
	});
});

describe("systemEq — biquad chain construction", () => {
	// Lightweight fake AudioContext that captures node creation. We only
	// need enough surface for buildSystemEqChain to run; no scheduling.
	function makeFakeContext() {
		const created: BiquadFilterNode[] = [];
		const ctx = {
			createBiquadFilter() {
				const node = {
					type: "peaking" as BiquadFilterType,
					frequency: { value: 0 },
					Q: { value: 0 },
					gain: { value: 0 },
					connect() {},
					disconnect() {},
				} as unknown as BiquadFilterNode;
				created.push(node);
				return node;
			},
		} as unknown as AudioContext;
		return { ctx, created };
	}

	function band(partial: Partial<Band>): Band {
		return {
			index: 0,
			freq: 1000,
			gain: 0,
			q: 1,
			type: "PK",
			enabled: true,
			...partial,
		};
	}

	it("skips disabled bands", async () => {
		const { ctx, created } = makeFakeContext();
		const { buildSystemEqChain } = await import("./systemEq.ts");
		const out = buildSystemEqChain(ctx, [
			band({ enabled: true, freq: 100 }),
			band({ enabled: false, freq: 200 }),
			band({ enabled: true, freq: 300 }),
		]);
		expect(out).toHaveLength(2);
		expect(created).toHaveLength(2);
		expect(out[0].frequency.value).toBe(100);
		expect(out[1].frequency.value).toBe(300);
	});

	it("maps every internal type to its Web Audio counterpart", async () => {
		const { ctx } = makeFakeContext();
		const { buildSystemEqChain } = await import("./systemEq.ts");
		const out = buildSystemEqChain(ctx, [
			band({ type: "PK" }),
			band({ type: "LSQ" }),
			band({ type: "HSQ" }),
			band({ type: "HPQ" }),
			band({ type: "LPQ" }),
			band({ type: "NO" }),
			band({ type: "BPQ" }),
		]);
		expect(out.map((n) => n.type)).toEqual([
			"peaking",
			"lowshelf",
			"highshelf",
			"highpass",
			"lowpass",
			"notch",
			"bandpass",
		]);
	});

	it("falls back to peaking for unknown types", async () => {
		const { ctx } = makeFakeContext();
		const { buildSystemEqChain } = await import("./systemEq.ts");
		const out = buildSystemEqChain(ctx, [band({ type: "MYSTERY" })]);
		expect(out[0].type).toBe("peaking");
	});

	it("forwards freq, Q and gain verbatim", async () => {
		const { ctx } = makeFakeContext();
		const { buildSystemEqChain } = await import("./systemEq.ts");
		const out = buildSystemEqChain(ctx, [
			band({ freq: 1234, q: 2.5, gain: -3.5 }),
		]);
		expect(out[0].frequency.value).toBe(1234);
		expect(out[0].Q.value).toBe(2.5);
		expect(out[0].gain.value).toBe(-3.5);
	});
});
