import { beforeEach, describe, expect, it } from "vitest";
import type { Band } from "./main.ts";
import {
	addBand,
	defaultEqState,
	getActiveSlot,
	getEqState,
	getGlobalGainState,
	getInactiveEq,
	getInactiveGain,
	removeBandAt,
	resetSlots,
	setActiveSlot,
	setBandField,
	setEqState,
	setGlobalGainState,
	swapSlots,
} from "./state.ts";

beforeEach(() => {
	resetSlots(defaultEqState(null), 0);
});

describe("state A/B slots", () => {
	it("defaults to slot A", () => {
		expect(getActiveSlot()).toBe("A");
	});

	it("writes isolate between slots", () => {
		setGlobalGainState(5);
		setActiveSlot("B");
		setGlobalGainState(-3);

		setActiveSlot("A");
		expect(getGlobalGainState()).toBe(5);
		setActiveSlot("B");
		expect(getGlobalGainState()).toBe(-3);
	});

	it("exposes the inactive slot's EQ and gain", () => {
		setGlobalGainState(4);
		setActiveSlot("B");
		setGlobalGainState(-6);

		// Active B, inactive A
		expect(getGlobalGainState()).toBe(-6);
		expect(getInactiveGain()).toBe(4);

		setActiveSlot("A");
		expect(getInactiveGain()).toBe(-6);
	});

	it("swap exchanges the contents of A and B (active label stays)", () => {
		setGlobalGainState(2);
		setActiveSlot("B");
		setGlobalGainState(-2);
		setActiveSlot("A");

		swapSlots();
		// Active is still A, but its contents now = previous B
		expect(getActiveSlot()).toBe("A");
		expect(getGlobalGainState()).toBe(-2);
		setActiveSlot("B");
		expect(getGlobalGainState()).toBe(2);
	});

	it("setBandField only touches the active slot", () => {
		setBandField(0, "gain", 6);
		setActiveSlot("B");
		expect(getEqState()[0].gain).toBe(0);
		setActiveSlot("A");
		expect(getEqState()[0].gain).toBe(6);
	});

	it("resetSlots wipes both slots and returns to slot A", () => {
		setGlobalGainState(10);
		setActiveSlot("B");
		setGlobalGainState(-10);

		resetSlots(defaultEqState(null), 0);
		expect(getActiveSlot()).toBe("A");
		expect(getGlobalGainState()).toBe(0);
		setActiveSlot("B");
		expect(getGlobalGainState()).toBe(0);
	});

	it("setEqState replaces the active slot's EQ without touching the inactive one", () => {
		setBandField(0, "gain", 3);
		setActiveSlot("B");
		setBandField(0, "gain", -3);
		setActiveSlot("A");

		const replacement = defaultEqState(null);
		replacement[0].gain = 9;
		setEqState(replacement);

		expect(getEqState()[0].gain).toBe(9);
		expect(getInactiveEq()[0].gain).toBe(-3);
	});

	it("addBand appends to the active slot only", () => {
		const startLen = getEqState().length;
		const newBand: Band = {
			index: 99,
			freq: 1234,
			gain: 2,
			q: 1.2,
			type: "PK",
			enabled: true,
		};
		addBand(newBand);
		expect(getEqState()).toHaveLength(startLen + 1);
		expect(getEqState()[startLen].freq).toBe(1234);

		// Inactive slot untouched.
		setActiveSlot("B");
		expect(getEqState()).toHaveLength(startLen);
	});

	it("removeBandAt removes the band at the given array position", () => {
		const before = getEqState().length;
		const removed = removeBandAt(0);
		expect(removed).not.toBeNull();
		expect(getEqState()).toHaveLength(before - 1);
	});

	it("removeBandAt returns null for out-of-range indices", () => {
		expect(removeBandAt(-1)).toBeNull();
		expect(removeBandAt(999)).toBeNull();
	});
});
