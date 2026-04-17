import { describe, expect, it } from "vitest";
import type { Band } from "../main.ts";
import {
	encodeFiioBand,
	encodeMoondropBand,
	encodeMoondropEnable,
	encodeSavitechBand,
	padSavitech,
} from "./encoders.ts";

function band(overrides: Partial<Band>): Band {
	return {
		index: 0,
		freq: 1000,
		gain: 0,
		q: 1,
		type: "PK",
		enabled: true,
		...overrides,
	};
}

// Read a little-endian int16 from a packet.
function i16le(packet: Uint8Array, offset: number): number {
	const v = packet[offset] | (packet[offset + 1] << 8);
	return v & 0x8000 ? v - 0x10000 : v;
}

function u16le(packet: Uint8Array, offset: number): number {
	return packet[offset] | (packet[offset + 1] << 8);
}

describe("padSavitech", () => {
	it("produces a 63-byte packet padded with zeros", () => {
		const padded = padSavitech([0x01, 0x02, 0x03]);
		expect(padded.length).toBe(63);
		expect(padded[0]).toBe(0x01);
		expect(padded[2]).toBe(0x03);
		expect(padded[3]).toBe(0x00);
		expect(padded[62]).toBe(0x00);
	});
});

describe("encodeSavitechBand", () => {
	const b = band({ index: 3, freq: 1000, gain: 6, q: 1.5, type: "PK" });
	const packet = encodeSavitechBand(b, 6);

	it("is 63 bytes (WRITE PEQ padded)", () => {
		expect(packet.length).toBe(63);
	});

	it("starts with WRITE/PEQ header and band index", () => {
		expect(packet[0]).toBe(0x01); // CMD_SAVI.WRITE
		expect(packet[1]).toBe(0x09); // CMD_SAVI.PEQ
		expect(packet[2]).toBe(0x18);
		expect(packet[4]).toBe(3); // band index
	});

	it("encodes freq as u16 LE at offset 27", () => {
		expect(u16le(packet, 27)).toBe(1000);
	});

	it("encodes Q*256 as u16 LE at offset 29", () => {
		expect(u16le(packet, 29)).toBe(Math.round(1.5 * 256));
	});

	it("encodes gain*256 as i16 LE at offset 31", () => {
		expect(i16le(packet, 31)).toBe(Math.round(6 * 256));
	});

	it("encodes PK as type code 2 at offset 33", () => {
		expect(packet[33]).toBe(2);
	});

	it("ends with CMD_SAVI.END (0x00) at offset 36", () => {
		expect(packet[36]).toBe(0x00);
	});

	it("handles negative gain via two's complement", () => {
		const neg = encodeSavitechBand(band({ gain: -6 }), -6);
		expect(i16le(neg, 31)).toBe(Math.round(-6 * 256));
	});

	it("writes LSQ as type code 1", () => {
		const ls = encodeSavitechBand(
			band({ type: "LSQ", freq: 80, gain: -3, q: 0.7 }),
			-3,
		);
		expect(ls[33]).toBe(1);
	});

	it("writes HSQ as type code 3", () => {
		const hs = encodeSavitechBand(
			band({ type: "HSQ", freq: 8000, gain: 4, q: 0.7 }),
			4,
		);
		expect(hs[33]).toBe(3);
	});
});

describe("encodeMoondropBand", () => {
	const b = band({ index: 2, freq: 2000, gain: 3, q: 1.2, type: "PK" });
	const packet = encodeMoondropBand(b, 3);

	it("is 63 bytes", () => {
		expect(packet.length).toBe(63);
	});

	it("starts with WRITE/UPDATE_EQ header and band index", () => {
		expect(packet[0]).toBe(1); // CMD_MOON.WRITE
		expect(packet[1]).toBe(9); // CMD_MOON.UPDATE_EQ
		expect(packet[2]).toBe(0x18);
		expect(packet[4]).toBe(2);
	});

	it("encodes freq, Q*256, gain*256 at offsets 27/29/31", () => {
		expect(u16le(packet, 27)).toBe(2000);
		expect(u16le(packet, 29)).toBe(Math.round(1.2 * 256));
		expect(i16le(packet, 31)).toBe(Math.round(3 * 256));
	});

	it("encodes PK as type code 2 at offset 33", () => {
		expect(packet[33]).toBe(2);
	});
});

describe("encodeMoondropEnable", () => {
	it("is 63 bytes", () => {
		expect(encodeMoondropEnable(5).length).toBe(63);
	});

	it("writes index at offset 2 and 0xFFFFFF at offsets 4-6", () => {
		const p = encodeMoondropEnable(5);
		expect(p[0]).toBe(1); // CMD_MOON.WRITE
		expect(p[1]).toBe(10); // CMD_MOON.UPDATE_EQ_COEFF
		expect(p[2]).toBe(5);
		expect(p[4]).toBe(0xff);
		expect(p[5]).toBe(0xff);
		expect(p[6]).toBe(0xff);
	});
});

describe("encodeFiioBand", () => {
	const b = band({ index: 4, freq: 3000, gain: 2.5, q: 0.8, type: "PK" });
	const packet = encodeFiioBand(b, 2.5);

	it("is 16 bytes with the documented layout", () => {
		expect(packet.length).toBe(16);
	});

	it("starts with AA 0A 00 00 15 08", () => {
		expect(Array.from(packet.slice(0, 6))).toEqual([
			0xaa, 0x0a, 0x00, 0x00, 0x15, 0x08,
		]);
	});

	it("ends with 0x00 0xEE", () => {
		expect(packet[14]).toBe(0x00);
		expect(packet[15]).toBe(0xee); // CMD_FIIO.END
	});

	it("writes freq LE at offsets 9-10", () => {
		expect(packet[9]).toBe(3000 & 0xff);
		expect(packet[10]).toBe((3000 >> 8) & 0xff);
	});

	it("writes Q*100 BE at offsets 11-12 (high, low)", () => {
		expect(packet[11]).toBe(((0.8 * 100) >> 8) & 0xff); // 0
		expect(packet[12]).toBe(0.8 * 100); // 80
	});

	it("writes PK as type code 0 at offset 13", () => {
		expect(packet[13]).toBe(0);
	});

	it("writes LSQ as type code 1 and HSQ as type code 2", () => {
		const ls = encodeFiioBand(band({ type: "LSQ" }), 0);
		const hs = encodeFiioBand(band({ type: "HSQ" }), 0);
		expect(ls[13]).toBe(1);
		expect(hs[13]).toBe(2);
	});

	it("round-trips positive gain via the documented byte layout", () => {
		// gain*10 = 25; bytes are [high, low] of a 16-bit value packed
		// into offsets 7 (gainLow) and 8 (gainHigh) per the current code.
		const t = 25;
		expect(packet[7]).toBe((t >> 8) & 0xff);
		expect(packet[8]).toBe(t & 0xff);
	});

	it("encodes negative gain via two's complement", () => {
		// Current encoder uses 16-bit two's complement: (|t| XOR 0xFFFF) + 1.
		// This test pins the existing behavior; update when 1.7 is resolved.
		const neg = encodeFiioBand(band({ gain: -1 }), -1);
		const t = (Math.abs(-10) ^ 0xffff) + 1;
		expect(neg[7]).toBe((t >> 8) & 0xff);
		expect(neg[8]).toBe(t & 0xff);
	});
});
