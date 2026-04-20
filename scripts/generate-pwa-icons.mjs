#!/usr/bin/env node
// Generate placeholder PWA icons for DDPEC.
//
// Emits public/icon-192.png and public/icon-512.png: a #0a0a0c background
// square with a centered #cf4863 filled circle (the brand's bullet mark).
//
// Run once after install:
//   node scripts/generate-pwa-icons.mjs
//
// No dependencies — writes a hand-rolled 8-bit RGBA PNG via Node's built-in
// zlib for the IDAT deflate stream. This keeps devDependencies lean.

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", "public");

const BG = [0x0a, 0x0a, 0x0c, 0xff];
const FG = [0xcf, 0x48, 0x63, 0xff];

mkdirSync(OUT_DIR, { recursive: true });

function crc32(buf) {
	// Standard PNG CRC-32 of bytes.
	let c;
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	let crc = 0xffffffff;
	for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "ascii");
	const crcInput = Buffer.concat([typeBuf, data]);
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(crcInput), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function generateIcon(size) {
	// RGBA pixel buffer with filter byte (0) per row.
	const rowBytes = size * 4 + 1;
	const raw = Buffer.alloc(rowBytes * size);
	const cx = size / 2;
	const cy = size / 2;
	const radius = size * 0.32;
	for (let y = 0; y < size; y++) {
		raw[y * rowBytes] = 0; // filter: None
		for (let x = 0; x < size; x++) {
			const dx = x + 0.5 - cx;
			const dy = y + 0.5 - cy;
			const inside = dx * dx + dy * dy <= radius * radius;
			const off = y * rowBytes + 1 + x * 4;
			const color = inside ? FG : BG;
			raw[off] = color[0];
			raw[off + 1] = color[1];
			raw[off + 2] = color[2];
			raw[off + 3] = color[3];
		}
	}
	const idat = deflateSync(raw);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type (RGBA)
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter
	ihdr[12] = 0; // interlace
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return Buffer.concat([
		signature,
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

for (const size of [192, 512]) {
	const png = generateIcon(size);
	const out = join(OUT_DIR, `icon-${size}.png`);
	writeFileSync(out, png);
	console.log(`wrote ${out} (${png.length} bytes)`);
}
