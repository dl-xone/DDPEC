import type { Band, EQ } from "./main.ts";

type BandType = "PK" | "LSQ" | "HSQ";

interface PresetBand {
	freq: number;
	gain: number;
	q: number;
	type: BandType;
}

export interface Preset {
	id: string;
	name: string;
	description: string;
	// Sparse: occupies the first N slots of the device; remaining slots
	// are left flat. For a "reset" preset pass an empty array.
	bands: PresetBand[];
	// Optional preamp gain hint, applied to the global gain control.
	preamp?: number;
	// True for presets stored in the user-presets layer. Built-ins omit
	// this (or set false). Used by the UI to gate Update / Delete actions.
	isUser?: boolean;
}

export const PRESETS: Preset[] = [
	{
		id: "flat",
		name: "Flat",
		description: "Zero all bands. Useful starting point for manual tuning.",
		bands: [],
	},
	{
		id: "bass-boost",
		name: "Bass Boost",
		description: "Gentle sub-bass shelf without muddying the mids.",
		bands: [{ freq: 80, gain: 5, q: 0.7, type: "LSQ" }],
		preamp: -3,
	},
	{
		id: "warm",
		name: "Warm",
		description: "Lifted low-mids, softer highs — tames bright IEMs.",
		bands: [
			{ freq: 120, gain: 3, q: 0.7, type: "LSQ" },
			{ freq: 8000, gain: -2, q: 0.7, type: "HSQ" },
		],
		preamp: -2,
	},
	{
		id: "bright",
		name: "Bright",
		description: "Extra air and treble sparkle.",
		bands: [{ freq: 9000, gain: 4, q: 0.7, type: "HSQ" }],
		preamp: -3,
	},
	{
		id: "v-shape",
		name: "V-Shape",
		description: "Boosted bass + treble, slight mid dip. Consumer-friendly.",
		bands: [
			{ freq: 80, gain: 5, q: 0.7, type: "LSQ" },
			{ freq: 1500, gain: -2, q: 1.2, type: "PK" },
			{ freq: 10000, gain: 4, q: 0.7, type: "HSQ" },
		],
		preamp: -4,
	},
	{
		id: "vocal-forward",
		name: "Vocal Forward",
		description: "Lifts the presence range to bring voices forward.",
		bands: [
			{ freq: 250, gain: -2, q: 0.8, type: "PK" },
			{ freq: 2500, gain: 3, q: 0.8, type: "PK" },
			{ freq: 4500, gain: 2, q: 1, type: "PK" },
		],
		preamp: -3,
	},
	{
		id: "podcast",
		name: "Podcast",
		description: "High-pass rumble and lift intelligibility for speech.",
		bands: [
			{ freq: 120, gain: -6, q: 0.7, type: "LSQ" },
			{ freq: 3000, gain: 3, q: 1, type: "PK" },
		],
		preamp: 0,
	},
];

// ----- User preset layer --------------------------------------------
//
// Built-ins live in `PRESETS`. Anything the user names and saves lives in
// localStorage under `ddpec.user-presets` and is concatenated into the
// sidebar list at render time. IDs are prefixed `user:` so they never
// collide with built-in string ids.

const USER_PRESETS_KEY = "ddpec.user-presets";
const USER_ID_PREFIX = "user:";

function hasStorage(): boolean {
	return typeof localStorage !== "undefined";
}

function validateUserPreset(raw: unknown): Preset | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== "string" || !o.id.startsWith(USER_ID_PREFIX)) return null;
	if (typeof o.name !== "string" || o.name.length === 0) return null;
	if (!Array.isArray(o.bands)) return null;
	const bands: PresetBand[] = [];
	for (const b of o.bands) {
		if (!b || typeof b !== "object") return null;
		const bb = b as Record<string, unknown>;
		if (
			typeof bb.freq !== "number" ||
			typeof bb.gain !== "number" ||
			typeof bb.q !== "number" ||
			(bb.type !== "PK" && bb.type !== "LSQ" && bb.type !== "HSQ")
		) {
			return null;
		}
		bands.push({
			freq: bb.freq,
			gain: bb.gain,
			q: bb.q,
			type: bb.type as BandType,
		});
	}
	const out: Preset = {
		id: o.id,
		name: o.name,
		description: typeof o.description === "string" ? o.description : "",
		bands,
		isUser: true,
	};
	if (typeof o.preamp === "number") out.preamp = o.preamp;
	return out;
}

