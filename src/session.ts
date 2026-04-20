// Persistent session state for UI chrome that should survive page reloads.
//
// Scope guardrail: this module does NOT re-persist EQ band data or global
// gain — that's owned by history.ts (`persistProfile`). Session state only
// covers UI chrome (active slot, mode, nav tab, etc.) plus a loose device
// fingerprint for silent auto-reconnect.

export type NavTab = "dsp" | "device";
export type BottomPanelTab = "tabular" | "preamp";
export type SlotName = "A" | "B";
export type AbOverlayMode = "auto" | "hidden";
export type ExportFormat =
	| "json"
	| "rew"
	| "eapo"
	| "wavelet"
	| "camilla"
	| "peace";
export type SpectrumSource = "off" | "tab" | "system" | "mic" | "virtual" | "file";

// Pure shape — full result of the most recent ABX run. Stored so the
// "Last: 7/10 (p=0.17)" subtitle can render without re-running the test.
export interface AbxScore {
	rounds: number;
	correct: number;
	pValue: number;
}

export interface SessionState {
	activeSlot: SlotName;
	eqEnabled: boolean;
	navTab: NavTab;
	bottomPanelTab: BottomPanelTab;
	logTrayExpanded: boolean;
	selectedPresetId: string | null;
	// Loose device fingerprint: `${vendorId}:${productId}:${productName}`.
	// Not PII: no serial number. Used to disambiguate when multiple
	// previously-granted devices happen to be plugged in at once.
	lastDeviceKey: string | null;
	// JDS pivot 2026-04-17: user preference — try silent auto-reconnect on
	// boot using the granted-permissions set (no chooser prompt).
	autoReconnect: boolean;
	// Feature 7 — A vs B overlay visibility. "auto" shows the inactive-slot
	// curve on the canvas; "hidden" suppresses it. Toggle lives in the
	// preset action bar (btnToggleAbOverlay).
	abOverlay: AbOverlayMode;
	// Feature 7 — optional delta line (active − inactive in dB). Off by
	// default because it doubles the curve count on the canvas.
	showDelta: boolean;
	// Feature 8 — phase-response overlay. Off by default.
	showPhase: boolean;
	// Feature 9 — last-used export format. Clicking the main export button
	// re-runs whatever format the user picked most recently.
	exportFormat: ExportFormat;
	// Feature A — last-selected live-spectrum source. On cold start we
	// remember the choice but never auto-start (capture needs a user gesture);
	// the button just shows the "Resume" affordance.
	spectrumSource: SpectrumSource;
	// Feature D — score of the most recent ABX run. Null until first run.
	lastAbxScore: AbxScore | null;
}

const STORAGE_KEY = "ddpec.session";
const DEBOUNCE_MS = 200;

const VALID_EXPORT_FORMATS: readonly ExportFormat[] = [
	"json",
	"rew",
	"eapo",
	"wavelet",
	"camilla",
	"peace",
];
const VALID_SPECTRUM_SOURCES: readonly SpectrumSource[] = [
	"off",
	"tab",
	"system",
	"mic",
	"virtual",
	"file",
];

const DEFAULTS: SessionState = {
	activeSlot: "A",
	eqEnabled: true,
	navTab: "dsp",
	bottomPanelTab: "tabular",
	logTrayExpanded: false,
	selectedPresetId: null,
	lastDeviceKey: null,
	autoReconnect: true,
	abOverlay: "auto",
	showDelta: false,
	showPhase: false,
	exportFormat: "json",
	spectrumSource: "off",
	lastAbxScore: null,
};

let current: SessionState = { ...DEFAULTS };
let loaded = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function hasStorage(): boolean {
	return typeof localStorage !== "undefined";
}

