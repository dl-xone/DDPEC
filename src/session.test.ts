import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	flushSession,
	getSession,
	loadSession,
	resetSessionForTest,
	saveSession,
} from "./session.ts";

// Minimal Map-backed localStorage shim. Tests run under node with no DOM,
// so we plumb one onto globalThis for the session module to consume.
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

function uninstallLocalStorage() {
	delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
}

describe("session", () => {
	let store: Map<string, string>;
	beforeEach(() => {
		store = new Map();
		installLocalStorage(store);
		resetSessionForTest();
	});

	afterEach(() => {
		resetSessionForTest();
		uninstallLocalStorage();
	});

	it("loadSession returns empty object when nothing persisted", () => {
		expect(loadSession()).toEqual({});
	});

	it("getSession returns defaults when nothing persisted", () => {
		const s = getSession();
		expect(s.activeSlot).toBe("A");
		expect(s.eqEnabled).toBe(true);
		expect(s.navTab).toBe("dsp");
		expect(s.bottomPanelTab).toBe("tabular");
		expect(s.logTrayExpanded).toBe(false);
		expect(s.selectedPresetId).toBeNull();
		expect(s.lastDeviceKey).toBeNull();
	});

	it("save + load roundtrips a patch", () => {
		saveSession({ activeSlot: "B", navTab: "device", selectedPresetId: "warm" });
		flushSession();
		const loaded = loadSession();
		expect(loaded.activeSlot).toBe("B");
		expect(loaded.navTab).toBe("device");
		expect(loaded.selectedPresetId).toBe("warm");
	});

	it("saveSession merges into existing state rather than replacing", () => {
		saveSession({ activeSlot: "B" });
		saveSession({ navTab: "device" });
		flushSession();
		const loaded = loadSession();
		expect(loaded.activeSlot).toBe("B");
		expect(loaded.navTab).toBe("device");
	});

	it("malformed JSON in storage returns defaults", () => {
		store.set("ddpec.session", "{not json");
		resetSessionForTest();
		expect(loadSession()).toEqual({});
		expect(getSession().activeSlot).toBe("A");
	});

	it("ignores unknown / wrong-type fields when loading", () => {
		store.set(
			"ddpec.session",
			JSON.stringify({
				activeSlot: "C", // invalid enum
				eqEnabled: "yes", // wrong type
				navTab: "device", // valid
				mystery: 42, // unknown
			}),
		);
		const loaded = loadSession();
		expect(loaded.activeSlot).toBeUndefined();
		expect(loaded.eqEnabled).toBeUndefined();
		expect(loaded.navTab).toBe("device");
		expect((loaded as Record<string, unknown>).mystery).toBeUndefined();
	});

	it("flushSession writes pending state immediately", () => {
		saveSession({ logTrayExpanded: true });
		// Before flush, write may still be in debounce window. After flush,
		// the value is definitely in storage.
		flushSession();
		const raw = store.get("ddpec.session");
		expect(raw).toBeTruthy();
		const parsed = JSON.parse(raw ?? "{}");
		expect(parsed.logTrayExpanded).toBe(true);
	});

	it("getSession picks up previously persisted values on cold start", () => {
		store.set(
			"ddpec.session",
			JSON.stringify({ activeSlot: "B", navTab: "device" }),
		);
		resetSessionForTest();
		const s = getSession();
		expect(s.activeSlot).toBe("B");
		expect(s.navTab).toBe("device");
	});
});
