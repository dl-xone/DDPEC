// System EQ — main-window UI surface.
//
// Owns the header pill, the anchored popover (toggle, source/output pickers,
// advanced-latency disclosure, double-EQ chip), and the bidirectional
// binding between the popover controls and `systemEq.ts`'s preferences.
//
// Visual states on the pill:
//   - off:    outlined pill, slate dot, label "System EQ"
//   - on:     accent-tinted pill, breathing dot, label "System EQ · {output}"
//   - drift:  amber pill, static dot, label "System EQ · Routing issue"
//             (drift detection itself ships in Phase 5; this surface just
//             renders the state when something flips a `data-state="drift"`
//             attribute on the pill)
//
// Popover lifecycle: click pill to toggle, click outside or press Escape to
// close. Anchored to the pill via getBoundingClientRect — repositioned on
// scroll/resize so it tracks if the layout shifts.

import {
	getRms,
	isAudioReactiveSilent,
	subscribeAudioReactive,
} from "./audioReactive.ts";
import { log, toast } from "./helpers.ts";
import {
	disengageSystemEq,
	engageSystemEq,
	getSystemEqState,
	listAudioInputs,
	listAudioOutputs,
	type SystemEqLatency,
	setSystemEqInput,
	setSystemEqLatency,
	setSystemEqOutput,
} from "./systemEq.ts";
import { openSystemEqWizard } from "./wizardSystemEq.ts";

const AUTO_START_KEY = "ddpec.systemEq.autoStart";

const LATENCY_VALUES: SystemEqLatency[] = ["tight", "balanced", "comfortable"];
const LATENCY_LABELS: Record<SystemEqLatency, string> = {
	tight: "Tight  ~5–10ms",
	balanced: "Balanced  ~15–25ms",
	comfortable: "Comfortable  ~30–50ms",
};

let initialized = false;
let pillEl: HTMLButtonElement | null = null;
let pillDeviceLabelEl: HTMLElement | null = null;
let popoverEl: HTMLElement | null = null;
let toggleEl: HTMLInputElement | null = null;
let inputSelectEl: HTMLSelectElement | null = null;
let outputSelectEl: HTMLSelectElement | null = null;
let latencySliderEl: HTMLInputElement | null = null;
let latencyLabelEl: HTMLElement | null = null;
let doubleEqChipEl: HTMLElement | null = null;
let inputHintEl: HTMLElement | null = null;
let outputHintEl: HTMLElement | null = null;
let levelStripEl: HTMLElement | null = null;
let autoStartSwitchEl: HTMLInputElement | null = null;
let wizardBtnEl: HTMLButtonElement | null = null;

// Cache of recently enumerated devices, keyed by id. Used to render the
// pill suffix ("System EQ · AKLite") without re-enumerating on every
// state-change event.
const deviceLabels = new Map<string, string>();

