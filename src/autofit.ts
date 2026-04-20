// Feature 10 — AutoEQ curve-fitting.
//
// Two-tier fit of bands to minimize `target − measurement` error on a
// 256-point log-spaced frequency grid.
//
//   Tier A (greedy peak-picker): repeatedly place a band at the frequency
//   of maximum absolute error, gain = error magnitude, Q = 1.0. Below
//   ~60 Hz use a low shelf; above ~10 kHz use a high shelf; otherwise
//   peaking. Subtract the placed band's magnitude response from the
//   running error vector and iterate.
//
//   Tier B (coordinate-descent refine): for each placed band, perturb
//   freq (±10%), gain (±0.5 dB, only for gainful types), and Q (±0.2).
//   Keep the change that reduces MSE most. Up to 5 passes per band;
//   bail out of the pass loop once no perturbation helps.
//
// Uses `targetDbAt` / `measurementDbAt` from measurements.ts and
// `computeBiquad` / `magnitudeDb` / `typeHasGain` from dsp/biquad.ts.

import { SAMPLE_RATE } from "./constants.ts";
import { computeBiquad, magnitudeDb, typeHasGain } from "./dsp/biquad.ts";
import type {
	Measurement,
} from "./measurements.ts";
import { magnitudeAt } from "./measurements.ts";
import type { Band } from "./main.ts";

export interface AutoFitOptions {
	// When true (default), run Tier B coordinate-descent refine after
	// Tier A greedy placement. Set false for a faster, deterministic pass.
	tierB?: boolean;
	// Caps the number of bands the fitter may emit. Defaults to
	// `currentBands.length` when omitted. Callers can override (e.g. the UI
	// uses `getBandCountCap().max`).
	maxBands?: number;
}

// 256 log-spaced frequencies between 20 Hz and 20 kHz. Module-scoped so
// we compute it once — the error vector uses this grid on every call.
function geometricRange(lo: number, hi: number, count: number): number[] {
	const out: number[] = new Array(count);
	const logLo = Math.log(lo);
	const logHi = Math.log(hi);
	const step = (logHi - logLo) / (count - 1);
	for (let i = 0; i < count; i++) {
		out[i] = Math.exp(logLo + i * step);
	}
	return out;
}

export const LOG_FREQS: readonly number[] = geometricRange(20, 20000, 256);

