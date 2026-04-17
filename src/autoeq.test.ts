import { describe, expect, it } from "vitest";

// Exercise the tree-parsing logic in isolation. We don't hit GitHub in
// tests — too slow + rate-limited — so we construct a mini fake tree
// and verify the indexer produces the expected bucket entries.

// The tree-parsing logic lives inside fetchAutoEqIndex; extract it into
// a test-only helper so we can verify without network calls.

interface FakeTreeEntry {
	path: string;
	type: "blob" | "tree";
}

function indexTree(tree: FakeTreeEntry[]) {
	interface Bucket {
		reviewer: string;
		target: string;
		headphone: string;
		dir: string;
		csvPath?: string;
		parametricEqPath?: string;
	}
	const buckets = new Map<string, Bucket>();

	for (const entry of tree) {
		if (entry.type !== "blob") continue;
		if (!entry.path.startsWith("results/")) continue;
		const parts = entry.path.split("/");
		if (parts.length < 5) continue;
		const [, reviewer, target, headphone, filename] = parts;
		const dir = `results/${reviewer}/${target}/${headphone}/`;
		if (filename.includes("/")) continue;

		let b = buckets.get(dir);
		if (!b) {
			b = { reviewer, target, headphone, dir };
			buckets.set(dir, b);
		}

		const lower = filename.toLowerCase();
		if (lower.endsWith("parametriceq.txt")) {
			b.parametricEqPath = entry.path;
		} else if (
			lower.endsWith(".csv") &&
			!lower.includes("fixedbandeq") &&
			!lower.includes("graphiceq")
		) {
			if (!b.csvPath || lower === `${headphone.toLowerCase()}.csv`) {
				b.csvPath = entry.path;
			}
		}
	}

	return Array.from(buckets.values());
}

describe("AutoEQ tree indexing", () => {
	it("pairs ParametricEQ and measurement CSV under the same headphone dir", () => {
		const tree: FakeTreeEntry[] = [
			{
				path: "results/oratory1990/harman_over-ear_2018/Sennheiser HD 800/Sennheiser HD 800.csv",
				type: "blob",
			},
			{
				path: "results/oratory1990/harman_over-ear_2018/Sennheiser HD 800/Sennheiser HD 800 ParametricEQ.txt",
				type: "blob",
			},
			{
				path: "results/oratory1990/harman_over-ear_2018/Sennheiser HD 800/Sennheiser HD 800 FixedBandEQ.csv",
				type: "blob",
			},
		];
		const entries = indexTree(tree);
		expect(entries).toHaveLength(1);
		expect(entries[0].headphone).toBe("Sennheiser HD 800");
		expect(entries[0].csvPath?.endsWith("Sennheiser HD 800.csv")).toBe(true);
		expect(entries[0].parametricEqPath?.endsWith("ParametricEQ.txt")).toBe(
			true,
		);
	});

	it("skips FixedBandEQ and GraphicEQ CSVs in favor of the measurement", () => {
		const tree: FakeTreeEntry[] = [
			{
				path: "results/crinacle/harman_in-ear_2019v2/Blessing 2/Blessing 2 FixedBandEQ.csv",
				type: "blob",
			},
			{
				path: "results/crinacle/harman_in-ear_2019v2/Blessing 2/Blessing 2.csv",
				type: "blob",
			},
		];
		const entries = indexTree(tree);
		expect(entries).toHaveLength(1);
		expect(entries[0].csvPath?.endsWith("Blessing 2.csv")).toBe(true);
	});

	it("buckets by (reviewer, target, headphone)", () => {
		const tree: FakeTreeEntry[] = [
			{
				path: "results/oratory1990/harman_over-ear_2018/HD 600/HD 600.csv",
				type: "blob",
			},
			{
				path: "results/oratory1990/harman_over-ear_2018/HD 650/HD 650.csv",
				type: "blob",
			},
			{
				path: "results/crinacle/harman_in-ear_2019v2/HD 600/HD 600.csv",
				type: "blob",
			},
		];
		const entries = indexTree(tree);
		expect(entries).toHaveLength(3);
	});

	it("ignores files above the results/ root", () => {
		const tree: FakeTreeEntry[] = [
			{ path: "README.md", type: "blob" },
			{ path: "results/x", type: "blob" }, // too shallow
		];
		expect(indexTree(tree)).toHaveLength(0);
	});

	it("ignores tree entries (directories)", () => {
		const tree: FakeTreeEntry[] = [
			{
				path: "results/oratory1990/harman_over-ear_2018/HD 800",
				type: "tree",
			},
		];
		expect(indexTree(tree)).toHaveLength(0);
	});
});
