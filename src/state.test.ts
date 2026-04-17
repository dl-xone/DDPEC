import { beforeEach, describe, expect, it } from "vitest";
import {
	defaultEqState,
	getActiveSlot,
	getEqState,
	getGlobalGainState,
	getInactiveEq,
	getInactiveGain,
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
});