export function initSystemEqUi(): void {
	if (initialized) return;
	pillEl = document.getElementById("systemEqPill") as HTMLButtonElement | null;
	pillDeviceLabelEl = document.getElementById("systemEqPillDevice");
	popoverEl = document.getElementById("systemEqPopover");
	toggleEl = document.getElementById(
		"systemEqToggle",
	) as HTMLInputElement | null;
	inputSelectEl = document.getElementById(
		"systemEqInputSelect",
	) as HTMLSelectElement | null;
	outputSelectEl = document.getElementById(
		"systemEqOutputSelect",
	) as HTMLSelectElement | null;
	latencySliderEl = document.getElementById(
		"systemEqLatencySlider",
	) as HTMLInputElement | null;
	latencyLabelEl = document.getElementById("systemEqLatencyLabel");
	doubleEqChipEl = document.getElementById("systemEqDoubleEqChip");
	inputHintEl = document.getElementById("systemEqInputHint");
	outputHintEl = document.getElementById("systemEqOutputHint");
	levelStripEl = document.getElementById("systemEqLevelStrip");
	autoStartSwitchEl = document.getElementById(
		"systemEqAutoStartSwitch",
	) as HTMLInputElement | null;
	wizardBtnEl = document.getElementById(
		"btnSystemEqWizard",
	) as HTMLButtonElement | null;

	if (!pillEl || !popoverEl) return; // markup absent — bail silently
	initialized = true;

	// Device Settings → System EQ section: auto-start toggle + wizard button.
	if (autoStartSwitchEl) {
		autoStartSwitchEl.checked = getAutoStartPreference();
		autoStartSwitchEl.addEventListener("change", () => {
			const on = !!autoStartSwitchEl?.checked;
			setAutoStartPreference(on);
			void applyAutoStartToTauri(on);
			toast(on ? "Auto-start enabled" : "Auto-start disabled");
		});
	}
	wizardBtnEl?.addEventListener("click", () => openSystemEqWizard());

	// Audio-reactive surfaces — header level strip and pill device label
	// share the audioReactive tick stream. Pill breathing animation runs
	// purely in CSS (already a keyframe loop), so we only need a JS-side
	// subscriber for elements whose intensity is data-driven.
	subscribeAudioReactive(updateLevelStrip);

	pillEl.addEventListener("click", () => togglePopover());
	pillEl.addEventListener("keydown", (e) => {
		if (e.key === " " || e.key === "Enter") {
			e.preventDefault();
			togglePopover();
		}
	});
	toggleEl?.addEventListener("change", onToggleChange);
	inputSelectEl?.addEventListener("change", () => {
		const value = inputSelectEl?.value || null;
		setSystemEqInput(value);
	});
	outputSelectEl?.addEventListener("change", () => {
		const value = outputSelectEl?.value || null;
		void setSystemEqOutput(value);
	});
	latencySliderEl?.addEventListener("input", onLatencyChange);

	document.addEventListener("ddpec:system-eq-change", () => refreshUi());
	document.addEventListener("click", onDocumentClick);
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && isPopoverOpen()) hidePopover();
	});
	window.addEventListener(
		"scroll",
		() => {
			if (isPopoverOpen()) positionPopover();
		},
		true,
	);
	window.addEventListener("resize", () => {
		if (isPopoverOpen()) positionPopover();
	});

	// Refresh the device lists when the OS reports a topology change
	// (USB plug, BlackHole install). Browsers fire this on the same
	// MediaDevices instance for the page lifetime.
	if (navigator.mediaDevices?.addEventListener) {
		navigator.mediaDevices.addEventListener("devicechange", () => {
			void populateDeviceLists();
		});
	}

	refreshUi();
	void populateDeviceLists();
}

function isPopoverOpen(): boolean {
	return popoverEl !== null && !popoverEl.hidden;
}

function togglePopover(): void {
	if (isPopoverOpen()) hidePopover();
	else showPopover();
}

function showPopover(): void {
	if (!popoverEl || !pillEl) return;
	popoverEl.hidden = false;
	pillEl.setAttribute("aria-expanded", "true");
	positionPopover();
	// Refresh devices on open so the lists are fresh after permission
	// prompts that happened earlier in the session.
	void populateDeviceLists();
}

function hidePopover(): void {
	if (!popoverEl || !pillEl) return;
	popoverEl.hidden = true;
	pillEl.setAttribute("aria-expanded", "false");
}

function positionPopover(): void {
	if (!popoverEl || !pillEl) return;
	const r = pillEl.getBoundingClientRect();
	// Anchor below the pill, right-aligned to its right edge so the popover
	// stays within the viewport on smaller windows.
	popoverEl.style.top = `${Math.round(r.bottom + 8)}px`;
	popoverEl.style.right = `${Math.round(window.innerWidth - r.right)}px`;
	popoverEl.style.left = "auto";
}

function onDocumentClick(e: MouseEvent): void {
	if (!isPopoverOpen()) return;
	const target = e.target as Node | null;
	if (!target) return;
	if (popoverEl?.contains(target)) return;
	if (pillEl?.contains(target)) return;
	hidePopover();
}

