import { typeHasGain } from "./dsp/biquad.ts";
import { setDeviceGlobalGain } from "./dsp.ts";
import type { Band } from "./main.ts";

/**
 * Console element. Resolved lazily so this module can be imported from
 * test environments that don't have a DOM (vitest default `node` env).
 * Cached on first lookup; further calls re-resolve only if the cached
 * element was detached.
 */
let _logConsole: HTMLElement | null | undefined;
function getLogConsole(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	if (_logConsole && _logConsole.isConnected) return _logConsole;
	_logConsole = document.getElementById("logConsole") as HTMLElement | null;
	return _logConsole;
}

/**
 * JDS pivot 2026-04-17 — "latest line" mirror shown in the collapsed log tray.
 * Every append to #logConsole also updates this so users see the most recent
 * event without expanding the tray. Same lazy pattern as the console element.
 */
let _logTrayLatest: HTMLElement | null | undefined;
function getLogTrayLatest(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	if (_logTrayLatest && _logTrayLatest.isConnected) return _logTrayLatest;
	_logTrayLatest = document.getElementById(
		"logTrayLatest",
	) as HTMLElement | null;
	return _logTrayLatest;
}

/**
 * Update global gain UI
 * @param val The new global gain value
 */
export function updateGlobalGainUI(val: number) {
	const globalGainSlider = document.getElementById(
		"globalGainSlider",
	) as HTMLInputElement;
	if (globalGainSlider) globalGainSlider.value = val.toString();

	const globalGainDisplay = document.getElementById(
		"globalGainDisplay",
	) as HTMLElement;
	if (globalGainDisplay) globalGainDisplay.innerText = `${val} dB`;
}

/**
 * Update global gain and send to device
 * @param newGlobalGainState The new global gain value
 */
export async function updateGlobalGain(newGlobalGainState: number) {
	updateGlobalGainUI(newGlobalGainState);
	await setDeviceGlobalGain(newGlobalGainState);
}

/**
 * Event handler for the global-gain slider. Delegates to updateGlobalGain,
 * which updates the UI and sends the packet; state is updated by
 * setDeviceGlobalGain → fn.setGlobalGain.
 */
export async function setGlobalGain(e: Event) {
	const globalGainEl = e.target as HTMLInputElement;
	await updateGlobalGain(Number(globalGainEl.value));
}

// Toggle controls that genuinely need a live device: the hardware slot
// selector, the pre-amp (on Walkplay the device overwrites this value on
// connect anyway), and the two commit actions. Everything else — band
// editing, presets, targets, signals, import/export, reset — works in
// memory and stays interactive regardless of connection state.
export function enableControls(enabled: boolean) {
	const selector = "#globalGainSlider, #slotSelect, #btnSync, #btnFlash";
	for (const el of document.querySelectorAll(selector)) {
		(el as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled =
			!enabled;
	}
}

/**
 * Log message to the app console. Also updates the collapsed log-tray's
 * "latest" preview so single-line feedback is visible without expanding.
 *
 * JDS pivot 2026-04-17: cap at most recent 500 lines so long sessions don't
 * grow #logConsole unbounded. Drops oldest line(s) once past the cap.
 *
 * @param msg
 */
const LOG_LINE_CAP = 500;
export function log(msg: string) {
	const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
	const c = getLogConsole();
	if (c) {
		const div = document.createElement("div");
		div.textContent = line;
		c.appendChild(div);
		// Cap: drop oldest children until under cap. Skip non-element nodes
		// (e.g. initial text content "Ready to connect...") by counting
		// childElementCount and removing firstElementChild.
		while (c.childElementCount > LOG_LINE_CAP) {
			const first = c.firstElementChild;
			if (!first) break;
			first.remove();
		}
		c.scrollTop = c.scrollHeight;
	}
	const latest = getLogTrayLatest();
	if (latest) latest.textContent = line;
}

/**
 * JDS pivot: toggle the document-level `.app-offline` class. peq.ts /
 * style.css key visual-dim affordances off it. Idempotent.
 */
export function setAppOffline(offline: boolean) {
	document.body.classList.toggle("app-offline", offline);
}

/**
 * JDS pivot: tiny toast helper. Stacks bottom-right, auto-dismiss after
 * 2.5s. Avoids adding a dependency and avoids polluting the log when the
 * feedback is only momentarily useful (copy to clipboard, etc.).
 */
export function toast(msg: string, ms = 2500) {
	const host =
		document.getElementById("ddpec-toasts") ??
		(() => {
			const el = document.createElement("div");
			el.id = "ddpec-toasts";
			el.style.position = "fixed";
			el.style.right = "16px";
			el.style.bottom = "40px";
			el.style.display = "flex";
			el.style.flexDirection = "column";
			el.style.gap = "8px";
			el.style.zIndex = "60";
			el.style.pointerEvents = "none";
			document.body.appendChild(el);
			return el;
		})();
	const t = document.createElement("div");
	t.textContent = msg;
	t.style.background = "var(--color-surface-2)";
	t.style.color = "var(--color-text-1)";
	t.style.border = "1px solid var(--color-border)";
	t.style.borderRadius = "4px";
	t.style.padding = "8px 12px";
	t.style.fontSize = "12px";
	t.style.boxShadow = "0 4px 12px rgba(0,0,0,0.4)";
	t.style.opacity = "0";
	t.style.transition = "opacity 120ms ease-out";
	host.appendChild(t);
	requestAnimationFrame(() => {
		t.style.opacity = "1";
	});
	setTimeout(() => {
		t.style.opacity = "0";
		setTimeout(() => t.remove(), 200);
	}, ms);
}

/**
 * Delay for a specified number of milliseconds
 * @param ms | Number of milliseconds to delay
 */
export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Feature 5 — clipping headroom math. Sums positive band boosts across
 * enabled gainful bands and compares against the pre-amp's available
 * attenuation (`-globalGain`, since globalGain is negative-attenuation).
 * A negative return value means the pre-amp doesn't have enough headroom
 * to contain the summed boosts — a digital-clipping risk.
 *
 * Gainless types (HP/LP/NO/BP) never contribute boost: they don't expose
 * a user gain parameter, and `computeBiquad` doesn't read `band.gain`
 * for them. Excluding them keeps the math matched to what the DSP hears.
 */
export function computeClippingHeadroom(
	bands: Band[],
	globalGain: number,
): number {
	let sum = 0;
	for (const b of bands) {
		if (!b.enabled) continue;
		if (!typeHasGain(b.type)) continue;
		if (b.gain > 0) sum += b.gain;
	}
	return -globalGain - sum;
}
