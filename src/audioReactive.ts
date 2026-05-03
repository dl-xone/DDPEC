// Shared audio-reactive substrate. Single source of truth for every visual
// surface that wants to "breathe" with audio: the band-point pulse on the EQ
// canvas, the header level strip, the future Tauri tray-icon glow.
//
// One AnalyserNode is registered (typically the System EQ output tap), one
// requestAnimationFrame loop polls it, and subscribers are notified once per
// tick. Per-frequency energy lookups go through getEnergyAtFreq() which reads
// the cached FFT buffer — no extra DSP work per band, no DOM thrash, no
// double-buffering.
//
// Restraint principle: when no analyser is registered or the input is silent
// for >150ms, all values fade to zero so subscribers can render a quiet UI
// rather than freezing on the last live frame.

const FFT_SIZE = 4096;
const SILENCE_DBFS = -55;
const SILENCE_HOLD_MS = 150;
const RMS_DECAY_TC_MS = 80; // ~80ms exponential decay for RMS / peak
const ENERGY_DECAY_TC_MS = 100; // ~100ms decay for per-freq cached energy

interface CachedFftEntry {
	freq: number;
	energy: number;
}

let analyser: AnalyserNode | null = null;
let rafId = 0;
let rms = 0;
let peak = 0;
let lastNonSilentAt = 0;
let lastTickAt = 0;
const subscribers = new Set<() => void>();

// Reuse buffers across ticks so we don't allocate per frame. Sized to
// FFT_SIZE / 2 (frequency bin count) and FFT_SIZE (time-domain samples).
const FFT_BUFFER = new Float32Array(FFT_SIZE / 2);
const TIME_BUFFER = new Float32Array(FFT_SIZE);

// Per-frequency energy cache. Keys are the frequency requested by callers
// (band freq, level-strip mid-freq, etc.); values are the smoothed 0..1
// energy at that freq. Decays toward zero between ticks so visuals fall
// quiet without a manual reset.
const energyCache = new Map<number, CachedFftEntry>();

export function setAudioReactiveAnalyser(node: AnalyserNode | null): void {
	analyser = node;
	if (analyser) {
		// Configure the analyser to our shared spec so every consumer reads
		// the same FFT resolution / smoothing curve. Only set fftSize when
		// it differs to avoid re-allocating internal buffers needlessly.
		if (analyser.fftSize !== FFT_SIZE) analyser.fftSize = FFT_SIZE;
		analyser.smoothingTimeConstant = 0.75;
		analyser.minDecibels = -100;
		analyser.maxDecibels = -10;
		start();
	} else {
		stop();
	}
}

export function isAudioReactiveActive(): boolean {
	return analyser !== null;
}

export function isAudioReactiveSilent(): boolean {
	if (!analyser) return true;
	return performance.now() - lastNonSilentAt > SILENCE_HOLD_MS;
}

export function getRms(): number {
	return rms;
}

export function getPeak(): number {
	return peak;
}

// Return the smoothed normalized energy (0..1) at the requested frequency.
// First call for a freq returns the live FFT reading; subsequent calls
// within the same tick reuse the cached value. Between ticks the cached
// value decays per ENERGY_DECAY_TC_MS so visuals fall quiet on silence.
export function getEnergyAtFreq(freqHz: number): number {
	if (!analyser || freqHz <= 0) return 0;
	const cached = energyCache.get(freqHz);
	return cached?.energy ?? 0;
}

