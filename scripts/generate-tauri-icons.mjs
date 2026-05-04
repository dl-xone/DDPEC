#!/usr/bin/env node
// Generate icons for the Tauri build.
//
// Emits:
//   src-tauri/icons/icon.png        — 1024x1024 app/dock icon (full colour)
//   src-tauri/icons/icon-256.png    — 256x256 secondary
//   src-tauri/icons/icon-128.png    — 128x128 secondary
//   src-tauri/icons/icon-32.png     — 32x32 secondary
//   src-tauri/icons/tray-icon.png   — 22x22 macOS tray template (black on
//                                     transparent; Tauri's iconAsTemplate
//                                     lets macOS tint it correctly)
//
// Run after install + every time the brand mark changes:
//   node scripts/generate-tauri-icons.mjs
//
// No external dependencies — writes raw 8-bit RGBA PNGs via Node's
// zlib + a hand-rolled chunk encoder, mirroring scripts/generate-pwa-
// icons.mjs.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", "src-tauri", "icons");

mkdirSync(OUT_DIR, { recursive: true });

const TRANSPARENT = [0x00, 0x00, 0x00, 0x00];
const APP_BG = [0x0a, 0x0a, 0x0c, 0xff];
const APP_FG = [0xcf, 0x48, 0x63, 0xff];
const TEMPLATE_FG = [0x00, 0x00, 0x00, 0xff];

function crc32(buf) {
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
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildPng(size, painter) {
	const rowBytes = size * 4 + 1;
	const raw = Buffer.alloc(rowBytes * size);
	for (let y = 0; y < size; y++) {
		raw[y * rowBytes] = 0; // filter: None
		for (let x = 0; x < size; x++) {
			const off = y * rowBytes + 1 + x * 4;
			const color = painter(x, y, size);
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
	ihdr[8] = 8;
	ihdr[9] = 6;
	const signature = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	]);
	return Buffer.concat([
		signature,
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// Soft-edge anti-aliased circle. `inner`/`outer` define the smoothstep
// band (in pixels) so the disc edge isn't pixelated at small sizes.
function smoothCircle(x, y, size, fill, bg, radiusFrac) {
	const cx = size / 2;
	const cy = size / 2;
	const radius = size * radiusFrac;
	const dx = x + 0.5 - cx;
	const dy = y + 0.5 - cy;
	const dist = Math.sqrt(dx * dx + dy * dy);
	const edgeWidth = Math.max(0.6, size * 0.01);
	const t = Math.max(0, Math.min(1, (radius - dist) / edgeWidth));
	if (t === 1) return fill;
	if (t === 0) return bg;
	return [
		Math.round(fill[0] * t + bg[0] * (1 - t)),
		Math.round(fill[1] * t + bg[1] * (1 - t)),
		Math.round(fill[2] * t + bg[2] * (1 - t)),
		Math.round(fill[3] * t + bg[3] * (1 - t)),
	];
}

function appPainter(x, y, size) {
	return smoothCircle(x, y, size, APP_FG, APP_BG, 0.32);
}

function trayPainter(x, y, size) {
	// Tray icon = solid black filled circle on transparent bg. macOS will
	// tint to match the active menubar appearance (light mode = dark glyph,
	// dark mode = light glyph) because iconAsTemplate is true.
	return smoothCircle(x, y, size, TEMPLATE_FG, TRANSPARENT, 0.42);
}

const APP_SIZES = [1024, 256, 128, 32];
for (const size of APP_SIZES) {
	const png = buildPng(size, appPainter);
	const name = size === 1024 ? "icon.png" : `icon-${size}.png`;
	const out = join(OUT_DIR, name);
	writeFileSync(out, png);
	console.log(`wrote ${out} (${png.length} bytes)`);
}

const trayPng = buildPng(22, trayPainter);
const trayOut = join(OUT_DIR, "tray-icon.png");
writeFileSync(trayOut, trayPng);
console.log(`wrote ${trayOut} (${trayPng.length} bytes)`);

// Also a 2x retina variant — macOS handles @2x suffixes specially in
// some contexts. Tauri 2's tray API picks the resolution based on
// device pixel ratio when both are present.
const trayPng2x = buildPng(44, trayPainter);
const trayOut2x = join(OUT_DIR, "tray-icon@2x.png");
writeFileSync(trayOut2x, trayPng2x);
console.log(`wrote ${trayOut2x} (${trayPng2x.length} bytes)`);
