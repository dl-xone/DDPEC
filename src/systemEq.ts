// System EQ — host-side parametric EQ that intercepts audio from a chosen
// input device (e.g. BlackHole), applies the live DDPEC band state via
// Web Audio biquads, and routes the result to a chosen output device via
// AudioContext.setSinkId().
//
// Runs in parallel to (not instead of) DDPEC's existing dongle-firmware EQ.
// Engaging System EQ never writes to the device. Whatever coefficients are
// already on the dongle stay there; the user is responsible for flattening
// the dongle when they don't want double-EQ. We surface a passive warning
// chip when both are active but never auto-act.
//
// Module owns its own AudioContext. The shared `getContext()` in signals.ts
// stays untouched so reference playback / spectrum analyser keep working
// independently. This costs us a second audio context but buys clean
// lifecycle and a dedicated latency hint.
//
// Public surface:
//   - engageSystemEq() / disengageSystemEq()   lifecycle
//   - setSystemEq{Input, Output, Latency}      configuration
//   - getSystemEqState() / isSystemEqActive()  state queries
//   - getSystemEqAnalyser()                    audio-reactive surfaces tap here
//   - listAudioInputs() / listAudioOutputs()   device enumeration
//   - refreshSystemEqGraph()                   live-rebuild after band edits

import { setAudioReactiveAnalyser } from "./audioReactive.ts";
import { log } from "./helpers.ts";
import type { Band } from "./main.ts";
import {
	getEqState,
	getGlobalGainState,
	isEqEnabled,
	getDevice,
} from "./state.ts";

export type SystemEqLatency = "tight" | "balanced" | "comfortable";

const LATENCY_HINTS: Record<SystemEqLatency, AudioContextLatencyCategory> = {
	tight: "interactive",
	balanced: "balanced",
	comfortable: "playback",
};

export const DEFAULT_LATENCY: SystemEqLatency = "comfortable";

export interface SystemEqState {
	active: boolean;
	inputDeviceId: string | null;
	outputDeviceId: string | null;
	latency: SystemEqLatency;
}

const STORAGE_KEY = "ddpec.systemEq";
const EVENT_NAME = "ddpec:system-eq-change";

interface SystemEqGraph {
	ctx: AudioContext;
	source: MediaStreamAudioSourceNode;
	preamp: GainNode;
	chain: BiquadFilterNode[];
	wetGain: GainNode;
	dryGain: GainNode;
	outputMix: GainNode;
	analyser: AnalyserNode;
	stream: MediaStream;
	engagedAt: number;
	driftCheckTimer: number | null;
	statechangeHandler: (() => void) | null;
}

let graph: SystemEqGraph | null = null;
const preferences: SystemEqState = loadPreferences();

// Map DDPEC's internal filter type tokens to Web Audio's BiquadFilterType.
// Matches the table already used by `buildEqChain()` in signals.ts so a
// preset auditioned through reference playback sounds identical to the
// same preset applied via System EQ.
const TYPE_MAP: Record<string, BiquadFilterType> = {
	PK: "peaking",
	LSQ: "lowshelf",
	HSQ: "highshelf",
	HPQ: "highpass",
	LPQ: "lowpass",
	NO: "notch",
	BPQ: "bandpass",
};

function isValidLatency(value: unknown): value is SystemEqLatency {
	return value === "tight" || value === "balanced" || value === "comfortable";
}

function loadPreferences(): SystemEqState {
	const fallback: SystemEqState = {
		active: false,
		inputDeviceId: null,
		outputDeviceId: null,
		latency: DEFAULT_LATENCY,
	};
	if (typeof localStorage === "undefined") return fallback;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as Partial<SystemEqState>;
		return {
			// Never auto-engage on load — engagement is an opt-in user gesture.
			// Persisted `active: true` from a previous session would otherwise
			// silently grab the microphone permission on next page load.
			active: false,
			inputDeviceId:
				typeof parsed.inputDeviceId === "string" ? parsed.inputDeviceId : null,
			outputDeviceId:
				typeof parsed.outputDeviceId === "string"
					? parsed.outputDeviceId
					: null,
			latency: isValidLatency(parsed.latency)
				? parsed.latency
				: DEFAULT_LATENCY,
		};
	} catch {
		return fallback;
	}
}

