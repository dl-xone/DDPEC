import { renderUI } from "./fn.ts";
import { log, updateGlobalGain } from "./helpers.ts";
import type { Band, EQ } from "./main.ts";
import {
	defaultEqState,
	getActiveConfig,
	getDevice,
	getEqState,
	getGlobalGainState,
	setEqState,
	setGlobalGainState,
} from "./state.ts";

interface ProfileData {
	globalGain: number;
	bands: EQ;
}

// REW / Equalizer APO use short tokens (PK, LS, HS, LSC, HSC); internally
// we store the Q-width shelf variants LSQ/HSQ. Treat unknown tokens as PK
// with a warning rather than silently passing through a garbage type.
const REW_TYPE_MAP: Record<string, Band["type"]> = {
	PK: "PK",
	LS: "LSQ",
	LSQ: "LSQ",
	LSC: "LSQ",
	HS: "HSQ",
	HSQ: "HSQ",
	HSC: "HSQ",
};

/**
 * Fit imported bands to the active device's band count. If the profile
 * has fewer bands than the device supports, remaining slots are reset
 * to defaults; excess bands are dropped. Both cases are logged.
 */
function fitBandsToConfig(bands: EQ): EQ {
	const cfg = getActiveConfig();
	const defaults = defaultEqState(cfg);
	const max = defaults.length;

	if (bands.length === max) return bands.map((b, i) => ({ ...b, index: i }));

	if (bands.length > max) {
		log(
			`Import: profile has ${bands.length} bands, device supports ${max}. Truncating.`,
		);
		return bands.slice(0, max).map((b, i) => ({ ...b, index: i }));
	}

	log(
		`Import: profile has ${bands.length} bands, device supports ${max}. Filling remaining with defaults.`,
	);
	const filled = defaults.slice();
	for (let i = 0; i < bands.length; i++) {
		filled[i] = { ...bands[i], index: i };
	}
	return filled;
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
				const rawType = filterMatch[3].toUpperCase();
				const type = REW_TYPE_MAP[rawType];
				if (!type) {
					log(
						`Import: unknown filter type "${rawType}" at filter ${index + 1}, defaulting to PK`,
					);
				}
				const freq = parseFloat(filterMatch[4]);
				const gain = parseFloat(filterMatch[5]);
				const q = parseFloat(filterMatch[6]);

				bands[index] = {
					...bands[index],
					freq,
					gain,
					q,
					type: type ?? "PK",
					enabled,
				};
			}
		}
	}

	return { globalGain, bands };
}

// Parse a raw profile string (JSON or REW-format text) and apply it.
// Shared by file-based imports and programmatic loaders (e.g. AutoEQ).
export function applyProfileText(text: string, sourceName: string) {
	let profile: ProfileData;

	if (text.trim().startsWith("{")) {
		profile = parseJsonProfile(text);
	} else if (
		text.trim().startsWith("Preamp:") ||
		text.includes("Filter 1:")
	) {
		profile = parseTextProfile(text);
	} else {
		throw new Error("Unknown profile format");
	}

	const fitted = fitBandsToConfig(profile.bands);
	setEqState(fitted);
	setGlobalGainState(profile.globalGain);
	updateGlobalGain(profile.globalGain);
	renderUI(fitted);
	log(`Profile imported: ${sourceName}. Click 'SYNC' to apply.`);
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
			applyProfileText(result, file.name);
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
