// Menubar dropdown entry. Loaded by Tauri's tray window (or directly via
// /dropdown.html in browser preview). Shows current System EQ state and
// the "Open editor" CTA.
//
// V1 architecture: this webview reads preferences from localStorage and
// dispatches Tauri events for actions. Live audio-reactive sync (level
// strip from main window's analyser) is wired in Phase 6 via IPC; for now
// the strip stays quiet here and the breathing dot in the main window
// keeps the visual lead.

import "./style.css";
import { initTheme } from "./theme.ts";

const SYSTEM_EQ_KEY = "ddpec.systemEq";
const ACTIVE_SLOT_KEY = "ddpec.activeSlot";
const PRESET_NAME_KEY = "ddpec.activePresetName";

interface SystemEqPersisted {
	inputDeviceId: string | null;
	outputDeviceId: string | null;
	latency: string;
}

interface TauriBridge {
	openMainWindow?: () => Promise<void>;
	requestEngage?: () => Promise<void>;
	requestDisengage?: () => Promise<void>;
	setPreamp?: (db: number) => Promise<void>;
}

function readSystemEq(): SystemEqPersisted {
	const fallback: SystemEqPersisted = {
		inputDeviceId: null,
		outputDeviceId: null,
		latency: "comfortable",
	};
	try {
		const raw = localStorage.getItem(SYSTEM_EQ_KEY);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as Partial<SystemEqPersisted>;
		return { ...fallback, ...parsed };
	} catch {
		return fallback;
	}
}

function getTauri(): TauriBridge | null {
	const w = window as unknown as {
		__TAURI_INTERNALS__?: unknown;
		ddpecTauriBridge?: TauriBridge;
	};
	if (!w.__TAURI_INTERNALS__) return null;
	return w.ddpecTauriBridge ?? null;
}

function lookupOutputLabel(deviceId: string | null): string {
	if (!deviceId) return "System default";
	// Without media permission the dropdown can't enumerate device names.
	// Show a truncated id as a hint so the user has something to compare.
	return deviceId.length > 20 ? `${deviceId.slice(0, 20)}…` : deviceId;
}

function lookupPresetName(): string {
	try {
		return localStorage.getItem(PRESET_NAME_KEY) || "Untitled";
	} catch {
		return "Untitled";
	}
}

function activeSlotLabel(): string {
	try {
		return localStorage.getItem(ACTIVE_SLOT_KEY) || "A";
	} catch {
		return "A";
	}
}

function refresh(): void {
	const prefs = readSystemEq();
	const status = document.getElementById("dropdownStatus");
	const outputEl = document.getElementById("dropdownOutput");
	const presetEl = document.getElementById("dropdownPreset");
	const slot = activeSlotLabel();

	if (outputEl) outputEl.textContent = lookupOutputLabel(prefs.outputDeviceId);
	if (presetEl) presetEl.textContent = `${lookupPresetName()} · ${slot}`;
	if (status) status.textContent = "System EQ — open editor for full controls";
}

function init(): void {
	initTheme();
	refresh();

	const tauri = getTauri();

	const toggle = document.getElementById(
		"dropdownToggle",
	) as HTMLInputElement | null;
	if (toggle) {
		toggle.addEventListener("change", async () => {
			if (!tauri) {
				// Browser preview — open the main window instead so user knows
				// engagement is bound to the main editor in v1.
				toggle.checked = false;
				const main = document.getElementById("dropdownOpenEditor");
				main?.dispatchEvent(new MouseEvent("click"));
				return;
			}
			try {
				if (toggle.checked) await tauri.requestEngage?.();
				else await tauri.requestDisengage?.();
			} catch (err) {
				console.warn("dropdown toggle failed:", err);
				toggle.checked = !toggle.checked;
			}
		});
	}

	const openBtn = document.getElementById("dropdownOpenEditor");
	openBtn?.addEventListener("click", async () => {
		if (tauri?.openMainWindow) {
			try {
				await tauri.openMainWindow();
				return;
			} catch (err) {
				console.warn("openMainWindow IPC failed:", err);
			}
		}
		// Fallback: same-tab navigate to the root. In browser preview this
		// just bounces from /dropdown.html to /.
		window.location.href = "/";
	});

	const preamp = document.getElementById(
		"dropdownPreamp",
	) as HTMLInputElement | null;
	const preampLabel = document.getElementById("dropdownPreampLabel");
	if (preamp && preampLabel) {
		// Value is read from localStorage if persisted by the main window.
		try {
			const raw = localStorage.getItem("ddpec.globalGain");
			if (raw) {
				const parsed = Number(raw);
				if (Number.isFinite(parsed)) {
					preamp.value = String(parsed);
					preampLabel.textContent = `${parsed} dB`;
				}
			}
		} catch {
			// ignore
		}
		preamp.addEventListener("input", () => {
			const v = Number(preamp.value);
			preampLabel.textContent = `${v} dB`;
			void tauri?.setPreamp?.(v);
		});
	}

	// Re-poll every 1s while the panel is open so changes made in the
	// main window appear here without a restart. Cheap; the dropdown is
	// usually only on screen for a few seconds at a time.
	setInterval(refresh, 1000);
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}