async function onToggleChange(): Promise<void> {
	if (!toggleEl) return;
	if (toggleEl.checked) {
		try {
			await engageSystemEq();
			toast("System EQ engaged");
		} catch (err) {
			// Engagement failed — usually missing input or permission denied.
			// Roll back the toggle so the UI matches reality.
			toggleEl.checked = false;
			const message = (err as Error).message;
			toast(`System EQ: ${message}`);
			log(`System EQ engage failed: ${message}`);
		}
	} else {
		await disengageSystemEq();
		toast("System EQ disengaged");
	}
}

function onLatencyChange(): void {
	if (!latencySliderEl) return;
	const raw = Number(latencySliderEl.value);
	const idx = Math.max(0, Math.min(LATENCY_VALUES.length - 1, raw));
	const latency = LATENCY_VALUES[idx];
	setSystemEqLatency(latency);
	if (latencyLabelEl) latencyLabelEl.textContent = LATENCY_LABELS[latency];
}

function refreshUi(): void {
	const state = getSystemEqState();

	if (toggleEl) toggleEl.checked = state.active;

	if (pillEl) {
		pillEl.classList.toggle("is-active", state.active);
		pillEl.setAttribute("aria-pressed", String(state.active));
		pillEl.setAttribute("data-state", state.active ? "on" : "off");
	}

	if (pillDeviceLabelEl) {
		const outName =
			(state.outputDeviceId && deviceLabels.get(state.outputDeviceId)) || null;
		if (state.active && outName) {
			pillDeviceLabelEl.hidden = false;
			pillDeviceLabelEl.textContent = outName;
		} else {
			pillDeviceLabelEl.hidden = true;
			pillDeviceLabelEl.textContent = "";
		}
	}

	if (latencySliderEl) {
		const idx = LATENCY_VALUES.indexOf(state.latency);
		if (idx >= 0) latencySliderEl.value = String(idx);
	}
	if (latencyLabelEl) {
		latencyLabelEl.textContent = LATENCY_LABELS[state.latency];
	}

	if (inputSelectEl && state.inputDeviceId) {
		inputSelectEl.value = state.inputDeviceId;
	}
	if (outputSelectEl && state.outputDeviceId) {
		outputSelectEl.value = state.outputDeviceId;
	}
}

async function populateDeviceLists(): Promise<void> {
	const [inputs, outputs] = await Promise.all([
		listAudioInputs(),
		listAudioOutputs(),
	]);
	rebuildSelect(inputSelectEl, inputs, "input", inputHintEl);
	rebuildSelect(outputSelectEl, outputs, "output", outputHintEl);
	deviceLabels.clear();
	for (const d of inputs) deviceLabels.set(d.deviceId, d.label || "Input");
	for (const d of outputs) deviceLabels.set(d.deviceId, d.label || "Output");
	// Pill suffix may need to update once we have labels.
	refreshUi();
}

function rebuildSelect(
	select: HTMLSelectElement | null,
	devices: MediaDeviceInfo[],
	kind: "input" | "output",
	hintEl: HTMLElement | null,
): void {
	if (!select) return;
	const previousValue = select.value;
	select.replaceChildren();

	const placeholder = document.createElement("option");
	placeholder.value = "";
	placeholder.textContent =
		kind === "input" ? "— pick a source —" : "— system default —";
	select.appendChild(placeholder);

	for (const d of devices) {
		const opt = document.createElement("option");
		opt.value = d.deviceId;
		// Empty label means we haven't been granted media permission yet —
		// the browser hides labels until the user clears the permission
		// prompt at least once.
		opt.textContent =
			d.label || `${kind === "input" ? "Source" : "Output"} (no label)`;
		select.appendChild(opt);
	}

	// Restore the previous selection if it still exists.
	const state = getSystemEqState();
	const desired = kind === "input" ? state.inputDeviceId : state.outputDeviceId;
	if (desired && devices.some((d) => d.deviceId === desired)) {
		select.value = desired;
	} else if (devices.some((d) => d.deviceId === previousValue)) {
		select.value = previousValue;
	}

	if (hintEl) {
		const noLabels = devices.length > 0 && devices.every((d) => !d.label);
		if (devices.length === 0) {
			hintEl.hidden = false;
			hintEl.textContent =
				kind === "input"
					? "No input devices found."
					: "No output devices found.";
		} else if (noLabels) {
			hintEl.hidden = false;
			hintEl.textContent = "Engage once to populate device names.";
		} else {
			hintEl.hidden = true;
			hintEl.textContent = "";
		}
	}
}

