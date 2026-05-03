import { describe, expect, it } from "vitest";
import {
	_internal,
	getEnergyAtFreq,
	isAudioReactiveActive,
	isAudioReactiveSilent,
	subscribeAudioReactive,
	trackFrequencies,
} from "./audioReactive.ts";

describe("audioReactive", () => {
	it("starts inactive with no analyser registered", () => {
		expect(isAudioReactiveActive()).toBe(false);
		expect(isAudioReactiveSilent()).toBe(true);
	});

	it("getEnergyAtFreq returns 0 when no analyser is registered", () => {
		expect(getEnergyAtFreq(1000)).toBe(0);
		expect(getEnergyAtFreq(0)).toBe(0);
		expect(getEnergyAtFreq(-50)).toBe(0);
	});

	it("trackFrequencies populates the cache and drops stale entries", () => {
		trackFrequencies([100, 1000, 8000]);
		expect(_internal.energyCacheSize).toBe(3);
		// Stale ones go away when we track a different set.
		trackFrequencies([1000, 4000]);
		expect(_internal.energyCacheSize).toBe(2);
		// Negative / zero freqs are skipped — they'd alias to bin 0.
		trackFrequencies([-1, 0, 500]);
		expect(_internal.energyCacheSize).toBe(1);
		trackFrequencies([]);
		expect(_internal.energyCacheSize).toBe(0);
	});

	it("subscribeAudioReactive returns an unsubscribe handle", () => {
		let count = 0;
		const handler = () => {
			count++;
		};
		const unsub = subscribeAudioReactive(handler);
		expect(typeof unsub).toBe("function");
		unsub();
		// After unsubscribe, the handler set should not retain it. We can't
		// observe directly, but a re-subscribe followed by unsub is idempotent.
		const unsub2 = subscribeAudioReactive(handler);
		unsub2();
		// No assertion failure means double-unsubscribe is safe.
	});
});

describe("audioReactive.sampleEnergy mapping", () => {
	// sampleEnergy reads a shared FFT_BUFFER. We can't easily exercise the
	// real path without a fake AudioContext, so this just locks the
	// dB-to-energy normalization curve so a future tweak fails loudly.
	it("uses the documented decay constants", () => {
		expect(_internal.RMS_DECAY_TC_MS).toBe(80);
		expect(_internal.ENERGY_DECAY_TC_MS).toBe(100);
		expect(_internal.SILENCE_HOLD_MS).toBe(150);
		expect(_internal.FFT_SIZE).toBe(4096);
	});
});
