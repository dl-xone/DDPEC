import { DEFAULT_FREQS } from "./constants.ts";
import type { DeviceConfig } from "./deviceConfig.ts";
import type { Band, EQ } from "./main.ts";

// Single source of truth for mutable app state. Owned here so that
// protocol code (dsp.ts) can read it without a back-edge to fn.ts.
//
// A/B slots: two independent in-memory EQ copies ("A" and "B"); the
// one pointed to by `activeSlot` backs the shared `eq` / `globalGain`
// view that the rest of the app reads and writes.
export type SlotName = "A" | "B";

interface SlotContents {
	eq: EQ;
	gain: number;
}

interface AppState {
	device: HIDDevice | null;
	config: DeviceConfig | null;
	slotId: number;
	slots: Record<SlotName, SlotContents>;
	activeSlot: SlotName;
}

const state: AppState = {
	device: null,
	config: null,
	slotId: 101,
	slots: {
		A: { eq: defaultEqState(null), gain: 0 },
		B: { eq: defaultEqState(null), gain: 0 },
	},
	activeSlot: "A",
};

// Wave 4.10: per-slot "unsaved changes since last sync" flag. A and B track
// independently so a user who flashes A then edits B can switch back to A
// without a spurious prompt.
const dirty: Record<SlotName, boolean> = { A: false, B: false };

// JDS pivot 2026-04-17: emit `ddpec:dirty-change` whenever dirty flips so UI
// observers (commit bar visibility, preset-changed chip) can react without
// polling. Event fires on every transition, not every mutation — noisy calls
// coalesce when the flag is already set.
let lastDirtyBroadcast: boolean | null = null;
function broadcastDirty() {
	const now = dirty.A || dirty.B;
	if (now === lastDirtyBroadcast) return;
	lastDirtyBroadcast = now;
	if (typeof document !== "undefined") {
		document.dispatchEvent(
			new CustomEvent("ddpec:dirty-change", { detail: { dirty: now } }),
		);
	}
}

// Per-edit broadcast. System EQ subscribes so its live audio graph reflects
// band changes in real time; the dirty-change event above is too coarse
// (only fires on the false→true transition, not every keystroke).
function broadcastBandEdit() {
	if (typeof document === "undefined") return;
	document.dispatchEvent(new CustomEvent("ddpec:band-edit"));
}

// Feature 4 — "changed vs preset" dot. Snapshotting the loaded preset's
// band tuple lets the canvas decorate bands the user has since edited.
// Null means no preset is the baseline (fresh session or factory reset) —
// in that state, nothing draws, so a blank app doesn't spam dots.
let loadedPresetSnapshot: Band[] | null = null;

export function setLoadedPresetSnapshot(bands: Band[] | null) {
	loadedPresetSnapshot = bands ? structuredClone(bands) : null;
}

export function getLoadedPresetSnapshot(): Band[] | null {
	return loadedPresetSnapshot;
}

// Compare the live band at `bandIndex` (hardware slot / band.index, not
// array position — so sort shuffles don't fool us) against the snapshot.
// Excludes `enabled` so the solo/mute toggle doesn't spam dots, and
// excludes `index` itself (which is identity, not tuning). A band added
// after the preset loaded has no snapshot entry → counts as "changed".
export function isBandChangedVsPreset(bandIndex: number): boolean {
	if (!loadedPresetSnapshot) return false;
	const live = state.slots[state.activeSlot].eq.find(
		(b) => b.index === bandIndex,
	);
	if (!live) return false;
	const snap = loadedPresetSnapshot.find((b) => b.index === bandIndex);
	if (!snap) return true; // new band post-preset-load → changed.
	return (
		live.freq !== snap.freq ||
		live.gain !== snap.gain ||
		live.q !== snap.q ||
		live.type !== snap.type
	);
}

// JDS pivot: soft-global "EQ enabled" flag. Consumers (peq.ts / dsp.ts) can
// read via `isEqEnabled()` and listen for `ddpec:eq-toggled`. Default on.
let eqEnabled = true;
export function isEqEnabled(): boolean {
	return eqEnabled;
}
export function setEqEnabled(on: boolean) {
	if (eqEnabled === on) return;
	eqEnabled = on;
	if (typeof document !== "undefined") {
		document.dispatchEvent(
			new CustomEvent("ddpec:eq-toggled", { detail: { enabled: on } }),
		);
	}
}

export function getDevice() {
	return state.device;
}

export function setDevice(device: HIDDevice | null) {
	state.device = device;
}

export function getActiveConfig(): DeviceConfig | null {
	return state.config;
}

export function setActiveConfig(config: DeviceConfig | null) {
	state.config = config;
}

export function getCurrentSlotId(): number {
	return state.slotId;
}

export function setCurrentSlotId(id: number) {
	state.slotId = id;
}

export function getGlobalGainState(): number {
	return state.slots[state.activeSlot].gain;
}