export function loadUserPresets(): Preset[] {
	if (!hasStorage()) return [];
	try {
		const raw = localStorage.getItem(USER_PRESETS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const out: Preset[] = [];
		for (const p of parsed) {
			const v = validateUserPreset(p);
			if (v) out.push(v);
		}
		return out;
	} catch {
		return [];
	}
}

export function saveUserPresets(list: Preset[]) {
	if (!hasStorage()) return;
	try {
		localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(list));
	} catch {
		// storage full / disabled — drop silently
	}
}

// Stable-ish id. crypto.randomUUID() isn't always available in older
// runtimes; timestamp + random suffix is good enough for a local list.
function mintUserId(): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `${USER_ID_PREFIX}${Date.now().toString(36)}-${rand}`;
}

export function addUserPreset(
	input: Omit<Preset, "id" | "isUser"> & { id?: string },
): Preset {
	const list = loadUserPresets();
	const preset: Preset = {
		id: input.id ?? mintUserId(),
		name: input.name,
		description: input.description,
		bands: input.bands,
		preamp: input.preamp,
		isUser: true,
	};
	list.push(preset);
	saveUserPresets(list);
	return preset;
}

export function updateUserPreset(
	id: string,
	patch: Partial<Omit<Preset, "id" | "isUser">>,
): Preset | null {
	if (!id.startsWith(USER_ID_PREFIX)) return null;
	const list = loadUserPresets();
	const idx = list.findIndex((p) => p.id === id);
	if (idx < 0) return null;
	list[idx] = { ...list[idx], ...patch, id, isUser: true };
	saveUserPresets(list);
	return list[idx];
}

export function deleteUserPreset(id: string): boolean {
	if (!id.startsWith(USER_ID_PREFIX)) return false;
	const list = loadUserPresets();
	const next = list.filter((p) => p.id !== id);
	if (next.length === list.length) return false;
	saveUserPresets(next);
	return true;
}

export function isUserPresetId(id: string): boolean {
	return id.startsWith(USER_ID_PREFIX);
}

/**
 * Combined built-ins + user presets, in display order (built-ins first).
 * Resolves every call so sidebar re-renders pick up fresh additions.
 */
export function getAllPresets(): Preset[] {
	return [...PRESETS, ...loadUserPresets()];
}

/**
 * Convert live EQ state into the sparse preset-bands shape used by the
 * save layer. Trailing flat bands are dropped so a preset saved from an
 * 8-band device can be applied to a 10-band device without spilling
 * zero-gain filters into the extra slots.
 */
export function eqToPresetBands(
	eq: { freq: number; gain: number; q: number; type: string; enabled: boolean }[],
): PresetBand[] {
	const bands: PresetBand[] = [];
	for (const b of eq) {
		bands.push({
			freq: b.freq,
			gain: b.gain,
			q: b.q,
			type: (b.type === "LSQ" || b.type === "HSQ" ? b.type : "PK") as BandType,
		});
	}
	// Trim trailing flat bands so saved presets stay compact.
	while (bands.length > 0) {
		const last = bands[bands.length - 1];
		if (last.gain === 0) bands.pop();
		else break;
	}
	return bands;
}

// Apply a preset to a fresh EQ of `maxFilters` bands. Preset bands occupy
// the leading slots; trailing slots stay flat at their default freq so
// they don't trash unrelated parts of the spectrum when written.
export function applyPreset(
	preset: Preset,
	maxFilters: number,
	defaultFreqs: number[],
): EQ {
	const out: EQ = [];
	for (let i = 0; i < maxFilters; i++) {
		const preset_band = preset.bands[i];
		const fallbackFreq = defaultFreqs[i] ?? 1000;
		if (preset_band) {
			out.push({
				index: i,
				freq: preset_band.freq,
				gain: preset_band.gain,
				q: preset_band.q,
				type: preset_band.type,
				enabled: true,
			} as Band);
		} else {
			out.push({
				index: i,
				freq: fallbackFreq,
				gain: 0,
				q: 0.75,
				type: "PK",
				enabled: true,
			} as Band);
		}
	}
	return out;
}
