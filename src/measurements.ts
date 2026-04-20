// Loading and rendering of external frequency-response measurements
// (raw CSV from AutoEQ / squig.link / generic tools) so users can see
// their target headphone/IEM FR and how the EQ reshapes it.

export interface Measurement {
	name: string;
	points: Array<{ freq: number; db: number }>;
}

// Parse a CSV / TSV / whitespace-separated measurement. Flexible enough
// to handle:
//   * two-column "freq,spl"
//   * AutoEQ-style "frequency,raw,smoothed,..." — takes columns 1 and 2
//   * leading comment lines starting with '#' or '%'
//   * a non-numeric header row (skipped automatically)
export function parseMeasurement(text: string, name = "measurement"): Measurement {
	const lines = text.split(/\r?\n/);
	const points: Measurement["points"] = [];

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("#") || line.startsWith("%")) continue;

		// Split on comma, semicolon, tab, or any whitespace run.
		const cols = line.split(/[,;\t]|\s+/).filter((c) => c.length > 0);
		if (cols.length < 2) continue;

		const freq = Number(cols[0]);
		const db = Number(cols[1]);
		if (!Number.isFinite(freq) || !Number.isFinite(db)) continue;
		if (freq <= 0) continue;

		points.push({ freq, db });
	}

	if (points.length < 2) {
		throw new Error("Measurement needs at least two frequency points.");
	}

	// Sort by frequency (ascending) in case the input isn't ordered.
	points.sort((a, b) => a.freq - b.freq);

	return { name, points };
}

// Log-linear interpolate the measurement dB at an arbitrary frequency.
// Clamps to endpoint values outside the measured range.
export function magnitudeAt(measurement: Measurement, freq: number): number {
	const pts = measurement.points;
	if (freq <= pts[0].freq) return pts[0].db;
	if (freq >= pts[pts.length - 1].freq) return pts[pts.length - 1].db;

	// Binary search for the bracketing pair.
	let lo = 0;
	let hi = pts.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (pts[mid].freq <= freq) lo = mid;
		else hi = mid;
	}
	const a = pts[lo];
	const b = pts[hi];
	const t =
		(Math.log(freq) - Math.log(a.freq)) /
		(Math.log(b.freq) - Math.log(a.freq));
	return a.db + t * (b.db - a.db);
}

// Return a copy shifted so the interpolated value at `refFreq` is 0 dB.
// Useful for normalizing an absolute-SPL measurement against the common
// 1 kHz reference convention so it fits the ±20 dB visualizer scale.
export function normalizeAt(
	measurement: Measurement,
	refFreq = 1000,
): Measurement {
	const offset = magnitudeAt(measurement, refFreq);
	return {
		name: measurement.name,
		points: measurement.points.map((p) => ({
			freq: p.freq,
			db: p.db - offset,
		})),
	};
}

// ---- Ambient measurement store (single-slot; keep the graph honest) ----

let current: Measurement | null = null;
let userOffsetDb = 0;
// Wave 4+ — a target curve loaded separately from the measurement.
// Drawn on the canvas as a distinct "goal" line the user is tuning toward.
let target: Measurement | null = null;

export function getMeasurement(): Measurement | null {
	return current;
}

export function setMeasurement(m: Measurement | null) {
	current = m;
	userOffsetDb = 0;
}

export function getMeasurementOffset(): number {
	return userOffsetDb;
}

export function setMeasurementOffset(db: number) {
	userOffsetDb = db;
}

// Magnitude of the loaded measurement at `freq`, including any manual
// offset. Returns null when nothing is loaded so callers know to skip.
export function measurementDbAt(freq: number): number | null {
	if (!current) return null;
	return magnitudeAt(current, freq) + userOffsetDb;
}

export function getTarget(): Measurement | null {
	return target;
}

export function setTarget(m: Measurement | null) {
	target = m;
}

export function targetDbAt(freq: number): number | null {
	if (!target) return null;
	return magnitudeAt(target, freq);
}