// JDS pivot 2026-04-17: optional `silent` opts skip the dirty flip +
// broadcast. Device readback paths (dsp.ts inputreport handler) pass
// `{ silent: true }` so reading state from hardware on connect doesn't
// pop the commit bar. User-initiated edits stay noisy.
export interface SilentOpts {
	silent?: boolean;
}

export function setGlobalGainState(gain: number, opts?: SilentOpts) {
	state.slots[state.activeSlot].gain = gain;
	if (!opts?.silent) {
		dirty[state.activeSlot] = true;
		broadcastDirty();
		broadcastBandEdit();
	}
}

export function getEqState(): EQ {
	return state.slots[state.activeSlot].eq;
}

export function setEqState(eq: EQ, opts?: SilentOpts) {
	state.slots[state.activeSlot].eq = eq;
	if (!opts?.silent) {
		dirty[state.activeSlot] = true;
		broadcastDirty();
		broadcastBandEdit();
	}
}

// Mutate a single band field in place. Existing call sites depend on
// in-place mutation (the shared reference is read again immediately).
export function setBandField(
	index: number,
	key: keyof Band,
	value: number | boolean | string,
) {
	// @ts-expect-error - Dynamic key assignment across Band field types
	state.slots[state.activeSlot].eq[index][key] = value;
	dirty[state.activeSlot] = true;
	broadcastDirty();
	broadcastBandEdit();
}

// Append a band to the active slot. Caller is responsible for deciding the
// new band's shape (freq / gain / q / type / enabled / hardware-slot index).
// History snapshots happen at the caller level so undo/redo captures the
// length change as part of the user's action boundary.
export function addBand(band: Band) {
	state.slots[state.activeSlot].eq.push(band);
	dirty[state.activeSlot] = true;
	broadcastDirty();
}

// Remove a band from the active slot by its position in the array (NOT by
// hardware slot `band.index`). Caller supplies the resolved array position
// so this function doesn't have to know how the UI sorts. Returns the
// removed band for convenience (e.g. "undo-delete" copy).
export function removeBandAt(arrayIndex: number): Band | null {
	const eq = state.slots[state.activeSlot].eq;
	if (arrayIndex < 0 || arrayIndex >= eq.length) return null;
	const [removed] = eq.splice(arrayIndex, 1);
	dirty[state.activeSlot] = true;
	broadcastDirty();
	return removed;
}

// A/B slot accessors -------------------------------------------------

export function getActiveSlot(): SlotName {
	return state.activeSlot;
}

export function setActiveSlot(slot: SlotName) {
	state.activeSlot = slot;
}

export function getInactiveEq(): EQ {
	return state.slots[state.activeSlot === "A" ? "B" : "A"].eq;
}

export function getInactiveGain(): number {
	return state.slots[state.activeSlot === "A" ? "B" : "A"].gain;
}

// Reset both A and B to the given EQ. Used on connect to give the user
// a consistent starting point across both slots.
export function resetSlots(eq: EQ, gain: number) {
	state.slots.A = { eq: structuredClone(eq), gain };
	state.slots.B = { eq: structuredClone(eq), gain };
	state.activeSlot = "A";
	dirty.A = false;
	dirty.B = false;
	broadcastDirty();
}

// Swap the contents of A and B. The active pointer stays where it is,
// so the user sees their other tuning appear under the same label.
export function swapSlots() {
	const tmp = state.slots.A;
	state.slots.A = state.slots.B;
	state.slots.B = tmp;
	const tmpDirty = dirty.A;
	dirty.A = dirty.B;
	dirty.B = tmpDirty;
	broadcastDirty();
}

// Wave 4.10: dirty-flag accessors. Callers flip via the mutation helpers
// above; `markSynced` is called by sync/flash after a successful write.
export function isDirty(slot: SlotName): boolean {
	return dirty[slot];
}

export function hasAnyDirty(): boolean {
	return dirty.A || dirty.B;
}

export function markSynced(slot: SlotName) {
	dirty[slot] = false;
	broadcastDirty();
}

export function markAllSynced() {
	dirty.A = false;
	dirty.B = false;
	broadcastDirty();
}

// JDS pivot 2026-04-17 — generic flip for the currently active slot.
// Preserves a simple boolean surface requested by the pivot plan while
// delegating to the existing per-slot record.
export function setDirty(isDirty: boolean) {
	dirty[state.activeSlot] = isDirty;
	broadcastDirty();
}

// Build a default EQ matching the active device's band layout.
export function defaultEqState(cfg: DeviceConfig | null): EQ {
	const freqs = cfg?.defaultFreqs ?? DEFAULT_FREQS;
	return freqs.map((freq, i) => ({
		index: i,
		freq,
		gain: 0,
		q: 0.75,
		type: "PK",
		enabled: true,
	})) as EQ;
}
