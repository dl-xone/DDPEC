import type { Band } from "../main.ts";

// RBJ Audio EQ Cookbook biquad coefficients, normalized by a0.
// Returns the math-correct transfer-function form:
//   H(z) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2)
// Consumers that need the direct-form difference equation
// (y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2] - a1 y[n-1] - a2 y[n-2])
// negate a1/a2 at pack time — see toProtocolCoeffs below.
export interface BiquadCoeffs {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

const Q30_SCALE = 1073741824; // 2^30

export function computeBiquad(band: Band, sampleRate: number): BiquadCoeffs {
	if (!band.enabled) {
		return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
	}

	const w0 = (2 * Math.PI * band.freq) / sampleRate;
	const alpha = Math.sin(w0) / (2 * band.q);
	const A = 10 ** (band.gain / 40);
	const cosw = Math.cos(w0);

	let b0: number;
	let b1: number;
	let b2: number;
	let a0: number;
	let a1: number;
	let a2: number;

	switch (band.type) {
		case "PK": // Peak
			b0 = 1 + alpha * A;
			b1 = -2 * cosw;
			b2 = 1 - alpha * A;
			a0 = 1 + alpha / A;
			a1 = -2 * cosw;
			a2 = 1 - alpha / A;
			break;
		case "LSQ": {
			// Low Shelf
			const sa = 2 * Math.sqrt(A) * alpha;
			b0 = A * (A + 1 - (A - 1) * cosw + sa);
			b1 = 2 * A * (A - 1 - (A + 1) * cosw);
			b2 = A * (A + 1 - (A - 1) * cosw - sa);
			a0 = A + 1 + (A - 1) * cosw + sa;
			a1 = -2 * (A - 1 + (A + 1) * cosw);
			a2 = A + 1 + (A - 1) * cosw - sa;
			break;
		}
		case "HSQ": {
			// High Shelf
			const sb = 2 * Math.sqrt(A) * alpha;
			b0 = A * (A + 1 + (A - 1) * cosw + sb);
			b1 = -2 * A * (A - 1 + (A + 1) * cosw);
			b2 = A * (A + 1 + (A - 1) * cosw - sb);
			a0 = A + 1 - (A - 1) * cosw + sb;
			a1 = 2 * (A - 1 - (A + 1) * cosw);
			a2 = A + 1 - (A - 1) * cosw - sb;
			break;
		}
		default:
			return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
	}

	return {
		b0: b0 / a0,
		b1: b1 / a0,
		b2: b2 / a0,
		a1: a1 / a0,
		a2: a2 / a0,
	};
}

// Evaluate the biquad magnitude response in dB at a given frequency.
// Used by the visualizer to sum multiple bands.
export function magnitudeDb(
	coeffs: BiquadCoeffs,
	freq: number,
	sampleRate: number,
): number {
	const w = (2 * Math.PI * freq) / sampleRate;
	const cos1 = Math.cos(w);
	const cos2 = Math.cos(2 * w);
	const sin1 = Math.sin(w);
	const sin2 = Math.sin(2 * w);

	const numRe = coeffs.b0 + coeffs.b1 * cos1 + coeffs.b2 * cos2;
	const numIm = -(coeffs.b1 * sin1 + coeffs.b2 * sin2);
	const denRe = 1 + coeffs.a1 * cos1 + coeffs.a2 * cos2;
	const denIm = -(coeffs.a1 * sin1 + coeffs.a2 * sin2);

	const magSq =
		(numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm);
	return 10 * Math.log10(magSq);
}

// Convert a normalized biquad into the 5-coefficient protocol form used
// by both Savitech and Moondrop firmwares. The a1/a2 sign flip encodes
// the direct-form difference equation the DSP executes.
export function toProtocolCoeffs(c: BiquadCoeffs): [number, number, number, number, number] {
	return [c.b0, c.b1, c.b2, -c.a1, -c.a2];
}

// Pack a protocol-form coefficient array as little-endian Q30 bytes.
export function toQ30Bytes(coeffs: number[]): number[] {
	return coeffs.flatMap((v) => {
		const q = Math.round(v * Q30_SCALE);
		return [q & 0xff, (q >> 8) & 0xff, (q >> 16) & 0xff, (q >> 24) & 0xff];
	});
}
