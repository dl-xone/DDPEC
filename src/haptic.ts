// Tier 3 #1 — haptic feedback helper.
//
// Centralized `vibrate()` wrapper so every call site respects the same two
// guards: (a) the browser must support `navigator.vibrate`, and (b) the
// user must not have `prefers-reduced-motion: reduce` set. Vibration
// counts as motion for the purpose of that media query — users who opt
// out of motion are opting out of haptic too.
//
// Silent-fail is the contract: every caller just does `haptic(8)` and
// moves on. No promises, no booleans — if the environment can't vibrate,
// nothing happens.

export function haptic(ms: number): void {
	if (typeof navigator === "undefined") return;
	// Feature-detect. Safari iOS and most desktop browsers don't implement
	// vibrate; calling it there silently no-ops in most cases, but we guard
	// explicitly so TypeScript + older browsers + CSP-strict contexts all
	// behave uniformly.
	if (typeof navigator.vibrate !== "function") return;
	// Respect reduced-motion. `matchMedia` is available in every browser
	// that runs this app; guard for SSR / jsdom anyway.
	if (
		typeof matchMedia === "function" &&
		matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		return;
	}
	try {
		navigator.vibrate(ms);
	} catch {
		// Some browsers throw on unsupported durations — ignore; haptic is
		// purely advisory.
	}
}