// Choose a filter type from the fit frequency. Shelves roll off the whole
// tail, which matches what a peak-picker would place at the extremes —
// avoids a lone peaking band at 30 Hz trying to bend the whole sub-bass.
function chooseType(freq: number): string {
	if (freq < 60) return "LSQ";
	if (freq > 10000) return "HSQ";
	return "PK";
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

// Evaluate the EQ system's magnitude contribution (in dB) of a single
// band across the whole LOG_FREQS grid. Used both when subtracting the
// latest-placed band's effect and when scoring Tier B candidates.
function bandMagnitudeVector(band: Band): number[] {
	const coeffs = computeBiquad(band, SAMPLE_RATE);
	const out: number[] = new Array(LOG_FREQS.length);
	for (let i = 0; i < LOG_FREQS.length; i++) {
		out[i] = magnitudeDb(coeffs, LOG_FREQS[i], SAMPLE_RATE);
	}
	return out;
}

function meanSquaredError(errors: number[]): number {
	let sum = 0;
	for (const e of errors) sum += e * e;
	return sum / errors.length;
}

// Initial error[i] = target(f_i) − measurement(f_i). Uses the same
// log-linear interpolation the visualizer uses (magnitudeAt) so the fit
// minimizes what the user is looking at on the canvas.
function computeInitialError(
	target: Measurement,
	measurement: Measurement,
): number[] {
	const out: number[] = new Array(LOG_FREQS.length);
	for (let i = 0; i < LOG_FREQS.length; i++) {
		const f = LOG_FREQS[i];
		out[i] = magnitudeAt(target, f) - magnitudeAt(measurement, f);
	}
	return out;
}

// Pick the lowest unused hardware-slot index so Tier A's bands slot into
// the same positions the user's device expects. `used` tracks which slot
// numbers are taken across the growing fit result.
function nextFreeIndex(used: Set<number>): number {
	let i = 0;
	while (used.has(i)) i++;
	return i;
}

// Tier B: try each perturbation against the same baseline band, pick the
// single candidate that reduces MSE most. Returns the best band (or the
// input band if nothing improved) plus its MSE. This matches the plan's
// "test all 6 perturbations, keep the single change that reduces MSE most"
// semantics — candidates are evaluated independently rather than chained.
interface RefineResult {
	band: Band;
	mse: number;
}

function refineBand(
	band: Band,
	residualErrors: number[], // error vector WITHOUT this band's contribution
): RefineResult {
	// Baseline: the band as-is, re-applied to the residuals.
	const baseVec = bandMagnitudeVector(band);
	let sumBase = 0;
	for (let i = 0; i < LOG_FREQS.length; i++) {
		const e = residualErrors[i] - baseVec[i];
		sumBase += e * e;
	}
	const baseMse = sumBase / LOG_FREQS.length;

	let bestMse = baseMse;
	let bestBand = band;

	const tryCandidate = (cand: Band): void => {
		const vec = bandMagnitudeVector(cand);
		let sum = 0;
		for (let i = 0; i < LOG_FREQS.length; i++) {
			const e = residualErrors[i] - vec[i];
			sum += e * e;
		}
		const mse = sum / LOG_FREQS.length;
		if (mse < bestMse) {
			bestMse = mse;
			bestBand = cand;
		}
	};

	// Build all six candidates off the SAME input `band` — not off whichever
	// perturbation happens to be best so far. The pass emits exactly one
	// winner per call; the caller re-invokes for successive passes.
	// Freq ±10%
	for (const factor of [0.9, 1.1]) {
		tryCandidate({
			...band,
			freq: clamp(band.freq * factor, 20, 20000),
		});
	}
	// Gain ±0.5 dB — only for types that actually use `band.gain`. HPQ/LPQ/
	// NO/BPQ derive their shape from Fc and Q, so perturbing gain is a no-op
	// that just wastes a candidate slot.
	if (typeHasGain(band.type)) {
		for (const delta of [-0.5, 0.5]) {
			tryCandidate({
				...band,
				gain: clamp(band.gain + delta, -20, 20),
			});
		}
	}
	// Q ±0.2
	for (const delta of [-0.2, 0.2]) {
		tryCandidate({
			...band,
			q: clamp(band.q + delta, 0.1, 10),
		});
	}

	return { band: bestBand, mse: bestMse };
}

// Coordinate-descent refine for the entire fit. Up to 5 passes per band;
// each pass picks the single best perturbation. Once no perturbation
// beats the baseline MSE, bail out for that band.
function tierBRefine(
	bands: Band[],
	initialErrors: number[],
): { bands: Band[]; mse: number } {
	// Precompute each band's magnitude vector. We subtract/add as bands
	// change so the error vector stays in sync without rebuilding it.
	const bandVectors: number[][] = bands.map((b) => bandMagnitudeVector(b));

	// Current error vector after all bands are applied.
	const errors: number[] = initialErrors.slice();
	for (const vec of bandVectors) {
		for (let i = 0; i < LOG_FREQS.length; i++) errors[i] -= vec[i];
	}
	let bestMse = meanSquaredError(errors);

	const refined = bands.slice();

	for (let b = 0; b < refined.length; b++) {
		for (let pass = 0; pass < 5; pass++) {
			// Compute residual = errors + this band's contribution (undo it).
			const thisVec = bandVectors[b];
			const residual: number[] = new Array(LOG_FREQS.length);
			for (let i = 0; i < LOG_FREQS.length; i++) {
				residual[i] = errors[i] + thisVec[i];
			}
			const { band: newBand, mse: newMse } = refineBand(refined[b], residual);
			if (newMse >= bestMse) break; // no improvement — abort passes for this band
			// Apply the swap: update the band, its vector, and the error vector.
			refined[b] = newBand;
			const newVec = bandMagnitudeVector(newBand);
			bandVectors[b] = newVec;
			for (let i = 0; i < LOG_FREQS.length; i++) {
				errors[i] = residual[i] - newVec[i];
			}
			bestMse = newMse;
		}
	}

	return { bands: refined, mse: bestMse };
}

// Public entry point. Returns a new Band[] with freshly fit bands. The
// `currentBands` argument's `index` values are honored — new bands take
// the lowest unused slot numbers so the caller's hardware mapping is
// preserved when it re-allocates. `maxBands` is a hard cap on output
// length; defaults to currentBands.length when omitted.
export function autoFitBands(
	target: Measurement,
	measurement: Measurement,
	currentBands: Band[],
	opts: AutoFitOptions = {},
): Band[] {
	const tierB = opts.tierB !== false;
	const maxBands = opts.maxBands ?? currentBands.length;
	if (maxBands <= 0) return [];

	const errors = computeInitialError(target, measurement);
	const bands: Band[] = [];
	const used = new Set<number>();

	// Tier A — greedy peak-picker.
	for (let iter = 0; iter < maxBands; iter++) {
		// Find frequency index with the largest absolute error.
		let bestI = 0;
		let bestAbs = Math.abs(errors[0]);
		for (let i = 1; i < errors.length; i++) {
			const a = Math.abs(errors[i]);
			if (a > bestAbs) {
				bestAbs = a;
				bestI = i;
			}
		}
		// Below ~1e-6 dB we're in float noise; stop rather than place a band
		// that the refine step would just chase around. This handles the
		// "perfectly matching target and measurement" edge case cleanly.
		if (bestAbs < 1e-6) break;

		const freq = LOG_FREQS[bestI];
		const gain = clamp(errors[bestI], -20, 20);
		const type = chooseType(freq);
		const idx = nextFreeIndex(used);
		used.add(idx);

		const band: Band = {
			index: idx,
			freq,
			gain,
			q: 1.0,
			type,
			enabled: true,
		};
		bands.push(band);

		// Subtract this band's contribution from the error vector.
		const vec = bandMagnitudeVector(band);
		for (let i = 0; i < errors.length; i++) {
			errors[i] -= vec[i];
		}
	}

	if (!tierB || bands.length === 0) return bands;

	const refined = tierBRefine(bands, computeInitialError(target, measurement));
	return refined.bands;
}

// Compute MSE for a given band set against target − measurement error.
// Exported so the UI can report "MSE before → after dB²" in the toast.
export function fitMse(
	target: Measurement,
	measurement: Measurement,
	bands: Band[],
): number {
	const errors = computeInitialError(target, measurement);
	for (const b of bands) {
		const vec = bandMagnitudeVector(b);
		for (let i = 0; i < errors.length; i++) errors[i] -= vec[i];
	}
	return meanSquaredError(errors);
}
