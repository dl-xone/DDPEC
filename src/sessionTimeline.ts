// Feature I — named session timeline of state-changing events.
//
// A parallel layer to history.ts: undo/redo still works normally, but this
// captures *named* moments ("Loaded preset: Warm", "Synced to RAM",
// "AutoEQ fit 8 bands, MSE 3.2→0.4") with a timestamp and full EQ
// snapshot. The UI renders these as colored dots above the log tray.
// Shift-clicking a dot restores that state; plain click previews it.
//
// Capped at MAX_ENTRIES to bound memory on long sessions — oldest drops.

import type { Band } from "./main.ts";
import {
	getEqState,
	getGlobalGainState,
	setEqState,
	setGlobalGainState,
} from "./state.ts";

export type TimelineCategory =
	| "preset"
	| "sync"
	| "flash"
	| "autoeq"
	| "slot"
	| "band"
	| "reset"
	| "other";

export interface TimelineEntry {
	id: string;
	ts: number;
	label: string;
	category: TimelineCategory;
	eq: Band[];
	globalGain: number;
}

const MAX_ENTRIES = 200;
let entries: TimelineEntry[] = [];
let idCounter = 0;

// Infer a category from the label prefix. Keeps the call sites simple —
// they just pass a human-readable string. Categories drive dot colors
// in the UI.
function categorize(label: string): TimelineCategory {
	const lower = label.toLowerCase();
	if (lower.startsWith("loaded preset")) return "preset";
	if (lower.startsWith("synced")) return "sync";
	if (lower.startsWith("wrote to flash") || lower.startsWith("saved to flash"))
		return "flash";
	if (lower.startsWith("autoeq")) return "autoeq";
	if (lower.startsWith("switched to slot") || lower.startsWith("swapped"))
		return "slot";
	if (lower.startsWith("added band") || lower.startsWith("removed band"))
		return "band";
	if (lower.startsWith("reset")) return "reset";
	return "other";
}

function nextId(): string {
	idCounter += 1;
	return `tl-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Record the current EQ state as a new timeline entry. Label is shown in
 * the hover tooltip and the log tray. Oldest entry drops once past the cap.
 */
export function recordEvent(label: string): TimelineEntry {
	const entry: TimelineEntry = {
		id: nextId(),
		ts: Date.now(),
		label,
		category: categorize(label),
		eq: structuredClone(getEqState()),
		globalGain: getGlobalGainState(),
	};
	entries.push(entry);
	// Cap — drop oldest until under MAX_ENTRIES.
	while (entries.length > MAX_ENTRIES) entries.shift();
	if (typeof document !== "undefined") {
		document.dispatchEvent(
			new CustomEvent("ddpec:timeline-change", { detail: { entry } }),
		);
	}
	return entry;
}

export function getTimeline(): TimelineEntry[] {
	return entries.slice();
}

/**
 * Find an entry by id, or null if not present.
 */
export function getEntry(id: string): TimelineEntry | null {
	return entries.find((e) => e.id === id) ?? null;
}

/**
 * Restore the state captured by a timeline entry. Goes through the
 * noisy setEqState path so dirty-change observers fire and the commit
 * bar reflects the restored state.
 */
export function restoreEvent(id: string): boolean {
	const entry = getEntry(id);
	if (!entry) return false;
	setEqState(structuredClone(entry.eq));
	setGlobalGainState(entry.globalGain);
	return true;
}

export function clearTimeline(): void {
	entries = [];
	if (typeof document !== "undefined") {
		document.dispatchEvent(new CustomEvent("ddpec:timeline-change"));
	}
}

// Test-only helper: reset module state so tests don't leak between runs.
export function resetTimelineForTest(): void {
	entries = [];
	idCounter = 0;
}