function sanitize(raw: unknown): Partial<SessionState> {
	if (!raw || typeof raw !== "object") return {};
	const o = raw as Record<string, unknown>;
	const out: Partial<SessionState> = {};
	if (o.activeSlot === "A" || o.activeSlot === "B") out.activeSlot = o.activeSlot;
	if (typeof o.eqEnabled === "boolean") out.eqEnabled = o.eqEnabled;
	if (o.navTab === "dsp" || o.navTab === "device") out.navTab = o.navTab;
	if (o.bottomPanelTab === "tabular" || o.bottomPanelTab === "preamp")
		out.bottomPanelTab = o.bottomPanelTab;
	if (typeof o.logTrayExpanded === "boolean")
		out.logTrayExpanded = o.logTrayExpanded;
	if (typeof o.selectedPresetId === "string" || o.selectedPresetId === null)
		out.selectedPresetId = o.selectedPresetId as string | null;
	if (typeof o.lastDeviceKey === "string" || o.lastDeviceKey === null)
		out.lastDeviceKey = o.lastDeviceKey as string | null;
	if (typeof o.autoReconnect === "boolean") out.autoReconnect = o.autoReconnect;
	if (o.abOverlay === "auto" || o.abOverlay === "hidden")
		out.abOverlay = o.abOverlay;
	if (typeof o.showDelta === "boolean") out.showDelta = o.showDelta;
	if (typeof o.showPhase === "boolean") out.showPhase = o.showPhase;
	if (
		typeof o.exportFormat === "string" &&
		(VALID_EXPORT_FORMATS as readonly string[]).includes(o.exportFormat)
	)
		out.exportFormat = o.exportFormat as ExportFormat;
	if (
		typeof o.spectrumSource === "string" &&
		(VALID_SPECTRUM_SOURCES as readonly string[]).includes(o.spectrumSource)
	)
		out.spectrumSource = o.spectrumSource as SpectrumSource;
	if (o.lastAbxScore && typeof o.lastAbxScore === "object") {
		const s = o.lastAbxScore as Record<string, unknown>;
		if (
			typeof s.rounds === "number" &&
			typeof s.correct === "number" &&
			typeof s.pValue === "number" &&
			Number.isFinite(s.rounds) &&
			Number.isFinite(s.correct) &&
			Number.isFinite(s.pValue)
		) {
			out.lastAbxScore = {
				rounds: s.rounds,
				correct: s.correct,
				pValue: s.pValue,
			};
		}
	} else if (o.lastAbxScore === null) {
		out.lastAbxScore = null;
	}
	return out;
}

/**
 * Read the persisted session from localStorage. Returns an empty object on
 * any failure (missing key, parse error, disabled storage). Never throws.
 */
export function loadSession(): Partial<SessionState> {
	if (!hasStorage()) return {};
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return sanitize(parsed);
	} catch {
		return {};
	}
}

/**
 * Merge a patch into the in-memory session state and schedule a debounced
 * write to localStorage. Safe to call rapidly — writes coalesce after
 * DEBOUNCE_MS of quiet.
 */
export function saveSession(patch: Partial<SessionState>) {
	// Cold start: lazy-load from storage so the very first caller doesn't
	// clobber stored fields it didn't set.
	if (!loaded) {
		current = { ...DEFAULTS, ...loadSession() };
		loaded = true;
	}
	current = { ...current, ...patch };
	if (!hasStorage()) return;
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
		} catch {
			// Storage full / disabled — just drop the write.
		}
	}, DEBOUNCE_MS);
}

/**
 * Current in-memory session state with defaults applied. Lazy-loads from
 * storage on first call so initial reads see persisted values.
 */
export function getSession(): SessionState {
	if (!loaded) {
		current = { ...DEFAULTS, ...loadSession() };
		loaded = true;
	}
	return { ...current };
}

/**
 * Force-flush any pending debounced write. Primarily for tests; production
 * callers should let the debounce do its job.
 */
export function flushSession() {
	if (!timer) return;
	clearTimeout(timer);
	timer = null;
	if (!hasStorage()) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
	} catch {
		// ignore
	}
}

/**
 * Reset the in-memory session to defaults and clear any pending write.
 * Used by tests between cases so state doesn't leak.
 */
export function resetSessionForTest() {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	current = { ...DEFAULTS };
	loaded = false;
}
