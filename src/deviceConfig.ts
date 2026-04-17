export type Protocol = "WALKPLAY" | "MOONDROP" | "FIIO";

export interface EQSlot {
	id: number;
	name: string;
}

export interface DeviceConfig {
	key: string;
	label: string;
	protocol: Protocol;
	vendorIds: number[];
	productIds?: number[];
	maxFilters: number;
	minGain: number;
	maxGain: number;
	supportsLSHS: boolean;
	autoGlobalGain: boolean;
	// Whether connectToDevice can pull the current EQ state from the device.
	// When false the UI shows defaults until the user syncs.
	supportsReadback: boolean;
	slots: EQSlot[];
	defaultFreqs: number[];
}

const WALKPLAY_VIDS = [
	0x3302, 0x0762, 0x35d8, 0x2fc6, 0x0104, 0xb445, 0x0661, 0x0666, 0x0d8c,
];

const SCHEME16_PIDS = [
	0x4380, 0x43b6, 0x43e1, 0x43d7, 0x43d8, 0x43e4, 0x98d4, 0x43c0, 0x43e8,
	0xf808, 0xee10, 0x4352, 0xee20, 0x43c5, 0x43e6, 0x4351, 0x43de, 0x4358,
	0x4359, 0x43db, 0x435a, 0x4355, 0x435c, 0x435d, 0x435e, 0x43ef, 0x43ec,
	0x4361, 0x4363, 0x4366, 0x4364, 0x4360, 0x4382, 0x4383, 0x4386, 0x43c6,
	0x43c7, 0x011d, 0x43c8, 0x43da, 0x43c9, 0x43ca, 0x43cc, 0x43cd, 0x43cf,
	0x43b1, 0x43c2, 0x43b7, 0x43b8, 0x39c3,
];

const DEFAULT_FREQS_8 = [40, 100, 250, 500, 1000, 3000, 8000, 16000];
const DEFAULT_FREQS_10 = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const FIIO_SLOTS: EQSlot[] = [
	{ id: 0, name: "Jazz" },
	{ id: 1, name: "Pop" },
	{ id: 2, name: "Rock" },
	{ id: 3, name: "Dance" },
	{ id: 4, name: "R&B" },
	{ id: 5, name: "Classic" },
	{ id: 6, name: "Hip-hop" },
	{ id: 160, name: "USER1" },
];

export const DEVICE_CONFIGS: DeviceConfig[] = [
	{
		key: "moondrop.default",
		label: "Moondrop / Tanchjim",
		protocol: "MOONDROP",
		vendorIds: [0x2fc6],
		maxFilters: 8,
		minGain: -12,
		maxGain: 12,
		supportsLSHS: true,
		autoGlobalGain: false,
		supportsReadback: false,
		slots: [{ id: 0, name: "Custom" }],
		defaultFreqs: DEFAULT_FREQS_8,
	},
	{
		key: "fiio.default",
		label: "FiiO",
		protocol: "FIIO",
		vendorIds: [0x2972],
		maxFilters: 8,
		minGain: -12,
		maxGain: 12,
		supportsLSHS: true,
		autoGlobalGain: false,
		supportsReadback: false,
		slots: FIIO_SLOTS,
		defaultFreqs: DEFAULT_FREQS_8,
	},
	{
		key: "walkplay.scheme16",
		label: "Walkplay 10-band (Scheme 16)",
		protocol: "WALKPLAY",
		vendorIds: WALKPLAY_VIDS,
		productIds: SCHEME16_PIDS,
		maxFilters: 10,
		minGain: -10,
		maxGain: 10,
		supportsLSHS: true,
		autoGlobalGain: false,
		supportsReadback: true,
		slots: [{ id: 101, name: "Custom" }],
		defaultFreqs: DEFAULT_FREQS_10,
	},
	{
		key: "walkplay.protocolmax",
		label: "CrinEar Protocol Max",
		protocol: "WALKPLAY",
		vendorIds: WALKPLAY_VIDS,
		productIds: SCHEME16_PIDS,
		maxFilters: 10,
		minGain: -10,
		maxGain: 10,
		supportsLSHS: true,
		autoGlobalGain: true,
		supportsReadback: true,
		slots: [{ id: 101, name: "Custom" }],
		defaultFreqs: DEFAULT_FREQS_10,
	},
	{
		key: "savitech.official",
		label: "Savitech (Fosi / iBasso)",
		protocol: "WALKPLAY",
		vendorIds: [0x262a],
		maxFilters: 8,
		minGain: -20,
		maxGain: 10,
		supportsLSHS: true,
		autoGlobalGain: false,
		supportsReadback: true,
		slots: [{ id: 101, name: "Custom" }],
		defaultFreqs: DEFAULT_FREQS_8,
	},
	{
		key: "walkplay.default",
		label: "Walkplay 8-band",
		protocol: "WALKPLAY",
		vendorIds: WALKPLAY_VIDS,
		maxFilters: 8,
		minGain: -12,
		maxGain: 6,
		supportsLSHS: false,
		autoGlobalGain: false,
		supportsReadback: true,
		slots: [{ id: 101, name: "Custom" }],
		defaultFreqs: DEFAULT_FREQS_8,
	},
];

export function pickDeviceConfig(device: HIDDevice): DeviceConfig {
	const byVid = DEVICE_CONFIGS.filter((c) =>
		c.vendorIds.includes(device.vendorId),
	);
	const byPid = byVid.filter((c) => c.productIds?.includes(device.productId));
	if (byPid.length > 0) {
		const protocolMax = byPid.find((c) => c.key === "walkplay.protocolmax");
		if (
			protocolMax &&
			device.productName?.toLowerCase().includes("protocol max")
		) {
			return protocolMax;
		}
		return byPid[0];
	}
	const noFilter = byVid.filter((c) => !c.productIds);
	if (noFilter.length > 0) return noFilter[0];
	if (byVid.length > 0) return byVid[0];
	return DEVICE_CONFIGS[DEVICE_CONFIGS.length - 1];
}

export function allVendorFilters(): HIDDeviceFilter[] {
	const seen = new Set<number>();
	const filters: HIDDeviceFilter[] = [];
	for (const cfg of DEVICE_CONFIGS) {
		for (const vid of cfg.vendorIds) {
			if (!seen.has(vid)) {
				seen.add(vid);
				filters.push({ vendorId: vid });
			}
		}
	}
	return filters;
}
