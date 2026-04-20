import { beforeEach, describe, expect, it } from "vitest";
import {
	canRedo,
	canUndo,
	clearHistory,
	redo,
	snapshot,
	undo,
} from "./history.ts";
import type { Band } from "./main.ts";
import {
	getEqState,
	getGlobalGainState,
	setEqState,
	setGlobalGainState,
} from "./state.ts";

function freshEq(): Band[] {
	return [
		{
			index: 0,
			freq: 1000,
			gain: 0,
			q: 1,
			type: "PK",
			enabled: true,
		},
	];
}

beforeEach(() => {
	clearHistory();
	setEqState(freshEq());
	setGlobalGainState(0);
});

describe("history", () => {
	it("undo replays the pre-change state", () => {
		snapshot(); // capture { gain: 0 }
		setGlobalGainState(5);

		expect(canUndo()).toBe(true);
		undo();

		expect(getGlobalGainState()).toBe(0);
		expect(canRedo()).toBe(true);
	});

	it("redo restores the post-change state", () => {
		snapshot();
		setGlobalGainState(5);
		undo();

		redo();
		expect(getGlobalGainState()).toBe(5);
	});

	it("mutations after undo discard the redo stack", async () => {
		snapshot();
		setGlobalGainState(5);
		undo();
		expect(canRedo()).toBe(true);

		// Allow coalesce window to elapse so the next snapshot pushes.
		await new Promise((r) => setTimeout(r, 450));
		snapshot();
		setGlobalGainState(10);
		expect(canRedo()).toBe(false);
	});

	it("returns null when undo stack is empty", () => {
		expect(undo()).toBeNull();
		expect(canUndo()).toBe(false);
	});

	it("coalesces rapid snapshots into a single undo boundary", () => {
		snapshot();
		setGlobalGainState(1);
		snapshot(); // coalesced — within 400 ms
		setGlobalGainState(2);
		snapshot(); // coalesced
		setGlobalGainState(3);

		undo();
		// Single undo rewinds past all three edits to the first boundary.
		expect(getGlobalGainState()).toBe(0);
	});

	it("deep-clones the EQ so later mutations don't leak into history", () => {
		snapshot();
		getEqState()[0].gain = 3;
		undo();
		expect(getEqState()[0].gain).toBe(0);
	});
});
