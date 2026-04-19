import { beforeEach, describe, expect, it } from "vitest";
import {
	type Command,
	filterCommands,
	listCommands,
	registerCommand,
	scoreCommand,
	unregisterCommand,
} from "./commandPalette.ts";

function clearRegistry() {
	for (const cmd of listCommands()) unregisterCommand(cmd.id);
}

function makeCommand(
	id: string,
	title: string,
	extras: Partial<Command> = {},
): Command {
	return {
		id,
		title,
		run: () => {},
		...extras,
	};
}

describe("commandPalette", () => {
	beforeEach(() => {
		clearRegistry();
	});

	it("registers and unregisters commands", () => {
		registerCommand(makeCommand("test.a", "Alpha"));
		expect(listCommands().map((c) => c.id)).toContain("test.a");
		unregisterCommand("test.a");
		expect(listCommands().map((c) => c.id)).not.toContain("test.a");
	});

	it("returns alphabetical list when query is empty", () => {
		registerCommand(makeCommand("b", "Bravo"));
		registerCommand(makeCommand("a", "Alpha"));
		registerCommand(makeCommand("c", "Charlie"));
		const out = filterCommands("");
		expect(out.map((c) => c.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
	});

	it("filters commands by substring", () => {
		registerCommand(makeCommand("x", "Sync to RAM"));
		registerCommand(makeCommand("y", "Save to flash"));
		registerCommand(makeCommand("z", "Undo"));
		const out = filterCommands("sync");
		expect(out.map((c) => c.id)).toEqual(["x"]);
	});

	it("scores word-start matches higher than mid-word matches", () => {
		const start = makeCommand("a", "Toggle phase");
		const mid = makeCommand("b", "Another phrase");
		registerCommand(start);
		registerCommand(mid);
		const out = filterCommands("ph");
		// "Toggle phase" should appear before "Another phrase" because
		// "ph" starts a word in the former's title.
		expect(out[0].id).toBe("a");
	});

	it("supports fuzzy subsequence match", () => {
		registerCommand(makeCommand("cp", "Open command palette"));
		registerCommand(makeCommand("ks", "Keyboard shortcuts"));
		const out = filterCommands("ocp");
		expect(out.map((c) => c.id)).toContain("cp");
	});

	it("respects keywords for matching", () => {
		registerCommand(
			makeCommand("x", "Bypass", {
				keywords: ["mute", "disable eq"],
			}),
		);
		const out = filterCommands("mute");
		expect(out.map((c) => c.id)).toContain("x");
	});

	it("filters out commands whose availableWhen returns false", () => {
		registerCommand(
			makeCommand("ok", "Always Available"),
		);
		registerCommand(
			makeCommand("no", "Never Available", {
				availableWhen: () => false,
			}),
		);
		const out = filterCommands("available");
		const ids = out.map((c) => c.id);
		expect(ids).toContain("ok");
		expect(ids).not.toContain("no");
	});

	it("excludes commands that don't match at all", () => {
		registerCommand(makeCommand("x", "Alpha"));
		const out = filterCommands("zzz");
		expect(out.map((c) => c.id)).not.toContain("x");
	});

	it("scoreCommand returns null for impossible subsequence", () => {
		const cmd = makeCommand("x", "Alpha");
		expect(scoreCommand(cmd, "z")).toBeNull();
	});

	it("scoreCommand returns 0 for empty query", () => {
		const cmd = makeCommand("x", "Alpha");
		expect(scoreCommand(cmd, "")).toBe(0);
	});
});
