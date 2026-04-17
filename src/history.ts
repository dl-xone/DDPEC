import type { EQ } from "./main.ts";
import {
	getEqState,
	getGlobalGainState,
	setEqState,
	setGlobalGainState,
} from "./state.ts";

interface Snapshot {
	eq: EQ;
	gain: number;
}

const MAX_HISTORY = 50;
// Coalesce rapid edits (e.g. a drag) into one undo boundary so undo
// doesn't have to step through every animation frame of change.
const COALESCE_MS = 400;

const past: Snapshot[] = [];
const future: Snapshot[] = [];
let lastPushAt = 0;

function take(): Snapshot {
	return {
		eq: structuredClone(getEqState()),
		gain: getGlobalGainState(),
	};
}

function apply(snap: Snapshot) {
	setEqState(snap.eq);
	setGlobalGainState(snap.gain);
}

// Record the current state as a new undo boundary. Call BEFORE applying
// a mutation so the boundary captures the pre-change value. Rapid
// successive calls within COALESCE_MS are dropped.
export function snapshot() {
	const now = Date.now();
	if (now - lastPushAt < COALESCE_MS && past.length > 0) return;
	past.push(take());
	if (past.length > MAX_HISTORY) past.shift();
	future.length = 0;
	lastPushAt = now;
}

export function undo(): Snapshot | null {
	if (past.length === 0) return null;
	const snap = past.pop();
	if (!snap) return null;
	future.push(take());
	apply(snap);
	lastPushAt = 0;
	return snap;
}

export function redo(): Snapshot | null {
	if (future.length === 0) return null;
	const snap = future.pop();
	if (!snap) return null;
	past.push(take());
	apply(snap);
	lastPushAt = 0;
	return snap;
}

export function clearHistory() {
	past.length = 0;
	future.length = 0;
	lastPushAt = 0;
}

export function canUndo(): boolean {
	return past.length > 0;
}

export function canRedo(): boolean {
	return future.length > 0;
}

// ---- localStorage persistence --------------------------------------

const STORAGE_PREFIX = "ddpec.profile.";

interface PersistedProfile {
	version: 1;
	eq: EQ;
	gain: number;
	savedAt: string;
}

export function persistProfile(configKey: string) {
	try {
		const data: PersistedProfile = {
			version: 1,
			eq: getEqState(),
			gain: getGlobalGainState(),
			savedAt: new Date().toISOString(),
		};
		localStorage.setItem(STORAGE_PREFIX + configKey, JSON.stringify(data));
	} catch {
		// Storage full / disabled — silently skip; not worth interrupting the user.
	}
}

export function loadPersistedProfile(configKey: string): PersistedProfile | null {
	try {
		const raw = localStorage.getItem(STORAGE_PREFIX + configKey);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as PersistedProfile;
		if (parsed.version !== 1 || !Array.isArray(parsed.eq)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function clearPersistedProfile(configKey: string) {
	try {
		localStorage.removeItem(STORAGE_PREFIX + configKey);
	} catch {}
}
