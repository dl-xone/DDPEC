import {
	CMD_FIIO,
	CMD_MOON,
	CMD_SAVI,
	DEFAULT_FREQS,
	REPORT_ID_DEFAULT,
	REPORT_ID_FIIO,
} from "./constants.ts";
import type { Protocol } from "./deviceConfig.ts";
import {
	encodeFiioBand,
	encodeMoondropBand,
	encodeMoondropEnable,
	encodeSavitechBand,
	padSavitech,
} from "./dsp/encoders.ts";
import { renderUI, setGlobalGain } from "./fn.ts";
import { delay, log, updateGlobalGainUI } from "./helpers.ts";
import { confirmModal } from "./modal.ts";
import {
	getActiveConfig,
	getCurrentSlotId,
	getDevice,
	getEqState,
	getGlobalGainState,
	isEqEnabled,
	setGlobalGainState,
} from "./state.ts";
import type { Band } from "./main.ts";

/**
 * DETECT PROTOCOL FROM ACTIVE CONFIG
 */
function getProtocol(_device: HIDDevice): Protocol {
	return getActiveConfig()?.protocol ?? "WALKPLAY";
}

/**
 * UNIVERSAL GLOBAL GAIN SETTER
 * Called by helpers.ts to update volume
 */
export async function setDeviceGlobalGain(gain: number) {
	setGlobalGain(gain);
	const device = getDevice();
	if (!device) return;

	const cfg = getActiveConfig();
	if (cfg?.autoGlobalGain) return;

	const protocol = getProtocol(device);

	if (protocol === "FIIO") {
		await setGlobalGainFiio(device, gain);
	} else if (protocol === "MOONDROP") {
		await setGlobalGainMoondrop(device, gain);
	} else {
		await sendPacketSavitech(device, [
			CMD_SAVI.WRITE,
			CMD_SAVI.GAIN,
			0x02,
			0x00,
			gain,
		]);
	}
}

/**
 * Read device parameters
 * @param device The device to read from
 */
export async function readDeviceParams(device: HIDDevice) {
	if (!device) return;
	log("Reading device configuration...");

	// Read Version
	await sendPacketSavitech(device, [
		CMD_SAVI.READ,
		CMD_SAVI.VERSION,
		CMD_SAVI.END,
	]);
	await delay(50);
	// Read Gain
	await sendPacketSavitech(device, [
		CMD_SAVI.READ,
		CMD_SAVI.GAIN,
		CMD_SAVI.END,
	]);
	await delay(50);

	const maxFilters = getActiveConfig()?.maxFilters ?? DEFAULT_FREQS.length;
	// Request all bands
	for (let i = 0; i < maxFilters; i++) {
		await sendPacketSavitech(device, [
			CMD_SAVI.READ,
			CMD_SAVI.PEQ,
			0x00,
			0x00,
			i,
			CMD_SAVI.END,
		]);
		await delay(40);
	}
	log("Configuration loaded.");
}

/**
 * Setup listener for device events
 * @param device The device to listen to
 */
export function setupListener(device: HIDDevice) {
	const eqState = getEqState();
	device.addEventListener("inputreport", (event) => {
		const versionEl = document.getElementById("fwVersion");
		const data = new Uint8Array(event.data.buffer);
		const cmd = data[1];

		if (cmd === CMD_SAVI.VERSION) {
			let ver = "";
			for (let i = 3; i < 10; i++) {
				if (data[i] === 0) break;
				ver += String.fromCharCode(data[i]);
			}
			versionEl!.innerText = `FW: ${ver}`;
		} else if (cmd === CMD_SAVI.GAIN) {
			const gain = new Int8Array([data[4]])[0];
			// Readback path — update state + UI silently so the commit bar
			// doesn't pop on connect.
			setGlobalGainState(gain, { silent: true });
			updateGlobalGainUI(gain);
		} else if (cmd === CMD_SAVI.PEQ && data.byteLength >= 34) {
			const idx = data[4];
			if (idx < eqState.length) {
				const view = new DataView(data.buffer);
				const rawFreq = view.getUint16(27, true);
				const rawQ = view.getUint16(29, true);
				const rawGain = view.getInt16(31, true);
				const typeCode = data[33];

				// Calculate values
				const freq = rawFreq;
				const q = Math.round((rawQ / 256) * 100) / 100;
				const gain = Math.round((rawGain / 256) * 10) / 10;

				let typeStr = "PK";
				if (typeCode === 1) typeStr = "LSQ";
				else if (typeCode === 3) typeStr = "HSQ";

				// Validate data - 0xFFFF (65535) indicates uninitialized flash memory
				// Also check for unreasonable values that indicate corrupted data
				const isInvalidData =
					rawFreq === 0xffff ||
					rawFreq === 0 ||
					rawFreq > 24000 ||
					rawQ === 0xffff ||
					q > 100 ||
					q <= 0;

				// Update State from Device with validation
				const fallbackFreqs = getActiveConfig()?.defaultFreqs ?? DEFAULT_FREQS;
				eqState[idx].freq = isInvalidData ? (fallbackFreqs[idx] ?? 1000) : freq;
				eqState[idx].q = isInvalidData ? 1.0 : q;
				eqState[idx].gain = isInvalidData ? 0 : gain;
				eqState[idx].type = typeStr;
				// Note: Hardware doesn't store an "enabled" state, assume enabled if gain != 0 or default
				eqState[idx].enabled = true;
			}
		}

		renderUI(eqState);
	});
}

