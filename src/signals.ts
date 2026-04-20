// Lightweight in-browser test-signal generator. Plays through the user's
// default output so audio routed via the connected DAC gets the EQ applied.
// No worklets — small buffered noise + OscillatorNode are plenty for audition.
//
// Feature F — reference audio library. Beyond the analytical test signals
// (pink / white / sweep) the signals panel exposes a "Reference audio"
// section: 500 Hz sine, the sweep, plus user-uploadable voice / music
// slots. All of these route through a biquad chain derived from the
// current EQ state so the user hears what the DAC will eventually hear.
// Bundled media is deliberately avoided — the upload slots keep the
// build lean and sidestep licensing.

import type { Band } from "./main.ts";

export type SignalType =
	| "pink"
	| "white"
	| "sweep"
	| "sine500"
	| "file";

let ctx: AudioContext | null = null;
let activeSource:
	| { stop: () => void; type: SignalType }
	| null = null;

// Exported so other audio surfaces (spectrum.ts, abx.ts) reuse the same
// AudioContext. Browsers allow only a few contexts before warning, and
// sharing one context lets test signals + spectrum analyser coexist.
export function getContext(): AudioContext {
	if (!ctx || ctx.state === "closed") {
		const AC =
			window.AudioContext ||
			(window as unknown as { webkitAudioContext?: typeof AudioContext })
				.webkitAudioContext;
		if (!AC) throw new Error("Web Audio API is not available");
		ctx = new AC();
	}
	if (ctx.state === "suspended") ctx.resume();
	return ctx;
}