function persistPreferences(): void {
	if (typeof localStorage === "undefined") return;
	try {
		const { inputDeviceId, outputDeviceId, latency } = preferences;
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ inputDeviceId, outputDeviceId, latency }),
		);
	} catch {
		// Storage disabled / quota exceeded — engagement still works for the
		// session, settings just won't persist.
	}
}

function broadcast(): void {
	if (typeof document === "undefined") return;
	document.dispatchEvent(
		new CustomEvent(EVENT_NAME, {
			detail: { ...preferences, active: graph !== null },
		}),
	);
}

const DRIFT_EVENT_NAME = "ddpec:system-eq-drift";
const DOUBLE_EQ_EVENT_NAME = "ddpec:system-eq-double";

function broadcastDrift(active: boolean): void {
	if (typeof document === "undefined") return;
	document.dispatchEvent(
		new CustomEvent(DRIFT_EVENT_NAME, { detail: { drift: active } }),
	);
}

function broadcastDoubleEq(active: boolean): void {
	if (typeof document === "undefined") return;
	document.dispatchEvent(
		new CustomEvent(DOUBLE_EQ_EVENT_NAME, { detail: { doubleEq: active } }),
	);
}

function gainDbToLinear(db: number): number {
	return 10 ** (db / 20);
}

// Pure biquad-chain builder. Exported for tests so callers can verify
// type/freq/Q/gain mapping without spinning up a real graph.
export function buildSystemEqChain(
	ctx: AudioContext,
	bands: Band[],
): BiquadFilterNode[] {
	const out: BiquadFilterNode[] = [];
	for (const b of bands) {
		if (!b.enabled) continue;
		const node = ctx.createBiquadFilter();
		node.type = TYPE_MAP[b.type] ?? "peaking";
		node.frequency.value = b.freq;
		node.Q.value = b.q;
		node.gain.value = b.gain;
		out.push(node);
	}
	return out;
}

// Try to apply setSinkId on the AudioContext. The API is gated on browser
// + user permission and may not exist on older webviews. We swallow
// failures so engagement never aborts solely because of an output-routing
// hiccup; default destination is a usable fallback.
async function applyOutputSink(
	ctx: AudioContext,
	outputDeviceId: string | null,
): Promise<void> {
	if (!outputDeviceId) return;
	const setSinkId = (
		ctx as unknown as {
			setSinkId?: (id: string) => Promise<void>;
		}
	).setSinkId;
	if (typeof setSinkId !== "function") return;
	try {
		await setSinkId.call(ctx, outputDeviceId);
	} catch (err) {
		log(
			`System EQ: setSinkId failed (${(err as Error).message}); falling back to default output.`,
		);
	}
}

