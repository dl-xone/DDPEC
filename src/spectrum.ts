// Live FFT spectrum tap. Source picker covers the realistic ways a browser
// can see audio in 2026: getDisplayMedia (tab + Win-only system), getUserMedia
// (mic, virtual cable), and AudioBufferSource (file). All routes converge on
// a single shared AnalyserNode that drawSpectrum() polls each animation frame.

import { getContext } from "./signals.ts";

export type SpectrumSource = "off" | "tab" | "system" | "mic" | "virtual" | "file";

interface SpectrumState {
	analyser: AnalyserNode;
	stream: MediaStream | null;
	bufferSource: AudioBufferSourceNode | null;
	source: Exclude<SpectrumSource, "off">;
	disconnect: () => void;
}

let state: SpectrumState | null = null;

export function isSpectrumActive(): boolean {
	return state !== null;
}

export function getActiveSpectrumSource(): SpectrumSource {
	return state?.source ?? "off";
}

function buildAnalyser(): AnalyserNode {
	const ctx = getContext();
	const a = ctx.createAnalyser();
	a.fftSize = 4096;
	a.smoothingTimeConstant = 0.75;
	a.minDecibels = -100;
	a.maxDecibels = -10;
	return a;
}

// Pull a MediaStream's audio track into the analyser. Returns the
// disconnect function for clean teardown.
function attachStreamToAnalyser(
	stream: MediaStream,
	analyser: AnalyserNode,
): () => void {
	const ctx = getContext();
	const node = ctx.createMediaStreamSource(stream);
	node.connect(analyser);
	return () => {
		try {
			node.disconnect();
		} catch {}
	};
}

// Verify the stream actually carries audio. Some browsers (Safari most
// notably) hand back getDisplayMedia streams with video only; the user
// thinks they shared audio but the analyser sees silence.
function streamHasAudio(stream: MediaStream): boolean {
	return stream.getAudioTracks().length > 0;
}

// "virtual" source needs a deviceId. Caller can list devices here and
// hand the chosen ID into startSpectrum via the `deviceId` option below.
export async function listAudioInputDevices(): Promise<MediaDeviceInfo[]> {
	if (!navigator.mediaDevices?.enumerateDevices) return [];
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.filter((d) => d.kind === "audioinput");
	} catch {
		return [];
	}
}

export interface StartSpectrumOptions {
	file?: File;
	deviceId?: string;
}

export async function startSpectrum(
	source: Exclude<SpectrumSource, "off">,
	opts: StartSpectrumOptions = {},
): Promise<void> {
	stopSpectrum();

	const analyser = buildAnalyser();
	let stream: MediaStream | null = null;
	let bufferSource: AudioBufferSourceNode | null = null;
	let disconnectExtra: (() => void) | null = null;

	if (source === "tab" || source === "system") {
		// Both go through getDisplayMedia. "system" is just a UI-level hint;
		// the user picks "Share system audio" in the browser dialog. On macOS
		// that option is greyed out, which is why we surface "virtual" too.
		if (!navigator.mediaDevices?.getDisplayMedia) {
			throw new Error("Display capture not supported in this browser.");
		}
		const ms = await navigator.mediaDevices.getDisplayMedia({
			video: true,
			audio: true,
		});
		if (!streamHasAudio(ms)) {
			ms.getTracks().forEach((t) => t.stop());
			throw new Error("Selected source has no audio track.");
		}
		// Drop the video track immediately — we only want audio energy in
		// the analyser, no point holding the screen-capture buffer alive.
		for (const t of ms.getVideoTracks()) {
			t.stop();
			ms.removeTrack(t);
		}
		stream = ms;
		disconnectExtra = attachStreamToAnalyser(ms, analyser);
	} else if (source === "mic" || source === "virtual") {
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error("Microphone capture not supported.");
		}
		const constraints: MediaStreamConstraints = {
			audio: opts.deviceId
				? { deviceId: { exact: opts.deviceId } }
				: true,
		};
		const ms = await navigator.mediaDevices.getUserMedia(constraints);
		if (!streamHasAudio(ms)) {
			ms.getTracks().forEach((t) => t.stop());
			throw new Error("Selected device has no audio track.");
		}
		stream = ms;
		disconnectExtra = attachStreamToAnalyser(ms, analyser);
	} else if (source === "file") {
		if (!opts.file) throw new Error("File source requires a File.");
		const ctx = getContext();
		const buf = await opts.file.arrayBuffer();
		const decoded = await ctx.decodeAudioData(buf.slice(0));
		const node = ctx.createBufferSource();
		node.buffer = decoded;
		node.loop = true;
		node.connect(analyser);
		// Also route to destination so the user hears the file. If they
		// only want analysis, they can mute their system output.
		analyser.connect(ctx.destination);
		node.start();
		bufferSource = node;
		disconnectExtra = () => {
			try {
				node.stop();
			} catch {}
			try {
				node.disconnect();
			} catch {}
			try {
				analyser.disconnect();
			} catch {}
		};
	}

	state = {
		analyser,
		stream,
		bufferSource,
		source,
		disconnect: () => {
			disconnectExtra?.();
			if (stream) stream.getTracks().forEach((t) => t.stop());
		},
	};
}

export function stopSpectrum(): void {
	if (!state) return;
	try {
		state.disconnect();
	} catch {}
	state = null;
}

// Sample the analyser at the supplied frequencies. Maps each freq to the
// nearest FFT bin (linearly interpolated between the two neighbours so the
// result is smooth across log-spaced display columns).
//
// Returned values are in dB. When inactive, returns -Infinity for every
// requested freq so callers can early-out cleanly.
const SAMPLE_BUFFER = new Float32Array(2048);
export function readSpectrum(freqs: number[]): number[] {
	if (!state) return freqs.map(() => Number.NEGATIVE_INFINITY);
	const a = state.analyser;
	// fftSize / 2 = bin count. For fftSize 4096 → 2048 bins. Reuse buffer
	// to avoid per-frame allocations.
	a.getFloatFrequencyData(SAMPLE_BUFFER);
	const ctx = getContext();
	const sampleRate = ctx.sampleRate;
	const binCount = a.frequencyBinCount; // = fftSize / 2
	const hzPerBin = sampleRate / a.fftSize;
	const out: number[] = new Array(freqs.length);
	for (let i = 0; i < freqs.length; i++) {
		const f = freqs[i];
		const idx = f / hzPerBin;
		const lo = Math.floor(idx);
		const hi = Math.min(binCount - 1, lo + 1);
		if (lo < 0) {
			out[i] = SAMPLE_BUFFER[0];
		} else if (lo >= binCount - 1) {
			out[i] = SAMPLE_BUFFER[binCount - 1];
		} else {
			const t = idx - lo;
			out[i] = SAMPLE_BUFFER[lo] * (1 - t) + SAMPLE_BUFFER[hi] * t;
		}
	}
	return out;
}