export function subscribeAudioReactive(fn: () => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

function start(): void {
	if (rafId !== 0) return;
	if (typeof requestAnimationFrame === "undefined") return;
	lastTickAt = performance.now();
	rafId = requestAnimationFrame(tick);
}

function stop(): void {
	if (rafId !== 0 && typeof cancelAnimationFrame !== "undefined") {
		cancelAnimationFrame(rafId);
	}
	rafId = 0;
	// Reset shared state so subscribers see "no audio" cleanly on the next
	// tick triggered by re-engagement. Without this, stale RMS could leak
	// into a fresh engagement and produce a phantom pulse.
	rms = 0;
	peak = 0;
	for (const entry of energyCache.values()) entry.energy = 0;
	notifySubscribers();
}

function notifySubscribers(): void {
	for (const fn of subscribers) {
		try {
			fn();
		} catch (err) {
			console.warn("audioReactive subscriber threw:", err);
		}
	}
}

function tick(): void {
	if (!analyser) {
		rafId = 0;
		return;
	}
	const now = performance.now();
	// Clamp dt so a tab regaining focus doesn't trigger a huge decay step.
	const dt = Math.max(0, Math.min(100, now - lastTickAt));
	lastTickAt = now;

	const rmsDecay = Math.exp(-dt / RMS_DECAY_TC_MS);
	const energyDecay = Math.exp(-dt / ENERGY_DECAY_TC_MS);

	// Time domain — RMS + peak. Walked once for both to keep the loop tight.
	analyser.getFloatTimeDomainData(TIME_BUFFER);
	let sumSquares = 0;
	let pk = 0;
	for (let i = 0; i < TIME_BUFFER.length; i++) {
		const s = TIME_BUFFER[i];
		sumSquares += s * s;
		const a = Math.abs(s);
		if (a > pk) pk = a;
	}
	const newRms = Math.sqrt(sumSquares / TIME_BUFFER.length);
	// Rise instantly to peak; decay slowly. Matches the "audio is alive"
	// feel — no laggy attack on transients.
	rms = Math.max(newRms, rms * rmsDecay);
	peak = Math.max(pk, peak * rmsDecay);

	const SILENCE_LINEAR = 10 ** (SILENCE_DBFS / 20);
	if (rms > SILENCE_LINEAR) lastNonSilentAt = now;

	// Frequency domain — refresh per-freq energy cache. Only refresh entries
	// that callers have actually asked about; first-time freqs are seeded
	// inside getEnergyAtFreq's miss path on the next call.
	if (energyCache.size > 0) {
		analyser.getFloatFrequencyData(FFT_BUFFER);
		const sampleRate = analyser.context.sampleRate;
		const hzPerBin = sampleRate / analyser.fftSize;
		const binCount = analyser.frequencyBinCount;

		for (const entry of energyCache.values()) {
			const newEnergy = sampleEnergy(entry.freq, hzPerBin, binCount);
			// Same rise-fast / decay-slow envelope as RMS.
			entry.energy = Math.max(newEnergy, entry.energy * energyDecay);
		}
	}

	notifySubscribers();
	rafId = requestAnimationFrame(tick);
}

// Resolve the FFT buffer at the requested frequency. Averages a small
// window around the centre bin for stability on log-spaced UI elements
// (single-bin readings are visibly jittery).
function sampleEnergy(
	freqHz: number,
	hzPerBin: number,
	binCount: number,
): number {
	const centerBin = freqHz / hzPerBin;
	const lo = Math.max(0, Math.floor(centerBin) - 1);
	const hi = Math.min(binCount - 1, Math.ceil(centerBin) + 1);
	let sum = 0;
	let count = 0;
	for (let b = lo; b <= hi; b++) {
		sum += FFT_BUFFER[b];
		count++;
	}
	if (count === 0) return 0;
	const dbAvg = sum / count;
	// Map [-90, -10] dB → [0, 1]. Below -90 reads as silent, above -10 as
	// fully lit. Generous floor so quiet music still gives some pulse.
	return Math.max(0, Math.min(1, (dbAvg + 90) / 80));
}

// Pre-register frequencies the caller plans to query. Without this, the
// first call to getEnergyAtFreq() for a new frequency returns 0 (the cache
// miss seeds the entry but reads happen before the next tick fills it).
// Bands call this once per render so the cache always has fresh entries.
export function trackFrequencies(freqs: number[]): void {
	const seen = new Set<number>();
	for (const f of freqs) {
		if (f <= 0) continue;
		seen.add(f);
		if (!energyCache.has(f)) {
			energyCache.set(f, { freq: f, energy: 0 });
		}
	}
	// Drop stale entries whose freq nobody is asking about anymore.
	for (const f of energyCache.keys()) {
		if (!seen.has(f)) energyCache.delete(f);
	}
}

// Helpers exported for tests
export const _internal = {
	sampleEnergy,
	FFT_SIZE,
	SILENCE_HOLD_MS,
	RMS_DECAY_TC_MS,
	ENERGY_DECAY_TC_MS,
	get energyCacheSize() {
		return energyCache.size;
	},
};
