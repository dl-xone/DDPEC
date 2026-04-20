// Blind ABX test harness. User hears X (randomly = A or B), guesses
// which slot it matches. After N rounds we compute accuracy + a one-tailed
// binomial p-value so the user sees significance, not just a ratio.
//
// Pure math (computeAbxResult) lives at the top so it's unit-testable
// without any audio dependencies.

import { SAMPLE_RATE } from "./constants.ts";
import type { Band } from "./main.ts";
import { getContext } from "./signals.ts";

export interface AbxResult {
	rounds: number;
	correct: number;
	pValue: number;
}

// Binomial probability mass function: P(X = k | n trials, prob p).
// Used with p = 0.5 (chance for each round) to compute the tail.
export function binomialPmf(k: number, n: number, p: number): number {
	if (k < 0 || k > n) return 0;
	// log-space to avoid overflow in factorials for moderately large n.
	let logCoef = 0;
	for (let i = 1; i <= k; i++) {
		logCoef += Math.log(n - i + 1) - Math.log(i);
	}
	const logProb = logCoef + k * Math.log(p) + (n - k) * Math.log(1 - p);
	return Math.exp(logProb);
}

// One-tailed binomial p-value: P(X >= correct | n rounds, p = 0.5).
// Equivalent to 1 - CDF(correct - 1) which the spec asks for; we compute
// it directly as the upper-tail sum to avoid 1 - (almost-1) cancellation
// when correct is small.
export function computeAbxResult(correct: number, rounds: number): AbxResult {
	let pValue = 0;
	for (let k = correct; k <= rounds; k++) {
		pValue += binomialPmf(k, rounds, 0.5);
	}
	// Numerical safety — clamp into [0, 1].
	if (pValue < 0) pValue = 0;
	if (pValue > 1) pValue = 1;
	return { rounds, correct, pValue };
}

// ----- audio harness ------------------------------------------------

interface AbxAudioState {
	source: AudioBufferSourceNode | null;
	chain: BiquadFilterNode[];
	masterGain: GainNode | null;
}

let audio: AbxAudioState | null = null;

function buildBiquadChain(bands: Band[]): BiquadFilterNode[] {
	const ctx = getContext();
	const out: BiquadFilterNode[] = [];
	for (const b of bands) {
		if (!b.enabled) continue;
		const node = ctx.createBiquadFilter();
		// Map our string-typed band kinds to Web Audio's BiquadFilterType
		// enum. Gainless types (HPQ/LPQ/NO/BPQ) collapse onto the standard
		// Web Audio names so the chain still has the right transfer fn.
		const typeMap: Record<string, BiquadFilterType> = {
			PK: "peaking",
			LSQ: "lowshelf",
			HSQ: "highshelf",
			HPQ: "highpass",
			LPQ: "lowpass",
			NO: "notch",
			BPQ: "bandpass",
		};
		node.type = typeMap[b.type] ?? "peaking";
		node.frequency.value = b.freq;
		node.Q.value = b.q;
		// Web Audio's gain only applies to peaking + shelving types; setting
		// it for other types is harmless (ignored).
		node.gain.value = b.gain;
		out.push(node);
	}
	return out;
}

function makePinkNoiseBuffer(seconds: number): AudioBuffer {
	const ctx = getContext();
	const buf = ctx.createBuffer(
		1,
		Math.ceil(ctx.sampleRate * seconds),
		ctx.sampleRate,
	);
	const data = buf.getChannelData(0);
	let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
	for (let i = 0; i < data.length; i++) {
		const w = Math.random() * 2 - 1;
		b0 = 0.99886 * b0 + w * 0.0555179;
		b1 = 0.99332 * b1 + w * 0.0750759;
		b2 = 0.969 * b2 + w * 0.153852;
		b3 = 0.8665 * b3 + w * 0.3104856;
		b4 = 0.55 * b4 + w * 0.5329522;
		b5 = -0.7616 * b5 - w * 0.016898;
		data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
		b6 = w * 0.115926;
	}
	return buf;
}

// Start playing `bands` over the supplied source (pink noise or decoded file).
// Tears down any previous chain first. `silent` true mutes briefly during
// re-wire so cross-fades between A and B don't pop.
export async function playAbxBands(
	bands: Band[],
	sourceKind: "pink" | "file",
	file?: File,
): Promise<void> {
	stopAbxPlayback();
	const ctx = getContext();
	const buf =
		sourceKind === "pink"
			? makePinkNoiseBuffer(2)
			: file
				? await ctx.decodeAudioData((await file.arrayBuffer()).slice(0))
				: makePinkNoiseBuffer(2);

	const node = ctx.createBufferSource();
	node.buffer = buf;
	node.loop = true;
	const chain = buildBiquadChain(bands);
	const masterGain = ctx.createGain();
	masterGain.gain.value = 0.5;

	let prev: AudioNode = node;
	for (const f of chain) {
		prev.connect(f);
		prev = f;
	}
	prev.connect(masterGain);
	masterGain.connect(ctx.destination);
	node.start();

	audio = { source: node, chain, masterGain };
}

export function stopAbxPlayback(): void {
	if (!audio) return;
	try {
		audio.source?.stop();
	} catch {}
	try {
		audio.source?.disconnect();
	} catch {}
	for (const f of audio.chain) {
		try {
			f.disconnect();
		} catch {}
	}
	try {
		audio.masterGain?.disconnect();
	} catch {}
	audio = null;
}

export function isAbxPlaying(): boolean {
	return audio !== null;
}

// Round driver: caller supplies fresh A and B band sets. Returns a
// shuffled X assignment ("A" or "B") and a play function that swaps in
// the appropriate chain. The whole round state (correct count, round
// number) is tracked by the caller — keeping abx.ts pure-ish.
export interface AbxRound {
	x: "A" | "B";
	playX: () => Promise<void>;
	playA: () => Promise<void>;
	playB: () => Promise<void>;
}

export function createRound(
	bandsA: Band[],
	bandsB: Band[],
	sourceKind: "pink" | "file" = "pink",
	file?: File,
): AbxRound {
	const x: "A" | "B" = Math.random() < 0.5 ? "A" : "B";
	return {
		x,
		playX: () => playAbxBands(x === "A" ? bandsA : bandsB, sourceKind, file),
		playA: () => playAbxBands(bandsA, sourceKind, file),
		playB: () => playAbxBands(bandsB, sourceKind, file),
	};
}

// Re-export for tests + callers that want to know what sample rate the
// chain was built for (useful if we ever expose it in the UI).
export const ABX_SAMPLE_RATE = SAMPLE_RATE;
