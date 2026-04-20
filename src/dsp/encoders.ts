import {
	CMD_FIIO,
	CMD_MOON,
	CMD_SAVI,
	PACKET_SIZE,
	SAMPLE_RATE,
} from "../constants.ts";
import type { Band } from "../main.ts";
import { computeBiquad, toProtocolCoeffs, toQ30Bytes } from "./biquad.ts";

// Type code mapping shared by Savitech and Moondrop firmwares.
const BIQUAD_TYPE_MAP = { PK: 2, LSQ: 1, HSQ: 3 } as const;

// FiiO uses a different type code mapping.
const FIIO_TYPE_MAP = { PK: 0, LSQ: 1, HSQ: 2 } as const;

function toBytes(n: number, c: number): number[] {
	return Array.from({ length: c }, (_, i) => (n >> (8 * i)) & 0xff);
}

function bandTypeCode<T extends Record<Band["type"], number>>(
	band: Band,
	map: T,
): number {
	return map[band.type as Band["type"]] ?? 0;
}

// Pad an arbitrary byte array to the Savitech HID report size.
export function padSavitech(bytes: number[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(PACKET_SIZE));
	for (let i = 0; i < Math.min(bytes.length, PACKET_SIZE); i++) out[i] = bytes[i];
	return out;
}

// Savitech / Walkplay band packet: WRITE PEQ with inline Q30 biquad + raw params.
export function encodeSavitechBand(band: Band, gain: number): Uint8Array<ArrayBuffer> {
	const coeffs = computeBiquad({ ...band, gain }, SAMPLE_RATE);
	const bArr = toQ30Bytes(toProtocolCoeffs(coeffs));

	const freqBytes = toBytes(band.freq, 2);
	const qBytes = toBytes(Math.round(band.q * 256), 2);
	const gainBytes = toBytes(Math.round(gain * 256), 2);

	return padSavitech([
		CMD_SAVI.WRITE,
		CMD_SAVI.PEQ,
		0x18,
		0x00,
		band.index,
		0x00,
		0x00,
		...bArr,
		...freqBytes,
		...qBytes,
		...gainBytes,
		bandTypeCode(band, BIQUAD_TYPE_MAP),
		0x00,
		0x00,
		CMD_SAVI.END,
	]);
}

// Moondrop / Comtrue band packet. Shares Savitech's Q30 layout at offset 7.
export function encodeMoondropBand(band: Band, gain: number): Uint8Array<ArrayBuffer> {
	const coeffs = computeBiquad({ ...band, gain }, SAMPLE_RATE);
	const coeffBytes = new Uint8Array(toQ30Bytes(toProtocolCoeffs(coeffs)));

	const packet = new Uint8Array(new ArrayBuffer(PACKET_SIZE));
	packet[0] = CMD_MOON.WRITE;
	packet[1] = CMD_MOON.UPDATE_EQ;
	packet[2] = 0x18;
	packet[3] = 0x00;
	packet[4] = band.index;

	packet.set(coeffBytes, 7);

	packet[27] = band.freq & 0xff;
	packet[28] = (band.freq >> 8) & 0xff;

	const qVal = Math.round(band.q * 256);
	packet[29] = qVal & 0xff;
	packet[30] = (qVal >> 8) & 0xff;

	const gainVal = Math.round(gain * 256);
	packet[31] = gainVal & 0xff;
	packet[32] = (gainVal >> 8) & 0xff;

	packet[33] = bandTypeCode(band, BIQUAD_TYPE_MAP);
	return packet;
}

// Moondrop "enable coefficient" follow-up packet that tells the device
// which bands to apply. Sent after each band update.
export function encodeMoondropEnable(bandIndex: number): Uint8Array<ArrayBuffer> {
	const packet = new Uint8Array(new ArrayBuffer(PACKET_SIZE));
	packet[0] = CMD_MOON.WRITE;
	packet[1] = CMD_MOON.UPDATE_EQ_COEFF;
	packet[2] = bandIndex;
	packet[4] = 0xff;
	packet[5] = 0xff;
	packet[6] = 0xff;
	return packet;
}

// FiiO band packet. Unlike Savitech/Moondrop, FiiO takes raw params —
// the firmware computes the biquad itself.
export function encodeFiioBand(band: Band, gain: number): Uint8Array<ArrayBuffer> {
	const freqLow = band.freq & 0xff;
	const freqHigh = (band.freq >> 8) & 0xff;

	// TODO (plan 1.7): byte ordering copied from fiioUsbHidHandler.js —
	// verify against a captured packet and lock via fixture.
	let t = gain * 10;
	if (t < 0) t = (Math.abs(t) ^ 0xffff) + 1;
	const gainLow = (t >> 8) & 0xff;
	const gainHigh = t & 0xff;

	const qVal = Math.round(band.q * 100);
	const qLow = (qVal >> 8) & 0xff;
	const qHigh = qVal & 0xff;

	const bytes = [
		CMD_FIIO.HEADER_SET_1,
		CMD_FIIO.HEADER_SET_2,
		0,
		0,
		CMD_FIIO.FILTER_PARAMS,
		8,
		band.index,
		gainLow,
		gainHigh,
		freqLow,
		freqHigh,
		qLow,
		qHigh,
		bandTypeCode(band, FIIO_TYPE_MAP),
		0,
		CMD_FIIO.END,
	];
	const packet = new Uint8Array(new ArrayBuffer(bytes.length));
	packet.set(bytes);
	return packet;
}
