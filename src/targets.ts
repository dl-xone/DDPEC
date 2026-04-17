// Built-in target curves. These are the standard goal FR shapes users
// tune toward. Each is stored as a sparse set of (freq, dB) points;
// the measurement interpolator handles the gaps.
//
// Values approximate the published Harman / AES research curves,
// normalized to 0 dB at 1 kHz so they land cleanly on the ±20 dB scale.

import type { Measurement } from "./measurements.ts";

export interface TargetPreset {
	id: string;
	name: string;
	description: string;
	measurement: Measurement;
}

// Harman Over-Ear 2018 (sparse sample of the published curve, -1 kHz ref).
const HARMAN_OE_2018: Measurement = {
	name: "Harman Over-Ear 2018",
	points: [
		{ freq: 20, db: 6.5 },
		{ freq: 30, db: 6.0 },
		{ freq: 50, db: 4.5 },
		{ freq: 80, db: 3.2 },
		{ freq: 100, db: 2.5 },
		{ freq: 200, db: 0.8 },
		{ freq: 300, db: 0.0 },
		{ freq: 500, db: -0.5 },
		{ freq: 1000, db: 0.0 },
		{ freq: 1500, db: 1.5 },
		{ freq: 2000, db: 3.2 },
		{ freq: 2500, db: 6.0 },
		{ freq: 3000, db: 7.5 },
		{ freq: 4000, db: 5.5 },
		{ freq: 5000, db: 2.5 },
		{ freq: 6000, db: 0.5 },
		{ freq: 8000, db: -2.0 },
		{ freq: 10000, db: -4.0 },
		{ freq: 12000, db: -5.5 },
		{ freq: 16000, db: -8.0 },
		{ freq: 20000, db: -10.0 },
	],
};

// Harman In-Ear 2019v2 (more bass shelf, earlier ear-gain peak).
const HARMAN_IE_2019V2: Measurement = {
	name: "Harman In-Ear 2019v2",
	points: [
		{ freq: 20, db: 10.0 },
		{ freq: 30, db: 9.5 },
		{ freq: 50, db: 8.0 },
		{ freq: 80, db: 6.5 },
		{ freq: 100, db: 5.5 },
		{ freq: 200, db: 2.8 },
		{ freq: 300, db: 1.5 },
		{ freq: 500, db: 0.3 },
		{ freq: 1000, db: 0.0 },
		{ freq: 1500, db: 1.0 },
		{ freq: 2000, db: 3.0 },
		{ freq: 2500, db: 6.5 },
		{ freq: 3000, db: 9.5 },
		{ freq: 4000, db: 7.5 },
		{ freq: 5000, db: 4.0 },
		{ freq: 6000, db: 1.5 },
		{ freq: 8000, db: -1.0 },
		{ freq: 10000, db: -3.5 },
		{ freq: 16000, db: -7.5 },
		{ freq: 20000, db: -10.0 },
	],
};

// Diffuse Field (flat through bass/mids, +10 dB ear-gain at 3 kHz).
const DIFFUSE_FIELD: Measurement = {
	name: "Diffuse Field",
	points: [
		{ freq: 20, db: 0 },
		{ freq: 100, db: 0 },
		{ freq: 500, db: 0 },
		{ freq: 1000, db: 0 },
		{ freq: 1500, db: 1.5 },
		{ freq: 2000, db: 4.0 },
		{ freq: 2500, db: 8.0 },
		{ freq: 3000, db: 10.0 },
		{ freq: 4000, db: 8.5 },
		{ freq: 5000, db: 5.0 },
		{ freq: 6000, db: 2.0 },
		{ freq: 8000, db: -1.0 },
		{ freq: 10000, db: -3.0 },
		{ freq: 16000, db: -7.0 },
		{ freq: 20000, db: -10.0 },
	],
};

// Flat — literal zero line. For users who want to see "no target" while
// still having the target layer visible.
const FLAT: Measurement = {
	name: "Flat",
	points: [
		{ freq: 20, db: 0 },
		{ freq: 20000, db: 0 },
	],
};

export const TARGETS: TargetPreset[] = [
	{
		id: "harman-oe-2018",
		name: "Harman Over-Ear 2018",
		description: "Most-liked over-ear response in blind listener tests.",
		measurement: HARMAN_OE_2018,
	},
	{
		id: "harman-ie-2019v2",
		name: "Harman In-Ear 2019v2",
		description: "Preferred IEM target with extra sub-bass shelf.",
		measurement: HARMAN_IE_2019V2,
	},
	{
		id: "diffuse-field",
		name: "Diffuse Field",
		description: "Ear-gain compensation without bass shelf.",
		measurement: DIFFUSE_FIELD,
	},
	{
		id: "flat",
		name: "Flat",
		description: "Reference 0 dB line across the audible range.",
		measurement: FLAT,
	},
];
