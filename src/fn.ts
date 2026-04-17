import { DEFAULT_FREQS } from "./constants.ts";
import {
	allVendorFilters,
	type DeviceConfig,
	pickDeviceConfig,
} from "./deviceConfig.ts";
import { readDeviceParams, setupListener, syncToDevice } from "./dsp.ts";
import { enableControls, log, updateGlobalGainUI } from "./helpers.ts";
import type { Band, EQ } from "./main.ts";
import { renderPEQ, resizeCanvas } from "./peq.ts";

/**
 * STATE
 */
let device: HIDDevice | null = null;
let globalGainState: number = 0;
let activeConfig: DeviceConfig | null = null;
let currentSlotId: number = 101;
let eqState: EQ = defaultEqState(null);

/**
 * INITIALIZATION
 */
export function initState() {
	renderUI(eqState);

	resizeCanvas();
}

// Questa funzione ora aggiorna sia lo stato che la UI
export function setGlobalGain(gain: number) {
	globalGainState = gain;
	updateGlobalGainUI(gain);
}

export function getDevice() {
	return device;
}

export function getActiveConfig(): DeviceConfig | null {
	return activeConfig;
}

export function getCurrentSlotId(): number {
	return currentSlotId;
}

export function getEqState() {
	return eqState;
}

export function setEqState(eq: EQ) {
	eqState = eq;
}

export function setEQ(
	index: number,
	key: keyof Band,
	value: number | boolean | string,
) {
	// @ts-expect-error - Dynamic key assignment
	eqState[index][key] = value;
}

export function getGlobalGainState() {
	return globalGainState;
}

export function setGlobalGainState(gainState: number) {
	globalGainState = gainState;
}

/**
 * DEFAULT EQ STATE
 */
export function defaultEqState(cfg: DeviceConfig | null): EQ {
	const freqs = cfg?.defaultFreqs ?? DEFAULT_FREQS;
	return freqs.map((freq, i) => ({
		index: i,
		freq: freq,
		gain: 0,
		q: 0.75,
		type: "PK",
		enabled: true,
	})) as EQ;
}
/**
 * Render UI
 */
export function renderUI(eqState: EQ) {
	const container: HTMLElement | null = document.getElementById("eqContainer");
	if (!container) {
		console.error("EQ Container not found!");
		return;
	}

	// Delegate to the visualizer
	renderPEQ(container, eqState, (index, key, value) => {
		updateState(index, key, value);
	});
}

/**
 * Connect to device
 */
export async function connectToDevice() {
	try {
		const devices = await navigator.hid.requestDevice({
			filters: allVendorFilters(),
		});
		if (devices.length === 0) return;

		device = devices[0];
		await device.open();

		const cfg = pickDeviceConfig(device);
		activeConfig = cfg;

		log(
			`Connected to: ${device.productName} (VID: 0x${device.vendorId.toString(16).toUpperCase()}, Config: ${cfg.label}, maxFilters=${cfg.maxFilters})`,
		);

		eqState = defaultEqState(cfg);
		setGlobalGain(0);

		// Setup UI state
		const statusBadge = document.getElementById("statusBadge");
		if (statusBadge) {
			statusBadge.innerText = "ONLINE";
			statusBadge.classList.add("connected");
		}
		const btnConnect = document.getElementById("btnConnect");
		if (btnConnect) btnConnect.style.display = "none";

		// Configure gain slider bounds
		const gainSlider = document.getElementById(
			"globalGainSlider",
		) as HTMLInputElement;
		if (gainSlider) {
			gainSlider.min = cfg.minGain.toString();
			gainSlider.max = cfg.maxGain.toString();
		}

		// autoGlobalGain: disable preamp slider
		if (cfg.autoGlobalGain) {
			if (gainSlider) gainSlider.disabled = true;
			const display = document.getElementById("globalGainDisplay");
			if (display) display.innerText = "AUTO";
		}

		// Populate slot dropdown
		const slotSelect = document.getElementById(
			"slotSelect",
		) as HTMLSelectElement;
		if (slotSelect) {
			slotSelect.innerHTML = "";
			for (const slot of cfg.slots) {
				const opt = document.createElement("option");
				opt.value = slot.id.toString();
				opt.textContent = slot.name;
				slotSelect.appendChild(opt);
			}
			currentSlotId = cfg.slots[0].id;
			slotSelect.value = currentSlotId.toString();
		}

		enableControls(true);

		// Re-lock preamp after enableControls if autoGlobalGain
		if (cfg.autoGlobalGain && gainSlider) {
			gainSlider.disabled = true;
		}

		renderUI(eqState);

		// Pull-from-device for Walkplay protocol
		if (cfg.protocol === "WALKPLAY") {
			setupListener(device);
			await readDeviceParams(device);
		}
	} catch (err) {
		log(`Error: ${(err as Error).message}`);
	}
}

/**
 * Reset to factory defaults
 */
export async function resetToDefaults() {
	if (
		!confirm(
			"Reset all bands to Defaults (0dB, Q=0.75) and optimal frequencies?",
		)
	)
		return;

	log("Resetting to factory defaults...");

	eqState = defaultEqState(activeConfig);

	// Reset Global Gain State
	setGlobalGain(0);

	// Re-render UI
	renderUI(eqState);

	// Auto-sync to device using the updated state
	await syncToDevice();
	log("Defaults applied and synced.");
}

/**
 * STATE & UI UPDATES
 */

/**
 * Update state object
 * @param {number} index - Band index
 * @param {string} key - Property to update
 * @param {number} value - New value
 */
export function updateState(
	index: number,
	key: string,
	value: string | number | boolean,
) {
	if (key === "freq" || key === "gain" || key === "q")
		value = parseFloat(value as string);
	else if (key === "enabled") value = Boolean(value);

	setEQ(index, key as keyof Band, value);

	// Refresh UI to keep consistency
	renderUI(eqState);
}

/**
 * Slot change handler
 */
export function onSlotChange(e: Event) {
	const select = e.target as HTMLSelectElement;
	currentSlotId = Number.parseInt(select.value, 10);
	log(
		`Slot changed to: ${select.selectedOptions[0].textContent} (id=${currentSlotId})`,
	);
}

// Expose functions to global window object for inline event handlers
(window as any).updateState = updateState;
