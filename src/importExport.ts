import {
	defaultEqState,
	getActiveConfig,
	getDevice,
	getEqState,
	getGlobalGainState,
	renderUI,
	setEqState,
	setGlobalGainState,
} from "./fn.ts";
import { log, updateGlobalGain } from "./helpers.ts";
import type { EQ } from "./main.ts";

interface ProfileData {
	globalGain: number;
	bands: EQ;
}

/**
 * Export profile to JSON file
 */
export async function exportProfile() {
	const device = getDevice();
	const globalGainState = getGlobalGainState();
	const eqState = getEqState();
	if (!device) return;
	const data = {
		device: device.productName ?? "Unknown",
		config: getActiveConfig()?.key,
		timestamp: new Date().toISOString(),
		globalGain: globalGainState,
		bands: eqState,
	};
	const blob = new Blob([JSON.stringify(data, null, 2)], {
		type: "application/json",
	});
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = "eq_profile.json";
	a.click();
}

/**
 * Parse JSON profile data
 */
function parseJsonProfile(content: string): ProfileData {
	const data = JSON.parse(content);
	if (!data.bands) {
		throw new Error("Invalid JSON profile: missing 'bands' property");
	}
	return {
		globalGain: data.globalGain || 0,
		bands: data.bands,
	};
}

/**
 * Parse Text profile data (Preamp: ... Filter X: ...)
 */
function parseTextProfile(content: string): ProfileData {
	const lines = content.split(/\r?\n/);
	const bands: EQ = defaultEqState(getActiveConfig());
	let globalGain = 0;

	// Regex for Preamp: "Preamp: -8.0 dB"
	// Allow flexible spacing and optional "dB"
	const preampRegex = /^Preamp:\s*(-?\d+(\.\d+)?)\s*(?:dB)?/i;

	// Regex for Filter: "Filter 1: ON PK Fc 34 Hz Gain -2.6 dB Q 0.800"
	// Groups: 1=Index, 2=State(ON/OFF), 3=Type, 4=Fc, 5=Gain, 6=Q
	const filterRegex =
		/^Filter\s+(\d+):\s+(ON|OFF)\s+([A-Z]+)\s+Fc\s+(\d+(?:\.\d+)?)\s*(?:Hz)?\s+Gain\s+(-?\d+(?:\.\d+)?)\s*(?:dB)?\s+Q\s+(\d+(?:\.\d+)?)/i;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const preampMatch = trimmed.match(preampRegex);
		if (preampMatch) {
			globalGain = parseFloat(preampMatch[1]);
			continue;
		}

		const filterMatch = trimmed.match(filterRegex);
		if (filterMatch) {
			const index = parseInt(filterMatch[1], 10) - 1; // 1-based to 0-based
			if (index >= 0 && index < bands.length) {
				const enabled = filterMatch[2].toUpperCase() === "ON";
				const type = filterMatch[3]; // e.g. PK, LS, HS - assuming mapping matches or is standard
				const freq = parseFloat(filterMatch[4]);
				const gain = parseFloat(filterMatch[5]);
				const q = parseFloat(filterMatch[6]);

				// Map type string if necessary. The user provided "PK".
				// Our internal types might need verification.
				// Assuming "PK" maps to "PK", "LS" to "LS", etc.
				// If "PK" in text is "PEAK" internally, we might need mapping.
				// Checking defaultEqState in fn.ts shows "PK" as default, so it's likely compatible.

				bands[index] = {
					...bands[index],
					freq,
					gain,
					q,
					type: type as any, // Cast to string/enum
					enabled,
				};
			}
		}
	}

	return { globalGain, bands };
}

/**
 * Import profile from file
 * @param e The event object
 */
export async function importProfile(e: Event) {
	const target = e.target as HTMLInputElement;
	if (!target.files) return;
	const file = target.files[0];
	if (!file) return;

	const reader = new FileReader();
	reader.onload = (event) => {
		try {
			const result = event.target?.result as string;
			let profile: ProfileData;

			// Simple heuristic detection
			if (result.trim().startsWith("{")) {
				profile = parseJsonProfile(result);
			} else if (
				result.trim().startsWith("Preamp:") ||
				result.includes("Filter 1:")
			) {
				profile = parseTextProfile(result);
			} else {
				throw new Error("Unknown file format");
			}

			// Update internal state
			setEqState(profile.bands);
			setGlobalGainState(profile.globalGain);

			// Update UI and send gain packet
			updateGlobalGain(profile.globalGain);
			renderUI(profile.bands);

			log("Profile imported. Click 'SYNC' to apply.");
		} catch (err) {
			log(`Import Error: ${(err as Error).message}`);
			console.error(err);
		} finally {
			// Clear input so the same file can be selected again
			target.value = "";
		}
	};
	reader.readAsText(file);
}
