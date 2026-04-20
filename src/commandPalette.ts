// Feature 11 — Command palette (Cmd+K / Ctrl+K).
//
// A registry + modal UI for running named commands by keyboard. The
// registry is module-scoped; consumers `registerCommand()` at initState
// time, and the palette surfaces the ones with a truthy `availableWhen()`.
//
// Scoring is a lightweight subsequence fuzzy match:
//   * every query char must appear in order in either `title` or any
//     keyword;
//   * lower score = better match;
//   * word-start matches get a bonus (e.g. "toggle phase" ranks higher
//     than "another phrase");
//   * ties break on shorter title.
//
// No dependencies; the modal is built with vanilla DOM.

import {
	describeInlineEdit,
	type InlineEdit,
	parseInlineEdit,
} from "./commandPaletteInline.ts";

export interface Command {
	id: string;
	title: string;
	keywords?: string[];
	// Display-only shortcut hint (e.g. "⌘K", "Space"). Not wired as an
	// accelerator — callers still register their own hotkeys elsewhere.
	shortcut?: string;
	run: () => void | Promise<void>;
	// Evaluated at open-time; commands that return false are filtered out.
	availableWhen?: () => boolean;
	// Feature H — tags the synthetic inline-edit command so the renderer
	// can apply a distinct CSS class. Normal registry commands omit this.
	kind?: "inline-edit";
}

// Optional handler for inline-edit commands. The DDPEC app wires this in
// initState so the palette can apply edits without commandPalette.ts
// importing from fn.ts (circular reference avoidance).
type InlineEditHandler = (edit: InlineEdit) => void | Promise<void>;
let inlineEditHandler: InlineEditHandler | null = null;

export function setInlineEditHandler(handler: InlineEditHandler | null): void {
	inlineEditHandler = handler;
}

const registry = new Map<string, Command>();

export function registerCommand(cmd: Command): void {
	registry.set(cmd.id, cmd);
}

export function unregisterCommand(id: string): void {
	registry.delete(id);
}

// All commands, regardless of availability. Useful for tests that want
// to poke at the registry directly.
export function listCommands(): Command[] {
	return Array.from(registry.values());
}

// Subset of commands whose availability check passes right now.
export function listAvailableCommands(): Command[] {
	return listCommands().filter((c) => {
		try {
			return c.availableWhen ? c.availableWhen() : true;
		} catch {
			return false;
		}
	});
}

// Score a single command against the query. Lower = better. Returns null
// for no-match. Algorithm:
//   1. Build a haystack = title + " " + keywords.
//   2. Walk the query char-by-char, requiring each to appear (case-insensitive)
//      in order in the haystack.
//   3. Score = sum of gaps between matched positions, + a penalty if the
//      first match isn't at a word start.
//   4. Exact substring match in the title wins (score 0).
export function scoreCommand(cmd: Command, query: string): number | null {
	if (!query) return 0;
	const q = query.toLowerCase();
	const title = cmd.title.toLowerCase();
	const keywordsText = (cmd.keywords ?? []).join(" ").toLowerCase();

	// Exact-substring-in-title wins — used when user types a full word.
	// Shorter titles break ties so concise command labels rank above
	// longer ones that happen to contain the same substring.
	if (title.includes(q)) {
		const idx = title.indexOf(q);
		const atStart = idx === 0 || /\s/.test(title[idx - 1] ?? "");
		return (atStart ? -10 : -5) + title.length * 0.01;
	}
	if (keywordsText.includes(q)) {
		return -3 + title.length * 0.01;
	}

	// Fuzzy subsequence match. Walk the haystack (title + keywords),
	// consuming query chars in order.
	const hay = `${title} ${keywordsText}`;
	let lastIdx = -1;
	let score = 0;
	for (const char of q) {
		const nextIdx = hay.indexOf(char, lastIdx + 1);
		if (nextIdx === -1) return null;
		// Gap penalty: bigger gaps = worse match.
		if (lastIdx >= 0) {
			score += nextIdx - lastIdx - 1;
		} else {
			// First char: bonus (negative score bump) when at a word start.
			const atStart = nextIdx === 0 || /\s/.test(hay[nextIdx - 1] ?? "");
			if (!atStart) score += 2;
		}
		lastIdx = nextIdx;
	}
	// Tie-break: shorter titles first.
	score += title.length * 0.01;
	return score;
}