// Drive the header level strip from the audioReactive tick stream. The
// strip's --system-eq-level CSS variable maps to opacity in style.css; we
// also smooth the perceived loudness with a square-root so quiet music
// still produces a visible signal.
function updateLevelStrip(): void {
	if (!levelStripEl) return;
	if (isAudioReactiveSilent()) {
		levelStripEl.style.setProperty("--system-eq-level", "0");
		return;
	}
	const rms = getRms();
	// Map RMS (0..1) → opacity (0..1) with sqrt for perceptual scaling.
	// Cap at 0.85 so the strip never quite reaches opaque — keeps it
	// reading as a glow rather than a blocky bar.
	const intensity = Math.min(0.85, Math.sqrt(rms));
	levelStripEl.style.setProperty("--system-eq-level", intensity.toFixed(3));
}

// Auto-start preferences — persisted independently of systemEq.ts state
// since Tauri's autostart plugin owns the actual OS-level Login Item
// registration. The web side just records the user's preference and
// forwards it via the Tauri bridge below; in browser mode the bridge
// is a no-op.
function getAutoStartPreference(): boolean {
	if (typeof localStorage === "undefined") return false;
	return localStorage.getItem(AUTO_START_KEY) === "1";
}

function setAutoStartPreference(on: boolean): void {
	if (typeof localStorage === "undefined") return;
	if (on) localStorage.setItem(AUTO_START_KEY, "1");
	else localStorage.removeItem(AUTO_START_KEY);
}

interface AutoStartPlugin {
	enable: () => Promise<void>;
	disable: () => Promise<void>;
	isEnabled: () => Promise<boolean>;
}

// Apply the user's auto-start preference to the running Tauri shell.
// Browser mode: skipped (no plugin available). Tauri mode: invokes
// tauri-plugin-autostart's `enable` / `disable`. Failures are logged
// but don't block the toggle — the preference is stored either way.
async function applyAutoStartToTauri(enable: boolean): Promise<void> {
	const w = window as unknown as {
		__TAURI_INTERNALS__?: unknown;
		ddpecTauriAutoStart?: AutoStartPlugin;
	};
	if (!w.__TAURI_INTERNALS__) return; // running in plain browser
	const plugin = w.ddpecTauriAutoStart;
	if (!plugin) {
		log("System EQ: Tauri auto-start plugin not bound; preference saved only.");
		return;
	}
	try {
		if (enable) await plugin.enable();
		else await plugin.disable();
	} catch (err) {
		log(`System EQ: auto-start ${enable ? "enable" : "disable"} failed (${(err as Error).message})`);
	}
}

// Public hook for Phase 5 — drift detector and double-EQ detector flip
// these from somewhere else, the UI just renders.
export function setSystemEqDrift(drift: boolean): void {
	if (!pillEl) return;
	pillEl.classList.toggle("is-drift", drift);
	pillEl.setAttribute(
		"data-state",
		drift ? "drift" : pillEl.classList.contains("is-active") ? "on" : "off",
	);
}

export function setSystemEqDoubleEqWarning(show: boolean): void {
	if (!doubleEqChipEl) return;
	doubleEqChipEl.hidden = !show;
}