// --- MAIN SYNC FUNCTION ---

export type ProgressFn = (packetIndex: number, totalPackets: number) => void;

// Invoke the progress callback; if it throws, log and continue so a buggy
// UI callback can't abort an in-flight sync. (eng review critical gap)
function safeProgress(onProgress: ProgressFn | undefined, i: number, n: number) {
	if (!onProgress) return;
	try {
		onProgress(i, n);
	} catch (err) {
		console.warn("sync progress callback threw:", err);
	}
}

// Sync the current EQ state to device RAM. Optional onProgress reports
// per-band completion so the UI can show a progress bar.
export async function syncToDevice(onProgress?: ProgressFn) {
	const device = getDevice();
	const eqState = getEqState();
	if (!device || !eqState) return;

	const protocol = getProtocol(device);
	log(`Syncing via protocol: ${protocol}...`);
	const total = eqState.length;

	// 1. Write Global Gain (Reuse the function above)
	await setDeviceGlobalGain(getGlobalGainState());

	// 2. Write Bands
	for (let i = 0; i < eqState.length; i++) {
		await writeBand(device, eqState[i], protocol);
		await delay(30);
		safeProgress(onProgress, i + 1, total);
	}

	// 3. Commit / Temp Save
	if (protocol === "WALKPLAY") {
		const cfg = getActiveConfig();
		const gainByte = cfg?.autoGlobalGain ? 0x00 : getGlobalGainState();
		await sendPacketSavitech(device, [
			CMD_SAVI.WRITE,
			CMD_SAVI.TEMP,
			0x04,
			0x00,
			gainByte,
			0xff,
			0xff,
			CMD_SAVI.END,
		]);
		await delay(50);
		// TODO (plan 1.2): verify this is a temp-buffer commit, not a flash
		// write. Current code issues the same packet here and in flashToFlash,
		// so "SYNC TO RAM" may be persisting to a slot. Resolve with a
		// protocol capture before shipping Wave 2.
		await sendPacketSavitech(device, [
			CMD_SAVI.WRITE,
			CMD_SAVI.FLASH,
			0x01,
			getCurrentSlotId(),
			CMD_SAVI.END,
		]);
	}

	log("Sync Complete.");
}

// Save EQ state to permanent memory. Optional onProgress is called with
// (1, 1) on success so callers can drive a unified progress UI even
// though flash is a single-packet operation.
//
// JDS pivot 2026-04-17: callers that already surface a user-facing confirm
// (e.g. the anchored popover in fn.ts) may pass `{ skipConfirm: true }` to
// suppress the internal confirmModal and avoid a double prompt. Default
// behaviour is unchanged so `resetToDefaults`-style callers keep working.
export async function flashToFlash(
	onProgress?: ProgressFn,
	opts?: { skipConfirm?: boolean },
) {
	const device = getDevice();
	if (!device) return;
	const slot = getCurrentSlotId();
	if (!opts?.skipConfirm) {
		const ok = await confirmModal(
			`Save current EQ to slot ${slot} on the device's flash memory? This persists across reboots and cannot be undone from the tool.`,
			{
				title: "Save to flash?",
				confirmLabel: "Save to flash",
				cancelLabel: "Cancel",
			},
		);
		if (!ok) return;
	}

	const protocol = getProtocol(device);

	if (protocol === "FIIO") {
		// FiiO Save: AA 0A ... 19 ...
		const packet = new Uint8Array(64);
		packet.set([
			CMD_FIIO.HEADER_SET_1,
			CMD_FIIO.HEADER_SET_2,
			0,
			0,
			CMD_FIIO.SAVE,
			1,
			1,
			0,
			CMD_FIIO.END,
		]);
		await device.sendReport(REPORT_ID_FIIO, packet);
	} else if (protocol === "MOONDROP") {
		// Moondrop Save: Cmd 1, SubCmd 1
		const packet = new Uint8Array([CMD_MOON.WRITE, CMD_MOON.SAVE_FLASH]);
		await device.sendReport(REPORT_ID_DEFAULT, packet);
	} else {
		// Walkplay / Savitech Save
		await sendPacketSavitech(device, [
			CMD_SAVI.WRITE,
			CMD_SAVI.FLASH,
			0x01,
			getCurrentSlotId(),
			CMD_SAVI.END,
		]);
	}

	safeProgress(onProgress, 1, 1);
	log("Saved to Flash.");
}