export async function engageSystemEq(): Promise<void> {
	if (graph) return;
	if (!preferences.inputDeviceId) {
		throw new Error("System EQ: no input device selected.");
	}
	if (
		typeof navigator === "undefined" ||
		!navigator.mediaDevices?.getUserMedia
	) {
		throw new Error(
			"System EQ: getUserMedia not available in this environment.",
		);
	}

	// Acquire the input stream with every browser-side DSP enhancement
	// disabled — we want raw samples through. AGC in particular would
	// silently fight any boost the user dialled in.
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: {
			deviceId: { exact: preferences.inputDeviceId },
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
		},
	});

	const AC =
		typeof window !== "undefined"
			? window.AudioContext ||
				(window as unknown as { webkitAudioContext?: typeof AudioContext })
					.webkitAudioContext
			: undefined;
	if (!AC) {
		for (const t of stream.getTracks()) t.stop();
		throw new Error("System EQ: Web Audio API is not available.");
	}

	const ctx = new AC({ latencyHint: LATENCY_HINTS[preferences.latency] });
	await applyOutputSink(ctx, preferences.outputDeviceId);

	const source = ctx.createMediaStreamSource(stream);
	const preamp = ctx.createGain();
	preamp.gain.value = gainDbToLinear(getGlobalGainState());

	// Wet/dry mix gives us a glitch-free EQ-on/off path. wetGain feeds the
	// biquad output; dryGain feeds the raw source. Toggling the EQ enabled
	// switch cross-fades between them. Keeping both alive at all times means
	// disengaging the chain doesn't briefly cut audio.
	const eqOn = isEqEnabled();
	const wetGain = ctx.createGain();
	const dryGain = ctx.createGain();
	wetGain.gain.value = eqOn ? 1 : 0;
	dryGain.gain.value = eqOn ? 0 : 1;

	const chain = buildSystemEqChain(ctx, getEqState());

	// Wet path: source → preamp → biquads → wetGain
	source.connect(preamp);
	let prev: AudioNode = preamp;
	for (const node of chain) {
		prev.connect(node);
		prev = node;
	}
	prev.connect(wetGain);

	// Dry path: source → dryGain. No preamp, no chain — true passthrough.
	source.connect(dryGain);

	const outputMix = ctx.createGain();
	outputMix.gain.value = 1;
	wetGain.connect(outputMix);
	dryGain.connect(outputMix);

	const analyser = ctx.createAnalyser();
	analyser.fftSize = 4096;
	analyser.smoothingTimeConstant = 0.75;
	analyser.minDecibels = -100;
	analyser.maxDecibels = -10;
	outputMix.connect(analyser);
	outputMix.connect(ctx.destination);

	graph = {
		ctx,
		source,
		preamp,
		chain,
		wetGain,
		dryGain,
		outputMix,
		analyser,
		stream,
		engagedAt: performance.now(),
		driftCheckTimer: null,
		statechangeHandler: null,
	};

	// Pump the analyser into the shared audio-reactive substrate so the
	// band-point pulse, header level strip, and tray glow all read from
	// the same FFT once per frame.
	setAudioReactiveAnalyser(analyser);

	// Sleep/wake recovery — when macOS sleeps the AudioContext flips to
	// "interrupted"; on wake it goes back to "running" if we resume() it.
	// Without this hook, audio stops after the first sleep until the user
	// manually re-engages. Listener removed on disengage.
	const onStateChange = (): void => {
		if (!graph || graph.ctx !== ctx) return;
		if (ctx.state === "interrupted") {
			log("System EQ: AudioContext interrupted (likely sleep); will resume on wake.");
		} else if (ctx.state === "suspended") {
			void ctx.resume().catch((err) => {
				log(`System EQ: resume failed (${(err as Error).message})`);
			});
		}
	};
	ctx.addEventListener("statechange", onStateChange);
	graph.statechangeHandler = onStateChange;

	// Drift check — 1.5s after engaging, sample whether audio is actually
	// flowing. If RMS is still ~0, the input isn't receiving anything,
	// which usually means the user's system output isn't routed through
	// BlackHole. Surface the drift state so the UI can prompt a fix.
	graph.driftCheckTimer = window.setTimeout(() => {
		if (!graph) return;
		runDriftCheck();
	}, 1500);

	// Watch for the input track ending (device unplugged, OS audio reset).
	// Disengage gracefully so the UI can react and the user gets a clear
	// "audio source disappeared" path rather than silent failure.
	for (const track of stream.getTracks()) {
		track.addEventListener("ended", () => {
			log("System EQ: input track ended; disengaging.");
			void disengageSystemEq();
		});
	}

	log(
		`System EQ engaged (input=${preferences.inputDeviceId}, output=${
			preferences.outputDeviceId ?? "default"
		}, latency=${preferences.latency}).`,
	);
	broadcast();
	// Initial double-EQ check after engage so the warning chip appears
	// immediately if the user already has dongle bands dialled in.
	runDoubleEqCheck();
}

