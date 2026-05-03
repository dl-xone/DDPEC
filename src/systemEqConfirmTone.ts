// Post-wizard confirmation tone. Plays a level-matched 1s 500 Hz sine
// through the System EQ chain so the user gets immediate audible proof
// that the routing actually works. Intentionally played at -30 dBFS so
// it's audible but never startling, even if the user has volume cranked.
//
// Used only by the wizard's "Done" path — never on subsequent engagements.
// Reuses signals.ts's getContext() rather than the System EQ context so
// the tone goes to the OS default output (which, after the wizard, is
// BlackHole). That way the tone gets EQ'd and routed exactly like real
// system audio would.

import { getContext } from "./signals.ts";

export async function playConfirmationTone(): Promise<void> {
	if (typeof window === "undefined") return;
	let ctx: AudioContext;
	try {
		ctx = getContext();
	} catch {
		return; // Web Audio not available
	}
	const osc = ctx.createOscillator();
	osc.type = "sine";
	osc.frequency.value = 500;

	// Brief attack/release envelope so the tone doesn't click in or out.
	const gain = ctx.createGain();
	gain.gain.setValueAtTime(0.0001, ctx.currentTime);
	gain.gain.exponentialRampToValueAtTime(
		// -30 dBFS = 10^(-30/20) ≈ 0.0316
		0.0316,
		ctx.currentTime + 0.05,
	);
	gain.gain.setValueAtTime(0.0316, ctx.currentTime + 0.85);
	gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.0);

	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.start();
	osc.stop(ctx.currentTime + 1.05);

	// Best-effort cleanup. The osc.onended fires when stop() lands, at
	// which point we can disconnect everything.
	osc.onended = () => {
		try {
			osc.disconnect();
		} catch {}
		try {
			gain.disconnect();
		} catch {}
	};
}
