// Post-wizard confirmation tone. Plays a 1s 500 Hz sine at -30 dBFS so
// the user gets immediate audible proof the routing actually works.
//
// Critically, this routes the tone *directly* to the user's picked
// output device via setSinkId() rather than going through the OS
// default. Right after the wizard, OS default is BlackHole, which
// would loop the tone back into the void if we used getContext()'s
// default destination. By creating a dedicated AudioContext and
// pointing setSinkId at the picked DAC, the tone bypasses BlackHole
// entirely and lands on the speakers/headphones the user just chose.
//
// Used only by the wizard's Done path. Never repeats unless the user
// re-runs the wizard.

import { log } from "./helpers.ts";

interface SetSinkable extends AudioContext {
	setSinkId?: (id: string) => Promise<void>;
}

export async function playConfirmationTone(
	outputDeviceId: string | null,
): Promise<void> {
	if (typeof window === "undefined") return;
	const AC =
		window.AudioContext ||
		(window as unknown as { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;
	if (!AC) return;

	// Dedicated context so we don't disturb the shared signals.ts one
	// (which may be doing reference playback / ABX comparisons). Using
	// a "playback" hint trades latency for stability — this tone doesn't
	// need to be tight.
	const ctx = new AC({ latencyHint: "playback" }) as SetSinkable;

	// Try to route to the user's picked DAC. Failure is non-fatal —
	// falling back to default destination is still better than nothing,
	// even if default = BlackHole and the tone vanishes (we don't want
	// to throw and abort the wizard's Done flow).
	if (outputDeviceId && typeof ctx.setSinkId === "function") {
		try {
			await ctx.setSinkId(outputDeviceId);
		} catch (err) {
			log(
				`Confirmation tone: setSinkId failed (${(err as Error).message}); using default output`,
			);
		}
	}

	const osc = ctx.createOscillator();
	osc.type = "sine";
	osc.frequency.value = 500;

	const gain = ctx.createGain();
	const now = ctx.currentTime;
	// Gentle attack/release envelope so the tone doesn't click in or out.
	// Target = -30 dBFS = 10^(-30/20) ≈ 0.0316.
	gain.gain.setValueAtTime(0.0001, now);
	gain.gain.exponentialRampToValueAtTime(0.0316, now + 0.06);
	gain.gain.setValueAtTime(0.0316, now + 0.85);
	gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);

	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.start();
	osc.stop(now + 1.05);

	osc.onended = () => {
		try {
			osc.disconnect();
			gain.disconnect();
		} catch {
			// already disconnected
		}
		// Close the context after a short grace period so the final
		// release ramp finishes. Closing immediately can chop the tail.
		setTimeout(() => {
			void ctx.close().catch(() => {
				// ignore — if the context was already closed elsewhere it's
				// fine to drop the error.
			});
		}, 200);
	};
}
