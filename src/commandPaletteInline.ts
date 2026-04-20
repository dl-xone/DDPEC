// Feature H — command-palette inline editing.
//
// When the user types `gain 3 -5`, `freq 2 1200`, `q 4 1.2`,
// `type 5 PK`, or `preamp -4`, we interpret it as an edit command and
// prepend a dynamic Command to the palette's result list.
//
// This file owns only the pure parser. The DOM wiring (prepending the
// synthetic command + styling) lives in commandPalette.ts so the
// registry / render pipeline stays in one place.
//
// Band indexing: the parsed `band` number is 1-indexed and targets
// `band.index === band - 1` — the hardware slot / stable id, NOT the
// array position. This matters because array position shuffles with
// sort/add/remove while the hardware slot is the stable identity users
// actually see in the tabular editor's first column. Document
// assumption: the displayed band number IS `band.index + 1` in the
// current UI.

export type InlineEditKind = "gain" | "freq" | "q" | "type" | "preamp";

export interface InlineEdit {
	kind: InlineEditKind;
	// bandIdx is 1-indexed; ignored for `preamp`.
	bandIdx: number;
	// Numeric value for gain/freq/q/preamp; string for type.
	value: number | string;
}

const VALID_TYPES = new Set([
	"PK",
	"LSQ",
	"HSQ",
	"HPQ",
	"LPQ",
	"NO",
	"BPQ",
]);

// Bounds — match the existing band editor's sliders.
const LIMITS = {
	gain: { min: -24, max: 24 },
	freq: { min: 10, max: 24000 },
	q: { min: 0.1, max: 12 },
	preamp: { min: -20, max: 10 },
};

function parseNumber(raw: string): number | null {
	if (!raw) return null;
	// Reject stray characters — a bare number only.
	if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

/**
 * Parse a query like `gain 3 -5` into a structured edit. Returns null if
 * the query isn't a recognized inline edit — the palette then falls back
 * to its normal fuzzy search.
 *
 * Matching is tolerant of case and extra whitespace. Invalid band indices
 * (non-positive or non-integer) return null. Out-of-bounds values return
 * null too — the fuzzy-search fallback is more useful than a no-op
 * command.
 */
export function parseInlineEdit(query: string): InlineEdit | null {
	if (!query) return null;
	const trimmed = query.trim();
	if (!trimmed) return null;

	// Collapse whitespace for simple tokenization.
	const tokens = trimmed.split(/\s+/);
	const head = tokens[0].toLowerCase();

	if (head === "preamp") {
		if (tokens.length !== 2) return null;
		const v = parseNumber(tokens[1]);
		if (v === null) return null;
		if (v < LIMITS.preamp.min || v > LIMITS.preamp.max) return null;
		return { kind: "preamp", bandIdx: 0, value: v };
	}

	if (head === "gain" || head === "freq" || head === "q") {
		if (tokens.length !== 3) return null;
		const bandIdx = parseNumber(tokens[1]);
		if (bandIdx === null || !Number.isInteger(bandIdx) || bandIdx < 1) {
			return null;
		}
		const value = parseNumber(tokens[2]);
		if (value === null) return null;
		const bounds = LIMITS[head];
		if (value < bounds.min || value > bounds.max) return null;
		return { kind: head, bandIdx, value };
	}

	if (head === "type") {
		if (tokens.length !== 3) return null;
		const bandIdx = parseNumber(tokens[1]);
		if (bandIdx === null || !Number.isInteger(bandIdx) || bandIdx < 1) {
			return null;
		}
		const type = tokens[2].toUpperCase();
		if (!VALID_TYPES.has(type)) return null;
		return { kind: "type", bandIdx, value: type };
	}

	return null;
}

/**
 * Human-readable description used as the synthetic command's title.
 * "Set band 3 gain to -5 dB", etc.
 */
export function describeInlineEdit(edit: InlineEdit): string {
	switch (edit.kind) {
		case "gain":
			return `Set band ${edit.bandIdx} gain to ${edit.value} dB`;
		case "freq":
			return `Set band ${edit.bandIdx} freq to ${edit.value} Hz`;
		case "q":
			return `Set band ${edit.bandIdx} Q to ${edit.value}`;
		case "type":
			return `Set band ${edit.bandIdx} type to ${edit.value}`;
		case "preamp":
			return `Set pre-amp to ${edit.value} dB`;
	}
}