export async function disengageSystemEq(): Promise<void> {
	if (!graph) return;
	const g = graph;
	graph = null;

	// Cancel the pending drift check, if any. Detach the statechange
	// listener so we don't leak event-loop ticks across re-engagements.
	if (g.driftCheckTimer !== null && typeof window !== "undefined") {
		window.clearTimeout(g.driftCheckTimer);
	}
	if (driftPollHandle !== null && typeof window !== "undefined") {
		window.clearTimeout(driftPollHandle);
		driftPollHandle = null;
	}
	if (g.statechangeHandler) {
		try {
			g.ctx.removeEventListener("statechange", g.statechangeHandler);
		} catch {
			// already removed
		}
	}
	broadcastDrift(false);
	broadcastDoubleEq(false);

	// Tear down the audio-reactive feed first so its RAF loop stops before
	// we close the context (otherwise the next frame would try to read from
	// a closed analyser).
	setAudioReactiveAnalyser(null);

	// Disconnect every node we created. Any failures here mean the node
	// was already disconnected; safe to ignore.
	const nodes: AudioNode[] = [
		g.source,
		g.preamp,
		...g.chain,
		g.wetGain,
		g.dryGain,
		g.outputMix,
		g.analyser,
	];
	for (const node of nodes) {
		try {
			node.disconnect();
		} catch {
			// already disconnected
		}
	}

	for (const track of g.stream.getTracks()) {
		try {
			track.stop();
		} catch {
			// already stopped
		}
	}

	try {
		await g.ctx.close();
	} catch {
		// already closed
	}

	log("System EQ disengaged.");
	broadcast();
}

export function isSystemEqActive(): boolean {
	return graph !== null;
}

export function getSystemEqState(): SystemEqState {
	return { ...preferences, active: graph !== null };
}

export function getSystemEqAnalyser(): AnalyserNode | null {
	return graph?.analyser ?? null;
}

export function setSystemEqInput(deviceId: string | null): void {
	preferences.inputDeviceId = deviceId;
	persistPreferences();
	broadcast();
	// Active engagement uses the input that was selected when engaged. To
	// pick up a new input the user disengages and re-engages — we surface
	// that in the UI rather than tearing down on a setting flip.
}

export async function setSystemEqOutput(
	deviceId: string | null,
): Promise<void> {
	preferences.outputDeviceId = deviceId;
	persistPreferences();
	if (graph) {
		await applyOutputSink(graph.ctx, deviceId);
		log(`System EQ output → ${deviceId ?? "default"}.`);
	}
	broadcast();
}

export function setSystemEqLatency(latency: SystemEqLatency): void {
	preferences.latency = latency;
	persistPreferences();
	broadcast();
	// Like input, latency hint is fixed at context creation. Callers
	// surface a "re-engage to apply" notice rather than auto-cycling.
}

// Sync the live audio graph with the current band/preamp/EQ-enabled state.
// Wired to `ddpec:band-edit` (see initSystemEqListeners) so user edits
// reflect in real time.
//
// Implementation note: rebuilding the biquad chain on every edit is cheap
// (a band has a single biquad node, no DSP allocations beyond the node
// itself) and avoids tracking which fields changed. The wet path is
// rewired in place; the analyser tap stays connected throughout so the
// audio-reactive subscribers don't blink.
export function refreshSystemEqGraph(): void {
	if (!graph) return;

	const g = graph;
	g.preamp.gain.value = gainDbToLinear(getGlobalGainState());

	const eqOn = isEqEnabled();
	g.wetGain.gain.value = eqOn ? 1 : 0;
	g.dryGain.gain.value = eqOn ? 0 : 1;

	// Tear down old wet-path topology only — preamp and wetGain stay
	// alive, just re-routed.
	try {
		g.preamp.disconnect();
	} catch {
		// already
	}
	for (const node of g.chain) {
		try {
			node.disconnect();
		} catch {
			// already
		}
	}

	const newChain = buildSystemEqChain(g.ctx, getEqState());
	g.chain = newChain;

	let prev: AudioNode = g.preamp;
	for (const node of newChain) {
		prev.connect(node);
		prev = node;
	}
	prev.connect(g.wetGain);
}

