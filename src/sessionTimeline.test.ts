import { beforeEach, describe, expect, it } from "vitest";
import {
	clearTimeline,
	getEntry,
	getTimeline,
	recordEvent,
	resetTimelineForTest,
	restoreEvent,
} from "./sessionTimeline.ts";
import {
	defaultEqState,
	getEqState,
	getGlobalGainState,
	resetSlots,
	setEqState,
	setGlobalGainState,
} from "./state.ts";

beforeEach(() => {
	resetTimelineForTest();
	resetSlots(defaultEqState(null), 0);
});

describe("sessionTimeline", () => {
	it("records + retrieves events in order", () => {
		recordEvent("Loaded preset: Bass Boost");
		recordEvent("Synced to RAM");
		const tl = getTimeline();
		expect(tl).toHaveLength(2);
		expect(tl[0].label).toBe("Loaded preset: Bass Boost");
		expect(tl[0].category).toBe("preset");
		expect(tl[1].category).toBe("sync");
	});

	it("captures a deep copy of EQ state at record time", () => {
		recordEvent("baseline");
		// Mutate state after recording — snapshot must not follow.
		const before = getEqState();
		if (before[0]) before[0].gain = 99;
		setEqState(before);
		const entry = getTimeline()[0];
		expect(entry.eq[0].gain).toBe(0);
	});

	it("caps at 200 entries and drops oldest first", () => {
		for (let i = 0; i < 205; i++) recordEvent(`event ${i}`);
		const tl = getTimeline();
		expect(tl).toHaveLength(200);
		expect(tl[0].label).toBe("event 5");
		expect(tl[199].label).toBe("event 204");
	});

	it("restoreEvent applies the snapshotted state", () => {
		// Baseline: record a clean state.
		const recorded = recordEvent("clean");
		// Mutate live state.
		const bands = getEqState();
		bands[0].gain = 12;
		setEqState(bands);
		setGlobalGainState(-5);
		// Restore.
		expect(restoreEvent(recorded.id)).toBe(true);
		expect(getEqState()[0].gain).toBe(0);
		expect(getGlobalGainState()).toBe(0);
	});

	it("restoreEvent returns false for unknown ids", () => {
		expect(restoreEvent("tl-does-not-exist")).toBe(false);
	});

	it("categorizes labels by prefix", () => {
		recordEvent("Loaded preset: Foo");
		recordEvent("Synced to RAM");
		recordEvent("Wrote to flash");
		recordEvent("AutoEQ fit (8 bands)");
		recordEvent("Switched to slot B");
		recordEvent("Swapped A ↔ B");
		recordEvent("Added band at 4 kHz");
		recordEvent("Removed band at 12 kHz");
		recordEvent("Reset to defaults");
		recordEvent("Something random");
		const cats = getTimeline().map((e) => e.category);
		expect(cats).toEqual([
			"preset",
			"sync",
			"flash",
			"autoeq",
			"slot",
			"slot",
			"band",
			"band",
			"reset",
			"other",
		]);
	});

	it("getEntry returns the matching entry", () => {
		const entry = recordEvent("x");
		expect(getEntry(entry.id)).toBe(getTimeline()[0]);
	});

	it("clearTimeline wipes all entries", () => {
		recordEvent("a");
		recordEvent("b");
		clearTimeline();
		expect(getTimeline()).toHaveLength(0);
	});
});
