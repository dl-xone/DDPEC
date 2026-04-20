// Tier 3 #5 — "Reduce to N bands" command.
//
// Drops the least-impactful bands from a slot until `length == n`. Impact
// is `|gain * Q|` for gainful types (Peaking / shelves) and `|Q|` for
// gainless types (HP / LP / NO / BP) where `gain` is ignored by the DSP.
//
// Pure function so the command palette + inline-edit surfaces can call it
// and the behaviour is trivially unit-testable.
//
// Tie-break: when two bands score equal impact we prefer to keep the one
// with the lower array index so drops are stable across calls.

import type { Band } from "./main.ts";

// Keep the typeHasGain check aligned with dsp/biquad.ts. Duplicating the
// tiny set here avoids a circular import and is cheap to maintain — new
// gainful types are a rare event.
const GAINFUL_TYPES = new Set(["PK", "LSQ", "HSQ"]);

function bandImpact(band: Band): number {
	// Disabled bands contribute nothing; surface them as the first drop
	// candidates by giving them a -1 score (lower than any enabled band's
	// positive magnitude).
	if (!band.enabled) return -1;
	if (GAINFUL_TYPES.has(band.type)) {
		return Math.abs(band.gain * band.q);
	}
	return Math.abs(band.q);
}

export interface ReduceResult {
	reduced: Band[];
	dropped: Band[];
}

/**
 * Remove the `|bands| - n` lowest-impact bands. If `n >= bands.length`
 * the input is returned unchanged with an empty `dropped` list. `n < 1`
 * is clamped to 1 so callers don't end up with an empty slot by typo.
 *
 * The returned array preserves the original order of the surviving
 * bands (no re-sort) so downstream render / sync code doesn't see
 * spurious shuffles.
 */
export function reduceToNBands(bands: Band[], n: number): ReduceResult {
	if (!Array.isArray(bands) || bands.length === 0) {
		return { reduced: [], dropped: [] };
	}
	const target = Math.max(1, Math.min(bands.length, Math.floor(n)));
	if (target >= bands.length) {
		return { reduced: bands.slice(), dropped: [] };
	}
	// Score every band, keep the top-`target` by impact.
	const scored = bands.map((band, originalIndex) => ({
		band,
		originalIndex,
		impact: bandImpact(band),
	}));
	// Sort descending by impact; tie-break on lower original index so
	// stable drops across repeated calls.
	scored.sort(
		(a, b) => b.impact - a.impact || a.originalIndex - b.originalIndex,
	);
	const keptSet = new Set(
		scored.slice(0, target).map((s) => s.originalIndex),
	);
	const reduced: Band[] = [];
	const dropped: Band[] = [];
	for (let i = 0; i < bands.length; i++) {
		if (keptSet.has(i)) reduced.push(bands[i]);
		else dropped.push(bands[i]);
	}
	return { reduced, dropped };
}
