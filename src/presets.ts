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