// Wire DOM-event listeners that keep the live audio graph in sync with
// state mutations elsewhere in the app. Called once from main.ts at boot.
// Idempotent — calling twice does nothing harmful, but we guard anyway
// because the test environment may import this module multiple times.
let listenersBound = false;
export function initSystemEqListeners(): void {
	if (listenersBound) return;
	if (typeof document === "undefined") return;
	listenersBound = true;
	document.addEventListener("ddpec:band-edit", () => {
		refreshSystemEqGraph();
		runDoubleEqCheck();
	});
	document.addEventListener("ddpec:eq-toggled", () => {
		refreshSystemEqGraph();
		runDoubleEqCheck();
	});

	// Visibility-change recovery — Chromium suspends AudioContext on
	// background tabs in some configurations. Resume on visible if the
	// state is suspended; the statechange handler in engage() handles
	// the "interrupted" case from system sleep.
	document.addEventListener("visibilitychange", () => {
		if (!graph) return;
		if (document.visibilityState !== "visible") return;
		if (graph.ctx.state === "suspended") {
			void graph.ctx.resume().catch((err) => {
				log(`System EQ: resume on visibility change failed (${(err as Error).message})`);
			});
		}
	});
}

// Drift detection — compares the post-engagement RMS to a silence floor.
// If still ~0 a couple of seconds in, the input device isn't actually
// receiving anything, which usually means the macOS system output isn't
// routed through BlackHole. We surface the drift state via an event so
// systemEqUi.ts can flip the pill colour without having to know about
// the Web Audio analyser. Re-runs every 4s while engaged to catch
// late-emerging routing changes (user unplugged BlackHole, etc.).
let driftPollHandle: number | null = null;
function runDriftCheck(): void {
	if (!graph) return;
	const analyser = graph.analyser;
	const buffer = new Float32Array(analyser.fftSize);
	analyser.getFloatTimeDomainData(buffer);
	let sumSquares = 0;
	for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
	const rms = Math.sqrt(sumSquares / buffer.length);
	// -55 dBFS floor matches the audioReactive silence threshold so the
	// drift detector and the level-strip "alive" indicator agree on what
	// counts as silent.
	const SILENCE_LINEAR = 10 ** (-55 / 20);
	const isDrift = rms < SILENCE_LINEAR;
	broadcastDrift(isDrift);

	// Schedule the next poll. Slow cadence (4s) keeps us out of the way of
	// the audio-reactive RAF; drift state doesn't need millisecond accuracy.
	if (typeof window !== "undefined") {
		if (driftPollHandle !== null) window.clearTimeout(driftPollHandle);
		driftPollHandle = window.setTimeout(runDriftCheck, 4000);
	}
}

// Double-EQ detection — when System EQ is engaged AND a dongle is
// connected with non-flat coefficients, we're applying EQ twice. Surface
// the warning chip so the user can flatten the dongle (or accept the
// stack). Recomputed on every band edit + on toggle changes so the chip
// flips quickly when the user fixes it.
function runDoubleEqCheck(): void {
	const device = getDevice();
	if (!graph || !device) {
		broadcastDoubleEq(false);
		return;
	}
	const bands = getEqState();
	const hasNonFlatBand = bands.some(
		(b) => b.enabled && Math.abs(b.gain) > 0.01,
	);
	const hasNonZeroPreamp = Math.abs(getGlobalGainState()) > 0.01;
	broadcastDoubleEq(hasNonFlatBand || hasNonZeroPreamp);
}

export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
	if (
		typeof navigator === "undefined" ||
		!navigator.mediaDevices?.enumerateDevices
	) {
		return [];
	}
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.filter((d) => d.kind === "audioinput");
	} catch {
		return [];
	}
}

export async function listAudioOutputs(): Promise<MediaDeviceInfo[]> {
	if (
		typeof navigator === "undefined" ||
		!navigator.mediaDevices?.enumerateDevices
	) {
		return [];
	}
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.filter((d) => d.kind === "audiooutput");
	} catch {
		return [];
	}
}

// Helpers exported for tests + advanced callers ----------------------

export const _internal = {
	loadPreferences,
	gainDbToLinear,
	isValidLatency,
	TYPE_MAP,
	STORAGE_KEY,
	EVENT_NAME,
};
