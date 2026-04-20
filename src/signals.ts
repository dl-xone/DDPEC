// Lightweight in-browser test-signal generator. Plays through the user's
// default output so audio routed via the connected DAC gets the EQ applied.
// No worklets — small buffered noise + OscillatorNode are plenty for audition.

let ctx: AudioContext | null = null;
let activeSource:
	| { stop: () => void; type: "pink" | "white" | "sweep" }
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
	type: "pink" | "white" | "sweep";
	stop: () => void;
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