/**
 * DISPATCHER FOR WRITING BANDS
 */
export async function writeBand(
	device: HIDDevice,
	band: Band,
	protocol: Protocol,
) {
	// JDS pivot 2026-04-17: when EQ is globally bypassed, write neutral
	// (gain = 0) for every band so the device produces a flat response.
	// Band state is NOT mutated — re-enabling the EQ and re-syncing writes
	// the real gain values back.
	const effectiveGain = !isEqEnabled() || !band.enabled ? 0 : band.gain;

	if (protocol === "FIIO") {
		await writeBandFiio(device, band, effectiveGain);
	} else if (protocol === "MOONDROP") {
		await writeBandMoondrop(device, band, effectiveGain);
	} else {
		await writeBandSavitech(device, band, effectiveGain);
	}
}

// --------------------------------------------------------------------------
// STRATEGY: SAVITECH (Walkplay)
// --------------------------------------------------------------------------
/**
 * Write a band to a Savitech device
 * @param device The device to send the packet to
 * @param band The band to write
 * @param gain The gain to set
 */
async function writeBandSavitech(device: HIDDevice, band: Band, gain: number) {
	try {
		await device.sendReport(REPORT_ID_DEFAULT, encodeSavitechBand(band, gain));
	} catch (err) {
		log(`TX Error: ${(err as Error).message}`);
	}
}

// --------------------------------------------------------------------------
// STRATEGY: MOONDROP (Comtrue/KTMicro)
// --------------------------------------------------------------------------
/**
 * Write a band to a Moondrop device
 * @param device The device to send the packet to
 * @param band The band to write
 * @param gain The gain to set
 */
async function writeBandMoondrop(device: HIDDevice, band: Band, gain: number) {
	await device.sendReport(REPORT_ID_DEFAULT, encodeMoondropBand(band, gain));
	await device.sendReport(REPORT_ID_DEFAULT, encodeMoondropEnable(band.index));
}

/**
 * Set global gain for Moondrop devices
 * @param device The device to send the packet to
 * @param gain The gain to set
 */
async function setGlobalGainMoondrop(device: HIDDevice, gain: number) {
	const val = Math.round(gain * 256);
	const packet = new Uint8Array([
		CMD_MOON.WRITE,
		CMD_MOON.PRE_GAIN,
		0,
		val & 255,
		(val >> 8) & 255,
	]);
	await device.sendReport(REPORT_ID_DEFAULT, packet);
}

// --------------------------------------------------------------------------
// STRATEGY: FIIO
// --------------------------------------------------------------------------
/**
 * Write a band to a Fiio device
 * @param device The device to send the packet to
 * @param band The band to write
 * @param gain The gain to set
 */
async function writeBandFiio(device: HIDDevice, band: Band, gain: number) {
	await device.sendReport(REPORT_ID_FIIO, encodeFiioBand(band, gain));
}

/**
 * Set global gain for Fiio devices
 * @param device The device to send the packet to
 * @param gain The gain to set
 */
async function setGlobalGainFiio(device: HIDDevice, gain: number) {
	const val = Math.round(gain * 10);
	const gLow = val & 0xff;
	const gHigh = (val >> 8) & 0xff;

	// Packet from file: AA 0A ... 17 02 [High] [Low] 00 EE
	const packet = new Uint8Array([
		CMD_FIIO.HEADER_SET_1,
		CMD_FIIO.HEADER_SET_2,
		0,
		0,
		CMD_FIIO.GLOBAL_GAIN,
		2,
		gHigh,
		gLow,
		0,
		CMD_FIIO.END,
	]);
	await device.sendReport(REPORT_ID_FIIO, packet);
}

// --------------------------------------------------------------------------
// HELPER FUNCTIONS
// --------------------------------------------------------------------------
/**
 * Send a padded Savitech control packet (non-band; band packets use
 * encodeSavitechBand directly).
 */
async function sendPacketSavitech(device: HIDDevice, bytes: number[]) {
	try {
		await device.sendReport(REPORT_ID_DEFAULT, padSavitech(bytes));
	} catch (err) {
		log(`TX Error: ${(err as Error).message}`);
	}
}
