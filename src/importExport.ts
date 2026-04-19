import { typeHasGain } from "./dsp/biquad.ts";
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
	setLoadedPresetSnapshot,
} from "./state.ts";

// Feature 9 — multi-format export. Centralised so main.ts + fn.ts agree on
// the available format codes. Keep in sync with `SessionState.exportFormat`.
export type ExportFormat =
	| "json"
	| "rew"
	| "eapo"
	| "wavelet"
	| "camilla"
	| "peace";

export interface ExportPayload {
	filename: string;
	mime: string;
	content: string;
}

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
	json: "JSON",
	rew: "REW",
	eapo: "EqualizerAPO",
	wavelet: "Wavelet",
	camilla: "CamillaDSP",
	peace: "Peace",
};

interface ProfileData {
	globalGain: number;
	bands: EQ;
}

// REW / Equalizer APO use short tokens (PK, LS, HS, LSC, HSC, HP, LP,
// BP, NO, …); internally we store the Q-width shelf variants LSQ/HSQ
// and Q-parameterised HPQ/LPQ/BPQ plus NO. Treat unknown tokens as PK
// with a warning rather than silently passing through a garbage type.
const REW_TYPE_MAP: Record<string, Band["type"]> = {
	PK: "PK",
	LS: "LSQ",
	LSQ: "LSQ",
	LSC: "LSQ",
	HS: "HSQ",
	HSQ: "HSQ",
	HSC: "HSQ",
	HP: "HPQ",
	HPQ: "HPQ",
	LP: "LPQ",
	LPQ: "LPQ",
	BP: "BPQ",
	BPQ: "BPQ",
	PBQ: "BPQ",
	NO: "NO",
	NOTCH: "NO",
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

interface ProfileSnapshot {
	deviceName: string;
	configKey: string | undefined;
	timestamp: string;
	globalGain: number;
	bands: EQ;
}

// Gather the current in-memory EQ + gain + device metadata. Shared by every
// serializer so their emission logic can stay bite-sized.
function buildProfileData(): ProfileSnapshot {
	const device = getDevice();
	return {
		deviceName: device?.productName ?? "Unknown",
		configKey: getActiveConfig()?.key,
		timestamp: new Date().toISOString(),
		globalGain: getGlobalGainState(),
		bands: getEqState(),
	};
}

// File-name slug: slot/device name, lowercased with non-alnum → dashes.
function slugify(s: string): string {
	const lower = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	return lower || "device";
}

function timestampForFilename(iso: string): string {
	// 2026-04-17T19:00:12.345Z → 2026-04-17T190012
	return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-").slice(0, 17);
}

function makeFilename(prefix: string, device: string, iso: string, ext: string): string {
	return `${prefix}-${slugify(device)}-${timestampForFilename(iso)}.${ext}`;
}

// Map an internal Band.type to the short token each format expects. Formats
// that don't natively support a filter type fall back to PK — the
// caller-side warning log happens in `exportAs` so we don't spam it here.
function apoTypeToken(type: string): string {
	switch (type) {
		case "PK":
			return "PK";
		case "LSQ":
			return "LS";
		case "HSQ":
			return "HS";
		case "HPQ":
			return "HP";
		case "LPQ":
			return "LP";
		case "BPQ":
			return "BP";
		case "NO":
			return "NO";
		default:
			return "PK";
	}
}

function camillaTypeToken(type: string): string {
	switch (type) {
		case "PK":
			return "Peaking";
		case "LSQ":
			return "Lowshelf";
		case "HSQ":
			return "Highshelf";
		case "HPQ":
			return "Highpass";
		case "LPQ":
			return "Lowpass";
		case "NO":
			return "Notch";
		case "BPQ":
			return "Bandpass";
		default:
			return "Peaking";
	}
}

// Wavelet officially supports PK / LSC / HSC only. Anything else collapses
// to a PK band with gain 0 so the emitted file still parses — callers log a
// warning for the dropped band types.
function waveletTypeToken(type: string): "PK" | "LSC" | "HSC" | "UNSUPPORTED" {
	switch (type) {
		case "PK":
			return "PK";
		case "LSQ":
			return "LSC";
		case "HSQ":
			return "HSC";
		default:
			return "UNSUPPORTED";
	}
}

function fmt(n: number, digits = 2): string {
	// Strip trailing zeros so "3.00" → "3" in exported files. Keeps output
	// diff-friendly and matches what users see in the tabular editor.
	return parseFloat(n.toFixed(digits)).toString();
}

function serializeJson(p: ProfileSnapshot): ExportPayload {
	// Preserve the exact shape the old `exportProfile()` emitted so JSON
	// round-trips with existing files.
	const data = {
		device: p.deviceName,
		config: p.configKey,
		timestamp: p.timestamp,
		globalGain: p.globalGain,
		bands: p.bands,
	};
	return {
		filename: makeFilename("ddpec", p.deviceName, p.timestamp, "json"),
		mime: "application/json",
		content: JSON.stringify(data, null, 2),
	};
}

// Format shared by REW / EqualizerAPO / Peace — they all accept the APO
// text grammar. `preampSign` inverts if a format writes Preamp as a
// positive-attenuation number (none do here; all three use negative dB).
function serializeApoStyle(p: ProfileSnapshot, ext: string, prefix: string): ExportPayload {
	const lines: string[] = [];
	lines.push(`Preamp: ${fmt(p.globalGain, 2)} dB`);
	p.bands.forEach((b, i) => {
		const state = b.enabled ? "ON" : "OFF";
		const token = apoTypeToken(b.type);
		const gainClause = typeHasGain(b.type)
			? ` Gain ${fmt(b.gain, 2)} dB`
			: "";
		lines.push(
			`Filter ${i + 1}: ${state} ${token} Fc ${fmt(b.freq, 2)} Hz${gainClause} Q ${fmt(b.q, 3)}`,
		);
	});
	return {
		filename: makeFilename(prefix, p.deviceName, p.timestamp, ext),
		mime: "text/plain",
		content: `${lines.join("\n")}\n`,
	};
}

function serializeRew(p: ProfileSnapshot): ExportPayload {
	return serializeApoStyle(p, "txt", "ddpec-rew");
}

function serializeEapo(p: ProfileSnapshot): ExportPayload {
	return serializeApoStyle(p, "txt", "ddpec-eapo");
}

function serializePeace(p: ProfileSnapshot): ExportPayload {
	return serializeApoStyle(p, "txt", "ddpec-peace");
}

function serializeWavelet(p: ProfileSnapshot): ExportPayload {
	const filters: Array<{
		filter_type: string;
		frequency: number;
		gain: number;
		q: number;
		disabled?: boolean;
	}> = [];
	const warnings: string[] = [];
	p.bands.forEach((b, i) => {
		const token = waveletTypeToken(b.type);
		if (token === "UNSUPPORTED") {
			warnings.push(
				`Band ${i + 1} (${b.type}) — Wavelet does not support this filter type. Emitted as PK gain 0.`,
			);
			filters.push({
				filter_type: "PK",
				frequency: Number(fmt(b.freq, 2)),
				gain: 0,
				q: Number(fmt(b.q, 3)),
				disabled: !b.enabled,
			});
			return;
		}
		filters.push({
			filter_type: token,
			frequency: Number(fmt(b.freq, 2)),
			gain: Number(fmt(b.gain, 2)),
			q: Number(fmt(b.q, 3)),
			disabled: !b.enabled,
		});
	});
	const data = {
		format_version: 1,
		source: "DDPEC",
		device: p.deviceName,
		preamp_db: p.globalGain,
		warnings: warnings.length ? warnings : undefined,
		filters,
	};
	// Drop undefined so the file is tidy.
	const content = JSON.stringify(data, null, 2);
	for (const w of warnings) log(`Export (Wavelet): ${w}`);
	return {
		filename: makeFilename("ddpec-wavelet", p.deviceName, p.timestamp, "json"),
		mime: "application/json",
		content,
	};
}

function serializeCamilla(p: ProfileSnapshot): ExportPayload {
	const lines: string[] = [];
	lines.push("# DDPEC export — CamillaDSP filter block.");
	lines.push(`# Device: ${p.deviceName}`);
	lines.push(`# Preamp: ${fmt(p.globalGain, 2)} dB (apply via your Pipeline gain stage).`);
	lines.push("filters:");
	p.bands.forEach((b, i) => {
		const name = `eq_${i + 1}`;
		lines.push(`  ${name}:`);
		lines.push("    type: Biquad");
		lines.push("    parameters:");
		lines.push(`      type: ${camillaTypeToken(b.type)}`);
		lines.push(`      freq: ${fmt(b.freq, 2)}`);
		lines.push(`      q: ${fmt(b.q, 3)}`);
		if (typeHasGain(b.type)) {
			lines.push(`      gain: ${fmt(b.gain, 2)}`);
		}
		if (!b.enabled) {
			lines.push(`      # disabled`);
		}
	});
	return {
		filename: makeFilename("ddpec-camilla", p.deviceName, p.timestamp, "yaml"),
		mime: "text/yaml",
		content: `${lines.join("\n")}\n`,
	};
}

/**
 * Multi-format export dispatcher. Returns a payload the caller drops into a
 * Blob download. Format picks live in `SessionState.exportFormat`.
 */
export function exportAs(format: ExportFormat): ExportPayload {
	const profile = buildProfileData();
	switch (format) {
		case "json":
			return serializeJson(profile);
		case "rew":
			return serializeRew(profile);
		case "eapo":
			return serializeEapo(profile);
		case "wavelet":
			return serializeWavelet(profile);
		case "camilla":
			return serializeCamilla(profile);
		case "peace":
			return serializePeace(profile);
	}
}

/**
 * Legacy single-button export — preserved for back-compat but now delegates
 * to the JSON serializer. New call sites should use `exportAs` + the
 * session-persisted format picker.
 */
export async function exportProfile() {
	const payload = exportAs("json");
	const blob = new Blob([payload.content], { type: payload.mime });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = payload.filename;
	a.click();
	URL.revokeObjectURL(a.href);
}

/**
 * Download helper used by the preset action bar menu. Handles the Blob +
 * anchor dance so callers just pass the serialized payload.
 */
export function downloadPayload(payload: ExportPayload) {
	const blob = new Blob([payload.content], { type: payload.mime });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = payload.filename;
	a.click();
	URL.revokeObjectURL(a.href);
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
	// Groups: 1=Index, 2=State(ON/OFF), 3=Type, 4=Fc, 5=Gain (optional for
	// gainless HP/LP/NO/BP), 6=Q.
	const filterRegex =
		/^Filter\s+(\d+):\s+(ON|OFF)\s+([A-Z]+)\s+Fc\s+(\d+(?:\.\d+)?)\s*(?:Hz)?(?:\s+Gain\s+(-?\d+(?:\.\d+)?)\s*(?:dB)?)?\s+Q\s+(\d+(?:\.\d+)?)/i;

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
				// Gain is optional — gainless filter types (HP/LP/NO/BP) may
				// omit it in REW-format exports. Default to 0 when absent.
				const gain =
					filterMatch[5] !== undefined ? parseFloat(filterMatch[5]) : 0;
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
	// Feature 4 — treat the just-imported profile as the new preset baseline
	// so subsequent edits earn the "changed vs preset" dot.
	setLoadedPresetSnapshot(fitted);
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