// Filter + sort commands by a query string. Exported separately from the
// DOM surface so unit tests can poke at the matching logic without a
// fake DOM. Commands whose `availableWhen` returns false are omitted.
//
// Feature H — if the query parses as an inline edit ("gain 3 -5",
// "preamp -4", etc.), prepend a synthetic command whose run() calls the
// registered inline-edit handler. Invalid parses fall through to the
// regular fuzzy search.
export function filterCommands(query: string): Command[] {
	const available = listAvailableCommands();
	const inlineEdit = parseInlineEdit(query);
	let synthetic: Command | null = null;
	if (inlineEdit) {
		synthetic = {
			id: "inline-edit",
			title: describeInlineEdit(inlineEdit),
			kind: "inline-edit",
			run: async () => {
				if (inlineEditHandler) await inlineEditHandler(inlineEdit);
			},
		};
	}

	if (!query) {
		// Stable alphabetical order when no query — the palette opens to
		// a sensible default list rather than whatever insertion order is.
		return available.slice().sort((a, b) => a.title.localeCompare(b.title));
	}
	const scored: Array<{ cmd: Command; score: number }> = [];
	for (const cmd of available) {
		const s = scoreCommand(cmd, query);
		if (s === null) continue;
		scored.push({ cmd, score: s });
	}
	scored.sort((a, b) => a.score - b.score);
	const out = scored.map((s) => s.cmd);
	return synthetic ? [synthetic, ...out] : out;
}

// --------------------- DOM surface ---------------------

let activeDialog: HTMLDialogElement | null = null;

export function isPaletteOpen(): boolean {
	return activeDialog !== null;
}

export function closePalette(): void {
	if (!activeDialog) return;
	const d = activeDialog;
	activeDialog = null;
	try {
		d.close();
	} catch {
		// already closed
	}
	d.remove();
}

export function openPalette(): void {
	// Idempotent: a second open call brings the existing palette forward
	// rather than stacking a second modal.
	if (activeDialog) {
		const input = activeDialog.querySelector<HTMLInputElement>(
			".command-palette-input",
		);
		input?.focus();
		return;
	}

	const dialog = document.createElement("dialog");
	dialog.className = "command-palette";
	dialog.setAttribute("aria-label", "Command palette");

	const input = document.createElement("input");
	input.type = "text";
	input.className = "command-palette-input";
	input.placeholder = "Type a command\u2026";
	input.autocomplete = "off";
	input.spellcheck = false;
	dialog.appendChild(input);

	const list = document.createElement("div");
	list.className = "command-palette-list";
	list.setAttribute("role", "listbox");
	dialog.appendChild(list);

	let currentResults: Command[] = [];
	let selectedIdx = 0;

	function renderResults() {
		list.replaceChildren();
		if (currentResults.length === 0) {
			const empty = document.createElement("div");
			empty.className = "command-palette-empty";
			empty.textContent = "No matches";
			list.appendChild(empty);
			return;
		}
		// Cap at 10 visible without truncating — the list itself scrolls
		// via CSS. We still only render the first N for DOM sanity on
		// very large command sets.
		const MAX_RENDER = 50;
		const shown = currentResults.slice(0, MAX_RENDER);
		for (let i = 0; i < shown.length; i++) {
			const cmd = shown[i];
			const row = document.createElement("button");
			row.type = "button";
			row.className = "command-palette-row";
			if (cmd.kind === "inline-edit") {
				row.classList.add("command-palette-inline-edit");
			}
			row.setAttribute("role", "option");
			if (i === selectedIdx) {
				row.classList.add("is-selected");
				row.setAttribute("aria-selected", "true");
			}
			const title = document.createElement("span");
			title.className = "command-palette-title";
			title.textContent = cmd.title;
			row.appendChild(title);
			if (cmd.shortcut) {
				const kbd = document.createElement("span");
				kbd.className = "command-palette-shortcut";
				kbd.textContent = cmd.shortcut;
				row.appendChild(kbd);
			}
			row.addEventListener("click", () => runAtIndex(i));
			row.addEventListener("mousemove", () => {
				// Hover syncs the selection cursor so clicks feel direct.
				if (selectedIdx !== i) {
					selectedIdx = i;
					renderResults();
				}
			});
			list.appendChild(row);
		}
	}

	function refresh() {
		currentResults = filterCommands(input.value);
		selectedIdx = 0;
		renderResults();
	}

	async function runAtIndex(i: number) {
		const cmd = currentResults[i];
		if (!cmd) return;
		closePalette();
		try {
			await cmd.run();
		} catch (err) {
			console.error(`Command "${cmd.id}" threw:`, err);
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			closePalette();
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			void runAtIndex(selectedIdx);
			return;
		}
		if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
			e.preventDefault();
			if (currentResults.length === 0) return;
			selectedIdx = (selectedIdx + 1) % currentResults.length;
			renderResults();
			return;
		}
		if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
			e.preventDefault();
			if (currentResults.length === 0) return;
			selectedIdx =
				(selectedIdx - 1 + currentResults.length) % currentResults.length;
			renderResults();
			return;
		}
	}

	input.addEventListener("input", refresh);
	dialog.addEventListener("keydown", onKey);
	dialog.addEventListener("close", () => {
		if (activeDialog === dialog) {
			activeDialog = null;
			dialog.remove();
		}
	});
	dialog.addEventListener("cancel", (e) => {
		e.preventDefault();
		closePalette();
	});
	// Click on the backdrop (outside the content box) closes the palette.
	dialog.addEventListener("click", (e) => {
		if (e.target === dialog) closePalette();
	});

	document.body.appendChild(dialog);
	activeDialog = dialog;
	dialog.showModal();
	refresh();
	input.focus();
}
