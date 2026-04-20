// Browse and pull measurements from the squig.link ecosystem (100+ CrinGraph
// deployments). Two-step flow: squigsites.json → per-reviewer phone_book.json
// → FR text file. All hosts in the directory serve with permissive CORS.

const SITES_URL = "https://squig.link/squigsites.json";

export interface SquigSite {
	username: string;
	name: string;
	urlType?: "subdomain" | "root" | "altDomain" | string;
	altDomain?: string;
	dbs: Array<{ type: string; folder?: string }>;
}

export interface SquigPhoneEntry {
	brand: string;
	name: string;
	files: string[]; // one or more FR-file basenames
	suffixes?: string[];
	price?: string;
	reviewScore?: string;
	reviewLink?: string;
}

export interface ResolvedDb {
	siteLabel: string; // "Reviewer — DB-type" for display
	baseUrl: string; // ends with `/`
}

// Resolve a site+db to a fully-qualified base URL. See documentation.squig.link.
export function resolveDbUrls(site: SquigSite): ResolvedDb[] {
	const out: ResolvedDb[] = [];
	for (const db of site.dbs ?? []) {
		const folder = db.folder ?? "";
		let base: string;
		switch (site.urlType) {
			case "subdomain":
				base = `https://${site.username}.squig.link${folder}`;
				break;
			case "root":
				base = `https://squig.link${folder}`;
				break;
			case "altDomain":
				base = `${site.altDomain ?? ""}${folder}`;
				break;
			default:
				base = `https://squig.link/lab/${site.username}${folder}`;
				break;
		}
		if (!base.endsWith("/")) base += "/";
		out.push({
			siteLabel: `${site.name} — ${db.type}`,
			baseUrl: base,
		});
	}
	return out;
}

export async function fetchSites(): Promise<SquigSite[]> {
	const resp = await fetch(SITES_URL);
	if (!resp.ok) throw new Error(`squigsites.json: HTTP ${resp.status}`);
	return (await resp.json()) as SquigSite[];
}

// Parse a CrinGraph phone_book.json into a flat list of entries.
// Input is an array of brand-grouped records; `file` can be a string
// or an array of strings (variants with optional suffix labels).
export function flattenPhoneBook(
	phoneBook: unknown,
): SquigPhoneEntry[] {
	if (!Array.isArray(phoneBook)) return [];
	const out: SquigPhoneEntry[] = [];
	for (const brand of phoneBook) {
		const brandName =
			brand && typeof brand === "object" && "name" in brand
				? String((brand as { name: unknown }).name)
				: "";
		const phones =
			brand && typeof brand === "object" && "phones" in brand
				? (brand as { phones: unknown }).phones
				: null;
		if (!Array.isArray(phones)) continue;
		for (const phone of phones) {
			if (!phone || typeof phone !== "object") continue;
			const p = phone as Record<string, unknown>;
			const fileRaw = p.file;
			const files = Array.isArray(fileRaw)
				? fileRaw.map(String)
				: typeof fileRaw === "string"
					? [fileRaw]
					: [];
			if (files.length === 0) continue;
			out.push({
				brand: brandName,
				name: String(p.name ?? files[0]),
				files,
				suffixes: Array.isArray(p.suffix)
					? (p.suffix as unknown[]).map(String)
					: undefined,
				price: p.price ? String(p.price) : undefined,
				reviewScore: p.reviewScore ? String(p.reviewScore) : undefined,
				reviewLink: p.reviewLink ? String(p.reviewLink) : undefined,
			});
		}
	}
	return out;
}

export async function fetchPhoneBook(
	baseUrl: string,
): Promise<SquigPhoneEntry[]> {
	const url = `${baseUrl}data/phone_book.json`;
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`phone_book.json: HTTP ${resp.status}`);
	const json = await resp.json();
	return flattenPhoneBook(json);
}

// Fetch a single FR channel (".L.txt" / ".R.txt") and return raw text.
// Left channel is tried first; if missing, the base filename alone is
// attempted (some sites store mono files).
export async function fetchPhoneFR(
	baseUrl: string,
	fileBasename: string,
): Promise<string> {
	const candidates = [
		`${baseUrl}data/${encodeURI(fileBasename)} L.txt`,
		`${baseUrl}data/${encodeURI(fileBasename)}.txt`,
		`${baseUrl}data/${encodeURI(fileBasename)}`,
	];
	let lastErr: Error | null = null;
	for (const url of candidates) {
		try {
			const resp = await fetch(url);
			if (resp.ok) return await resp.text();
			lastErr = new Error(`${url}: HTTP ${resp.status}`);
		} catch (err) {
			lastErr = err as Error;
		}
	}
	throw lastErr ?? new Error("No FR file found");
}