// Fill a Float32Array with pink noise using the Paul Kellett filter
// method. Good enough for audition; cheap and sounds neutral.
function fillPinkNoise(buf: Float32Array) {
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let b3 = 0;
	let b4 = 0;
	let b5 = 0;
	let b6 = 0;
	for (let i = 0; i < buf.length; i++) {
		const white = Math.random() * 2 - 1;
		b0 = 0.99886 * b0 + white * 0.0555179;
		b1 = 0.99332 * b1 + white * 0.0750759;
		b2 = 0.969 * b2 + white * 0.153852;
		b3 = 0.8665 * b3 + white * 0.3104856;
		b4 = 0.55 * b4 + white * 0.5329522;
		b5 = -0.7616 * b5 - white * 0.016898;
		buf[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
		b6 = white * 0.115926;
	}
}

export interface SignalHandle {
	type: SignalType;
	stop: () => void;
}

// Build a chain of Web Audio BiquadFilterNodes from the supplied bands.
// Used by the reference-audio slots so the user hears the current EQ
// applied to their source. Mirrors `abx.ts buildBiquadChain`; kept
// separate so reference playback can evolve without touching ABX.
function buildEqChain(bands: Band[]): BiquadFilterNode[] {
	const audio = getContext();
	const out: BiquadFilterNode[] = [];
	for (const b of bands) {
		if (!b.enabled) continue;
		const node = audio.createBiquadFilter();
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
		node.gain.value = b.gain;
		out.push(node);
	}
	return out;
}

// Wire `source → chain → gain → destination`. Returns the last node so
// callers that want to insert extra processing can chain further.
function connectThroughChain(
	source: AudioNode,
	chain: BiquadFilterNode[],
	gain: GainNode,
): void {
	let prev: AudioNode = source;
	for (const node of chain) {
		prev.connect(node);
		prev = node;
	}
	prev.connect(gain);
	gain.connect(getContext().destination);
}

export function stopSignal() {
	if (activeSource) {
		try {
			activeSource.stop();
		} catch {
			// already stopped or disconnected
		}
		activeSource = null;
	}
}

export function playPinkNoise(gainDb: number): SignalHandle {
	stopSignal();
	const audio = getContext();

	const seconds = 2;
	const buffer = audio.createBuffer(
		1,
		Math.ceil(audio.sampleRate * seconds),
		audio.sampleRate,
	);
	fillPinkNoise(buffer.getChannelData(0));

	const src = audio.createBufferSource();
	src.buffer = buffer;
	src.loop = true;

	const gain = audio.createGain();
	gain.gain.value = 10 ** (gainDb / 20);

	src.connect(gain);
	gain.connect(audio.destination);
	src.start();

	const handle: SignalHandle = {
		type: "pink",
		stop: () => {
			try {
				src.stop();
			} catch {}
			src.disconnect();
			gain.disconnect();
		},
	};
	activeSource = handle;
	return handle;
}

export function playWhiteNoise(gainDb: number): SignalHandle {
	stopSignal();
	const audio = getContext();

	const seconds = 2;
	const buffer = audio.createBuffer(
		1,
		Math.ceil(audio.sampleRate * seconds),
		audio.sampleRate,
	);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

	const src = audio.createBufferSource();
	src.buffer = buffer;
	src.loop = true;

	const gain = audio.createGain();
	gain.gain.value = 10 ** (gainDb / 20);

	src.connect(gain);
	gain.connect(audio.destination);
	src.start();

	const handle: SignalHandle = {
		type: "white",
		stop: () => {
			try {
				src.stop();
			} catch {}
			src.disconnect();
			gain.disconnect();
		},
	};
	activeSource = handle;
	return handle;
}

export interface SweepOptions {
	fromHz?: number;
	toHz?: number;
	seconds?: number;
	gainDb?: number;
}

export function playSineSweep(options: SweepOptions = {}): SignalHandle {
	stopSignal();
	const audio = getContext();
	const fromHz = options.fromHz ?? 20;
	const toHz = options.toHz ?? 20000;
	const seconds = options.seconds ?? 10;
	const gainDb = options.gainDb ?? -12;

	const osc = audio.createOscillator();
	osc.type = "sine";
	osc.frequency.setValueAtTime(fromHz, audio.currentTime);
	osc.frequency.exponentialRampToValueAtTime(
		toHz,
		audio.currentTime + seconds,
	);

	const gain = audio.createGain();
	gain.gain.value = 10 ** (gainDb / 20);

	osc.connect(gain);
	gain.connect(audio.destination);
	osc.start();
	osc.stop(audio.currentTime + seconds + 0.05);

	const cleanup = () => {
		try {
			osc.stop();
		} catch {}
		osc.disconnect();
		gain.disconnect();
	};
	osc.onended = () => {
		if (activeSource && activeSource.type === "sweep") activeSource = null;
		cleanup();
	};

	const handle: SignalHandle = {
		type: "sweep",
		stop: cleanup,
	};
	activeSource = handle;
	return handle;
}

export function isPlaying(): boolean {
	return activeSource !== null;
}

export function getPlayingType(): SignalHandle["type"] | null {
	return activeSource?.type ?? null;
}

// ----- Feature F: reference playback --------------------------------

export interface ReferenceOptions {
	gainDb: number;
	bands: Band[];
}

/**
 * Feature F — steady 500 Hz sine for level-matching and quick gain checks.
 * Routes through the current EQ's biquad chain so the user hears what
 * would land on the DAC.
 */
export function playSine500(options: ReferenceOptions): SignalHandle {
	stopSignal();
	const audio = getContext();

	const osc = audio.createOscillator();
	osc.type = "sine";
	osc.frequency.value = 500;

	const chain = buildEqChain(options.bands);
	const gain = audio.createGain();
	gain.gain.value = 10 ** (options.gainDb / 20);

	connectThroughChain(osc, chain, gain);
	osc.start();

	const handle: SignalHandle = {
		type: "sine500",
		stop: () => {
			try {
				osc.stop();
			} catch {}
			osc.disconnect();
			for (const n of chain) n.disconnect();
			gain.disconnect();
		},
	};
	activeSource = handle;
	return handle;
}

/**
 * Feature F — play an arbitrary audio file (voice sample, music clip)
 * through the current EQ chain. Decodes via `decodeAudioData` and loops.
 * Callers supply both the File and the live band array so the played
 * source reflects what the user is editing.
 */
export async function playReferenceFile(
	file: File,
	options: ReferenceOptions,
): Promise<SignalHandle> {
	stopSignal();
	const audio = getContext();

	const arr = await file.arrayBuffer();
	const buf = await audio.decodeAudioData(arr.slice(0));

	const src = audio.createBufferSource();
	src.buffer = buf;
	src.loop = true;

	const chain = buildEqChain(options.bands);
	const gain = audio.createGain();
	gain.gain.value = 10 ** (options.gainDb / 20);

	connectThroughChain(src, chain, gain);
	src.start();

	const handle: SignalHandle = {
		type: "file",
		stop: () => {
			try {
				src.stop();
			} catch {}
			src.disconnect();
			for (const n of chain) n.disconnect();
			gain.disconnect();
		},
	};
	activeSource = handle;
	return handle;
}
