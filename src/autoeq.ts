// AutoEQ integration. Uses GitHub's recursive git-tree API to enumerate
// every result file (measurements + precomputed EQs) in the public repo
// https://github.com/jaakkopasanen/AutoEQ, then fetches the chosen files
// via raw.githubusercontent.com.
//
// Both api.github.com and raw.githubusercontent.com serve with
// `Access-Control-Allow-Origin: *`, so the whole flow runs entirely in
// the browser with no proxy.

const REPO = "jaakkopasanen/AutoEQ";
const BRANCH = "master";
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

interface TreeEntry {
	path: string;
	type: "blob" | "tree" | string;
	size?: number;
}

interface TreeResponse {
	tree: TreeEntry[];
	truncated: boolean;
}

export interface AutoEqEntry {
	// Human-readable combination of reviewer + target + headphone.
	label: string;
	// e.g. "oratory1990"
	reviewer: string;
	// e.g. "harman_over-ear_2018"
	target: string;
	// e.g. "Sennheiser HD 800"
	headphone: string;
	// Path into results/{reviewer}/{target}/{headphone}/
	dir: string;
	// Raw measurement CSV path if present.
	csvPath?: string;
	// Precomputed ParametricEQ.txt path if present.
	parametricEqPath?: string;
}

// Fetch + cache the repo tree. One call per session.
let cachedTree: TreeEntry[] | null = null;
let cachedEntries: AutoEqEntry[] | null = null;

export async function fetchAutoEqIndex(): Promise<AutoEqEntry[]> {
	if (cachedEntries) return cachedEntries;
	if (!cachedTree) {
		const resp = await fetch(TREE_URL);
		if (!resp.ok) {
			if (resp.status === 403) {
				throw new Error(
					"GitHub rate-limited this IP (unauthenticated 60/h). Try again later.",
				);
			}
			throw new Error(`GitHub tree: HTTP ${resp.status}`);
		}
		const data = (await resp.json()) as TreeResponse;
		if (data.truncated) {
			// The results tree fits under GitHub's 100k-entry cap today,
			// but surface a warning if that ever changes.
			console.warn("AutoEQ tree response was truncated by GitHub.");
		}
		cachedTree = data.tree;
	}

	// Index every file under results/ by its containing directory.
	interface DirBucket {
		reviewer: string;
		target: string;
		headphone: string;
		dir: string;
		csvPath?: string;
		parametricEqPath?: string;
	}
	const buckets = new Map<string, DirBucket>();

	for (const entry of cachedTree) {
		if (entry.type !== "blob") continue;
		if (!entry.path.startsWith("results/")) continue;

		const parts = entry.path.split("/");
		// results/{reviewer}/{target}/{headphone}/{filename}
		if (parts.length < 5) continue;
		const [, reviewer, target, headphone, filename] = parts;
		const dir = `results/${reviewer}/${target}/${headphone}/`;
		if (filename.includes("/")) continue; // deeper nesting — ignore

		let bucket = buckets.get(dir);
		if (!bucket) {
			bucket = { reviewer, target, headphone, dir };
			buckets.set(dir, bucket);
		}

		const lower = filename.toLowerCase();
		if (lower.endsWith("parametriceq.txt")) {
			bucket.parametricEqPath = entry.path;
		} else if (
			lower.endsWith(".csv") &&
			!lower.includes("fixedbandeq") &&
			!lower.includes("graphiceq")
		) {
			// Prefer the top-level measurement CSV (matches headphone name).
			// Fall back to any other .csv only if no better match exists.
			if (!bucket.csvPath || lower === `${headphone.toLowerCase()}.csv`) {
				bucket.csvPath = entry.path;
			}
		}
	}

	const entries: AutoEqEntry[] = [];
	for (const b of buckets.values()) {
		if (!b.csvPath && !b.parametricEqPath) continue;
		entries.push({
			label: `${b.headphone} — ${b.reviewer} / ${b.target}`,
			reviewer: b.reviewer,
			target: b.target,
			headphone: b.headphone,
			dir: b.dir,
			csvPath: b.csvPath,
			parametricEqPath: b.parametricEqPath,
		});
	}
	entries.sort((a, b) => a.label.localeCompare(b.label));
	cachedEntries = entries;
	return entries;
}

export async function fetchAutoEqFile(relPath: string): Promise<string> {
	// relPath already starts with "results/..."; encodeURI preserves '/'.
	const url = RAW_BASE + encodeURI(relPath);
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
	return resp.text();
}
