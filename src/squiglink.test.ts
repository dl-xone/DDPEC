import { describe, expect, it } from "vitest";
import { flattenPhoneBook, resolveDbUrls } from "./squiglink.ts";

describe("resolveDbUrls", () => {
	it("resolves subdomain sites", () => {
		const urls = resolveDbUrls({
			username: "precog",
			name: "Precogvision",
			urlType: "subdomain",
			dbs: [{ type: "IEMs", folder: "/" }],
		});
		expect(urls[0].baseUrl).toBe("https://precog.squig.link/");
	});

	it("resolves root sites (Super* Review)", () => {
		const urls = resolveDbUrls({
			username: "super",
			name: "Super* Review",
			urlType: "root",
			dbs: [{ type: "IEMs", folder: "/" }],
		});
		expect(urls[0].baseUrl).toBe("https://squig.link/");
	});

	it("resolves altDomain sites (Crinacle / Hangout.Audio)", () => {
		const urls = resolveDbUrls({
			username: "crinacle",
			name: "Crinacle",
			urlType: "altDomain",
			altDomain: "https://graph.hangout.audio",
			dbs: [{ type: "IEMs 711", folder: "/iem/711/" }],
		});
		expect(urls[0].baseUrl).toBe("https://graph.hangout.audio/iem/711/");
	});

	it("resolves default (path-based) sites", () => {
		const urls = resolveDbUrls({
			username: "someuser",
			name: "Some User",
			dbs: [{ type: "IEMs", folder: "/" }],
		});
		expect(urls[0].baseUrl).toBe("https://squig.link/lab/someuser/");
	});

	it("produces one ResolvedDb per db entry", () => {
		const urls = resolveDbUrls({
			username: "foo",
			name: "Foo",
			urlType: "subdomain",
			dbs: [
				{ type: "IEMs", folder: "/" },
				{ type: "Headphones", folder: "/hp/" },
			],
		});
		expect(urls).toHaveLength(2);
		expect(urls[1].baseUrl).toBe("https://foo.squig.link/hp/");
	});

	it("siteLabel combines reviewer name and db type", () => {
		const urls = resolveDbUrls({
			username: "x",
			name: "X",
			urlType: "subdomain",
			dbs: [{ type: "IEMs", folder: "/" }],
		});
		expect(urls[0].siteLabel).toBe("X — IEMs");
	});
});

describe("flattenPhoneBook", () => {
	it("flattens brand-grouped entries into a single list", () => {
		const book = [
			{
				name: "Ziigaat",
				phones: [
					{ name: "Arcanis", file: "Ziigaat Arcanis" },
					{ name: "Crescent", file: "Ziigaat Crescent" },
				],
			},
			{
				name: "Moondrop",
				phones: [{ name: "Blessing 2", file: "Moondrop Blessing 2" }],
			},
		];
		const flat = flattenPhoneBook(book);
		expect(flat).toHaveLength(3);
		expect(flat[0]).toMatchObject({
			brand: "Ziigaat",
			name: "Arcanis",
			files: ["Ziigaat Arcanis"],
		});
		expect(flat[2].brand).toBe("Moondrop");
	});

	it("handles array-valued file entries with variants", () => {
		const book = [
			{
				name: "Ziigaat",
				phones: [
					{
						name: "Crescent",
						file: ["Ziigaat Crescent", "Ziigaat Crescent shallow"],
						suffix: ["", "(shallow)"],
					},
				],
			},
		];
		const flat = flattenPhoneBook(book);
		expect(flat[0].files).toHaveLength(2);
		expect(flat[0].suffixes).toEqual(["", "(shallow)"]);
	});

	it("skips malformed entries", () => {
		const book = [
			{ name: "Brand", phones: [{ name: "missing file" }] },
			"not an object",
			null,
		];
		expect(flattenPhoneBook(book)).toHaveLength(0);
	});

	it("returns [] for non-array input", () => {
		expect(flattenPhoneBook(null)).toEqual([]);
		expect(flattenPhoneBook({})).toEqual([]);
	});
});
