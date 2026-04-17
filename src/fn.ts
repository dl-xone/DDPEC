import { DEFAULT_FREQS } from "./constants.ts";
import { allVendorFilters, pickDeviceConfig } from "./deviceConfig.ts";
import {
	flashToFlash,
	readDeviceParams,
	setupListener,
	syncToDevice,
} from "./dsp.ts";
import {
	enableControls,
	log,
	setAppOffline,
	toast,
	updateGlobalGainUI,
} from "./helpers.ts";
import {
	canRedo,
	canUndo,
	clearHistory,
	loadPersistedProfile,
	persistProfile,
	redo,
	snapshot,
	undo,
} from "./history.ts";
import {
	getMeasurement,
	getMeasurementOffset,
	getTarget,
	normalizeAt,
	parseMeasurement,
	setMeasurement,
	setMeasurementOffset,
	setTarget,
} from "./measurements.ts";
import { TARGETS } from "./targets.ts";
import {
	confirmModal,
	customModal,
	errorModal,
	pickerModal,
	progressModal,
	searchPickerModal,
} from "./modal.ts";
import { applyPreset, PRESETS } from "./presets.ts";
import {
	getPlayingType,
	playPinkNoise,
	playSineSweep,
	playWhiteNoise,
	stopSignal,
} from "./signals.ts";
import {
	type AutoEqEntry,
	fetchAutoEqFile,
	fetchAutoEqIndex,
} from "./autoeq.ts";
import { applyProfileText } from "./importExport.ts";
import {
	fetchPhoneBook,
	fetchPhoneFR,
	fetchSites,
	resolveDbUrls,
	type SquigPhoneEntry,
} from "./squiglink.ts";
import type { Band, EQ } from "./main.ts";
import { renderPEQ, resizeCanvas } from "./peq.ts";
import {
	defaultEqState,
	getActiveConfig,
	getActiveSlot,
	getDevice,
	getEqState,
	getGlobalGainState,
	getInactiveEq,
	hasAnyDirty,
	isDirty,
	isEqEnabled,
	markSynced,
	resetSlots,
	setActiveConfig,
	setActiveSlot,
	setBandField,
	setCurrentSlotId,
	setDevice,
	setEqEnabled,
	setEqState,
	setGlobalGainState,
	setOutputMode,
	type SlotName,
	swapSlots,
} from "./state.ts";

// Re-export state helpers so existing importers (importExport.ts, dsp.ts)
// can keep using fn.ts until they migrate directly to state.ts.
export {
	defaultEqState,
	getActiveConfig,
	getCurrentSlotId,
	getDevice,
	getEqState,
	getGlobalGainState,
	setEqState,
	setGlobalGainState,
} from "./state.ts";

export function initState() {
	renderUI(getEqState());
	resizeCanvas();
	renderPresetSidebar();

	// Initial paint: we start disconnected, so apply the offline visual.
	applyConnectionUI(null);

	// Wire A/B slot toggle now that the buttons live in index.html top bar.
	document
		.getElementById("btnSlotA")
		?.addEventListener("click", () => activateSlot("A"));
	document
		.getElementById("btnSlotB")
		?.addEventListener("click", () => activateSlot("B"));
	document
		.getElementById("btnSlotSwap")
		?.addEventListener("click", () => swapABSlots());

	// Preset sidebar search filter.
	const search = document.getElementById("presetSearch") as HTMLInputElement | null;
	search?.addEventListener("input", () => renderPresetSidebar(search.value));

	// Sidebar action buttons for external catalogs.
	document
		.getElementById("btnBrowseAutoEq")
		?.addEventListener("click", () => browseAutoEq());
	document
		.getElementById("btnBrowseSquig")
		?.addEventListener("click", () =>
			browseSquigLink((text, name) => {
				try {
					const parsed = parseMeasurement(text, name);
					setMeasurement(normalizeAt(parsed, 1000));
					renderUI(getEqState());
					log(`Loaded FR: ${name} (${parsed.points.length} points).`);
				} catch (err) {
					log(`FR parse error: ${(err as Error).message}`);
				}
			}).catch((err: Error) => log(`squig.link error: ${err.message}`)),
		);

	// Keyboard help modal trigger — the visible #btnHelp was removed in the
	// JDS pivot, so this optional wire is a no-op in the new shell. The `?`
	// key handler in main.ts is the live surface.
	document
		.getElementById("btnHelp")
		?.addEventListener("click", () => openKeyboardHelp());

	// Target curve picker.
	document
		.getElementById("btnTarget")
		?.addEventListener("click", () => openTargetLoader());

	// Preset sidebar toggle — visible only on narrow viewports.
	document
		.getElementById("btnTogglePresets")
		?.addEventListener("click", () => {
			const aside = document.getElementById("presetSidebar");
			if (!aside) return;
			aside.classList.toggle("hidden");
			aside.classList.toggle("flex");
		});

	// Handle devices that disappear (unplugged, revoked, etc.) without
	// waiting for the next sendReport to fail.
	navigator.hid?.addEventListener("disconnect", (event) => {
		const active = getDevice();
		if (active && event.device === active) handleDeviceLost();
	});

	// Wave 4.10 — tab-close guard. The in-app slot-switch and disconnect
	// guards cover intentional actions; this catches accidental closes.
	// Chrome requires user interaction on the page before the prompt shows.
	window.addEventListener("beforeunload", (e) => {
		if (hasAnyDirty()) {
			e.preventDefault();
			// Some browsers still require returnValue for the prompt to appear.
			e.returnValue = "";
		}
	});

	// Re-draw canvas when the theme flips — grid / legend / curve colors
	// are resolved from CSS vars at draw time, so a redraw is required.
	document.addEventListener("ddpec:theme-change", () => {
		renderUI(getEqState());
	});

	// JDS pivot wiring — all optional: missing IDs fail silently so the
	// contract can roll out piecewise with the index.html agent.
	wirePresetActionBar();
	wireHistoryButtons();
	wireModeControl();
	wireEqDisable();
	wireBottomPanelTabs();
	wireLogTray();
	wireNavTabs();
	wireCommitBar();
}

// Target-curve picker. Distinct from the measurement loader so the two
// FR layers (what the transducer does vs what you're tuning toward) stay
// conceptually separate. Built-in curves cover the common cases; URL /
// CSV paths can be added later if demand surfaces.
export async function openTargetLoader() {
	const content = document.createElement("div");
	content.className = "flex flex-col gap-3 text-sm";

	const hint = document.createElement("p");
	hint.className = "text-xs text-text-2";
	hint.textContent =
		"A target is the FR you want the measurement + EQ to match. Shown as a dashed cyan line on the graph.";
	content.appendChild(hint);

	const current = getTarget();
	const status = document.createElement("div");
	status.className = "text-xs text-text-3";
	status.textContent = current
		? `Active target: ${current.name}`
		: "No target loaded.";
	content.appendChild(status);

	const list = document.createElement("div");
	list.className = "flex flex-col gap-1";

	for (const preset of TARGETS) {
		const row = document.createElement("button");
		row.type = "button";
		row.className = "preset-row text-left";
		const col = document.createElement("div");
		col.className = "flex flex-col";
		const name = document.createElement("div");
		name.className = "text-sm font-semibold";
		name.textContent = preset.name;
		const desc = document.createElement("div");
		desc.className = "text-[11px] text-text-3 mt-0.5";
		desc.textContent = preset.description;
		col.append(name, desc);
		row.appendChild(col);
		row.addEventListener("click", () => {
			setTarget(preset.measurement);
			renderUI(getEqState());
			log(`Target loaded: ${preset.name}.`);
			dialog.close();
			dialog.remove();
		});
		list.appendChild(row);
	}
	content.appendChild(list);

	const clearBtn = document.createElement("button");
	clearBtn.type = "button";
	clearBtn.className = "btn-danger text-xs self-start mt-2";
	clearBtn.textContent = "Clear target";
	clearBtn.addEventListener("click", () => {
		setTarget(null);
		renderUI(getEqState());
		log("Target cleared.");
		dialog.close();
		dialog.remove();
	});
	content.appendChild(clearBtn);

	const dialog = customModal("Load target curve", content);
}

// Wave 4.7 — keyboard shortcut cheatsheet. Inline in fn.ts rather than a
// dedicated file (eng review decision: folder-fewer wins).
export function openKeyboardHelp() {
	const content = document.createElement("div");
	content.className = "flex flex-col gap-2 text-sm";
	const rows: Array<[string, string]> = [
		["?", "Open this help"],
		["Cmd/Ctrl + Z", "Undo"],
		["Shift+Cmd/Ctrl + Z", "Redo"],
		["Cmd/Ctrl + Y", "Redo (alt)"],
		["Alt + S", "Swap A ↔ B slots"],
		["Esc", "Close current modal"],
	];
	for (const [key, label] of rows) {
		const row = document.createElement("div");
		row.className =
			"flex items-center justify-between border-b border-border py-1";
		const kbd = document.createElement("kbd");
		kbd.className = "font-mono text-accent text-xs";
		kbd.textContent = key;
		const desc = document.createElement("span");
		desc.className = "text-text-2 text-xs";
		desc.textContent = label;
		row.append(kbd, desc);
		content.appendChild(row);
	}
	customModal("Keyboard shortcuts", content);
}

// Wave 4.10 — guard helper used by slot switch and disconnect.
// Returns true if the caller should proceed, false if the user cancelled.
async function confirmIfDirty(message: string): Promise<boolean> {
	if (!hasAnyDirty()) return true;
	return await confirmModal(message, {
		title: "Unsaved changes",
		confirmLabel: "Discard and continue",
		cancelLabel: "Keep editing",
	});
}

// JDS pivot — paint the status pill, connect button, offline body class.
// Extracted so initState + connect + disconnect all funnel through one
// renderer. Pass `null` label for disconnected, or the device label string
// when connected.
function applyConnectionUI(label: string | null) {
	const statusBadge = document.getElementById("statusBadge");
	const statusText = document.getElementById("statusText");
	const deviceName = document.getElementById("deviceName");
	const btnConnect = document.getElementById("btnConnect");

	if (label) {
		statusBadge?.classList.remove("disconnected");
		statusBadge?.classList.add("connected");
		if (statusText) statusText.textContent = "Connected";
		if (deviceName) deviceName.textContent = label;
		if (btnConnect) btnConnect.textContent = "Disconnect";
		setAppOffline(false);
	} else {
		statusBadge?.classList.remove("connected");
		statusBadge?.classList.add("disconnected");
		if (statusText) statusText.textContent = "Disconnected";
		if (deviceName) deviceName.textContent = "";
		if (btnConnect) btnConnect.textContent = "Connect";
		setAppOffline(true);
	}
}

// Flip just the status word — used for transient "Syncing…" / "Writing…"
// states without touching the badge class or deviceName label.
function setStatusWord(word: string) {
	const statusText = document.getElementById("statusText");
	if (statusText) statusText.textContent = word;
}

// Reset UI and state when the device is lost (disconnected externally
// or closed explicitly by the user). Safe to call multiple times.
function handleDeviceLost() {
	const wasConnected = getDevice() !== null;
	setDevice(null);
	setActiveConfig(null);
	setCurrentSlotId(101);
	resetSlots(defaultEqState(null), 0);

	applyConnectionUI(null);

	const fwVersion = document.getElementById("fwVersion");
	if (fwVersion) fwVersion.innerText = "";
	const gainSlider = document.getElementById(
		"globalGainSlider",
	) as HTMLInputElement | null;
	if (gainSlider) {
		gainSlider.disabled = true;
		gainSlider.value = "0";
	}
	const display = document.getElementById("globalGainDisplay");
	if (display) display.innerText = "0 dB";
	const slotSelect = document.getElementById(
		"slotSelect",
	) as HTMLSelectElement | null;
	if (slotSelect) {
		slotSelect.replaceChildren();
		const opt = document.createElement("option");
		opt.value = "";
		opt.textContent = "—";
		slotSelect.appendChild(opt);
	}

	enableControls(false);
	renderUI(getEqState());
	updateHistoryButtons();

	if (wasConnected) log("Device disconnected.");
}

export async function disconnectFromDevice() {
	const device = getDevice();
	if (!device) return;
	const ok = await confirmIfDirty(
		"Disconnecting will discard unsaved band edits. Continue?",
	);
	if (!ok) return;
	try {
		await device.close();
	} catch (err) {
		log(`Disconnect error: ${(err as Error).message}`);
	}
	handleDeviceLost();
}

// Connect/disconnect toggle used by the single top-bar button.
export async function toggleConnection() {
	if (getDevice()) {
		await disconnectFromDevice();
	} else {
		await connectToDevice();
	}
}

// Update both state and slider label; the device packet is sent separately
// by dsp.setDeviceGlobalGain.
export function setGlobalGain(gain: number) {
	setGlobalGainState(gain);
	updateGlobalGainUI(gain);
}

export function renderUI(eqState: EQ) {
	const container = document.getElementById("eqContainer");
	if (!container) {
		console.error("EQ Container not found!");
		return;
	}
	renderPEQ(
		container,
		eqState,
		(index, key, value) => {
			updateState(index, key, value);
		},
		{ inactiveBands: getInactiveEq() },
	);
	updateSlotUI();
}

// Wave 4 — paint the A/B toggle state. Light-weight: active tab just
// gets an accent underline, no filled background.
export function updateSlotUI() {
	const active = getActiveSlot();
	const btnA = document.getElementById("btnSlotA") as HTMLButtonElement | null;
	const btnB = document.getElementById("btnSlotB") as HTMLButtonElement | null;
	const label = document.getElementById("slotLabel");
	if (btnA && btnB) {
		const activeClasses = ["text-accent", "border-b", "border-accent"];
		const idleClasses = ["text-text-3"];
		const paint = (btn: HTMLButtonElement, isActive: boolean) => {
			btn.setAttribute("aria-selected", String(isActive));
			for (const c of activeClasses) btn.classList.toggle(c, isActive);
			for (const c of idleClasses) btn.classList.toggle(c, !isActive);
		};
		paint(btnA, active === "A");
		paint(btnB, active === "B");
	}
	if (label) label.textContent = `Slot ${active}`;
}

// Wave 4 — render the persistent preset sidebar (built-ins only for now).
// User presets / AutoEQ favorites can extend this list later.
//
// JDS pivot 2026-04-17: warmer empty + zero-results copy per decision #5.
export function renderPresetSidebar(filter = "") {
	const list = document.getElementById("presetList");
	if (!list) return;
	list.replaceChildren();
	const q = filter.trim().toLowerCase();
	let shown = 0;
	for (const preset of PRESETS) {
		if (q && !`${preset.name} ${preset.description}`.toLowerCase().includes(q))
			continue;
		const row = document.createElement("button");
		row.type = "button";
		row.className = "preset-row text-left";
		const col = document.createElement("div");
		col.className = "flex flex-col";
		const name = document.createElement("div");
		name.className = "text-sm font-semibold";
		name.textContent = preset.name;
		const desc = document.createElement("div");
		desc.className = "text-[11px] text-text-3 mt-0.5";
		desc.textContent = preset.description;
		col.append(name, desc);
		row.appendChild(col);
		row.addEventListener("click", () => applyPresetFromSidebar(preset.id));
		list.appendChild(row);
		shown++;
	}
	if (shown === 0) {
		const empty = document.createElement("div");
		empty.className =
			"text-[11px] text-text-3 px-2 py-3 text-center leading-snug";
		if (q) {
			empty.textContent = `No presets match “${filter}”. `;
			const clear = document.createElement("button");
			clear.type = "button";
			clear.className = "text-accent underline";
			clear.textContent = "Clear filter";
			clear.addEventListener("click", () => {
				const search = document.getElementById(
					"presetSearch",
				) as HTMLInputElement | null;
				if (search) search.value = "";
				renderPresetSidebar("");
			});
			empty.appendChild(clear);
		} else {
			empty.textContent =
				"No saved presets yet. Edit the EQ and click Save As New Preset above.";
		}
		list.appendChild(empty);
	}
}

async function applyPresetFromSidebar(id: string) {
	// No device gate — presets apply to in-memory state. When a device is
	// present we use its config, otherwise we fall back to the default
	// 8-band layout. Syncing later writes the pre-tuned state to hardware.
	const cfg = getActiveConfig();
	const maxFilters = cfg?.maxFilters ?? DEFAULT_FREQS.length;
	const defaultFreqs = cfg?.defaultFreqs ?? DEFAULT_FREQS;
	const preset = PRESETS.find((p) => p.id === id);
	if (!preset) return;
	if (isDirty(getActiveSlot())) {
		const ok = await confirmModal(
			`Slot ${getActiveSlot()} has unsaved edits. Loading "${preset.name}" will overwrite them.`,
			{ title: "Load preset?", confirmLabel: "Load preset", cancelLabel: "Keep" },
		);
		if (!ok) return;
	}
	snapshot();
	setEqState(applyPreset(preset, maxFilters, defaultFreqs));
	if (typeof preset.preamp === "number" && !cfg?.autoGlobalGain) {
		setGlobalGain(preset.preamp);
	}
	renderUI(getEqState());
	updateHistoryButtons();
	if (cfg) persistProfile(cfg.key);
	log(
		cfg
			? `Loaded preset: ${preset.name}. Sync to apply.`
			: `Loaded preset: ${preset.name}. Connect a device to apply.`,
	);
}

// Switch which in-memory slot is active. The UI re-renders to reflect the
// freshly-loaded slot contents. The device is NOT re-synced — the user
// must hit SYNC to push the newly-active EQ to hardware.
export async function activateSlot(slot: SlotName) {
	if (getActiveSlot() === slot) return;
	// Wave 4.10 — only prompt when the *current* active slot has unsaved
	// edits. Switching away from a clean slot is always safe.
	if (isDirty(getActiveSlot())) {
		const ok = await confirmModal(
			`Slot ${getActiveSlot()} has unsaved edits. Switching to ${slot} will keep them in memory but lose any in-flight changes on switch.`,
			{
				title: `Switch to slot ${slot}?`,
				confirmLabel: `Switch to ${slot}`,
				cancelLabel: "Stay",
			},
		);
		if (!ok) return;
	}
	snapshot();
	setActiveSlot(slot);
	updateGlobalGainUI(getGlobalGainState());
	renderUI(getEqState());
	updateHistoryButtons();
	log(`Switched to slot ${slot}.`);
	const cfg = getActiveConfig();
	if (cfg) persistProfile(cfg.key);
}

export function swapABSlots() {
	snapshot();
	swapSlots();
	updateGlobalGainUI(getGlobalGainState());
	renderUI(getEqState());
	updateHistoryButtons();
	const cfg = getActiveConfig();
	if (cfg) persistProfile(cfg.key);
	log("Swapped A ↔ B.");
}

// Wave 4.10 — freeze interactive UI during a device write. Uses the
// `inert` attribute (not `<fieldset disabled>`; see eng review EUREKA)
// so focus and screen-readers behave correctly.
function freezeUIDuringWrite(frozen: boolean) {
	for (const sel of ["header", "main", "#commitBar"]) {
		const el = document.querySelector(sel);
		if (!el) continue;
		if (frozen) el.setAttribute("inert", "");
		else el.removeAttribute("inert");
	}
	document.body.setAttribute("aria-busy", frozen ? "true" : "false");
}

// Wave 4.10 — UI wrappers for sync and flash. Progress modal + inert +
// errorModal with retry. Called from main.ts button handlers.
//
// JDS pivot 2026-04-17 additions:
//  - Clicked button gets `.is-busy` during the write (CSS shows a spinner).
//  - Status pill text flips to "Syncing…" / "Writing…" then back to
//    "Connected" on success. Device-name + badge class untouched.
//  - Flash wrapper shows an anchored confirm popover first; only proceeds
//    on explicit confirm. `flashToFlash` is invoked with its inner confirm
//    suppressed so the user sees exactly one prompt.
export async function handleSyncClick() {
	const device = getDevice();
	if (!device) return;
	const eqState = getEqState();
	const total = eqState.length;
	const btn = document.getElementById("btnSync") as HTMLButtonElement | null;
	btn?.classList.add("is-busy");
	const progress = progressModal({
		title: "Syncing to device RAM",
		total,
		initial: 0,
	});
	freezeUIDuringWrite(true);
	setStatusWord("Syncing…");
	try {
		await syncToDevice((i, n) => progress.update(i, `${i} / ${n} bands`));
		markSynced(getActiveSlot());
		renderUI(getEqState());
		toast("Synced to RAM");
	} catch (err) {
		progress.close();
		freezeUIDuringWrite(false);
		btn?.classList.remove("is-busy");
		if (getDevice()) setStatusWord("Connected");
		await errorModal((err as Error).message, {
			title: "Sync failed",
			retryLabel: "Retry",
			retry: () => handleSyncClick(),
		});
		return;
	}
	progress.close();
	freezeUIDuringWrite(false);
	btn?.classList.remove("is-busy");
	if (getDevice()) setStatusWord("Connected");
}

export async function handleFlashClick() {
	const device = getDevice();
	if (!device) return;
	const btn = document.getElementById("btnFlash") as HTMLButtonElement | null;
	if (!btn) return;

	// JDS pivot — anchored confirm popover replaces flashToFlash's internal
	// confirmModal so the user sees exactly one prompt. We pass
	// `skipConfirm: true` into flashToFlash below.
	const ok = await confirmFlashPopover(btn);
	if (!ok) return;

	btn.classList.add("is-busy");
	freezeUIDuringWrite(true);
	setStatusWord("Writing…");
	try {
		// Popover above already confirmed; skip flashToFlash's own prompt
		// to avoid a double-confirm.
		await flashToFlash(undefined, { skipConfirm: true });
		markSynced(getActiveSlot());
		toast("Saved to flash");
	} catch (err) {
		freezeUIDuringWrite(false);
		btn.classList.remove("is-busy");
		if (getDevice()) setStatusWord("Connected");
		await errorModal((err as Error).message, {
			title: "Flash failed",
			retryLabel: "Retry",
			retry: () => handleFlashClick(),
		});
		return;
	}
	freezeUIDuringWrite(false);
	btn.classList.remove("is-busy");
	if (getDevice()) setStatusWord("Connected");
}

// JDS pivot — popover anchored to the Save-to-flash button. Resolves true
// when the user confirms, false on cancel / Escape / outside-click.
// Inline rather than a separate helper file to keep the pivot scoped.
function confirmFlashPopover(anchor: HTMLElement): Promise<boolean> {
	return new Promise((resolve) => {
		const pop = document.createElement("div");
		pop.className = "popover";
		pop.setAttribute("role", "dialog");
		pop.setAttribute("aria-label", "Confirm write to flash");

		const msg = document.createElement("div");
		msg.textContent =
			"Write to device flash? This persists across power cycles.";
		msg.style.fontSize = "12px";
		msg.style.color = "var(--color-text-1)";
		msg.style.marginBottom = "10px";
		msg.style.maxWidth = "240px";
		pop.appendChild(msg);

		const row = document.createElement("div");
		row.style.display = "flex";
		row.style.gap = "8px";
		row.style.justifyContent = "flex-end";

		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "btn-ghost";
		cancel.textContent = "Cancel";

		const confirm = document.createElement("button");
		confirm.type = "button";
		confirm.className = "btn-primary";
		confirm.textContent = "Confirm write";

		row.append(cancel, confirm);
		pop.appendChild(row);

		document.body.appendChild(pop);
		// Position above the anchor, right-aligned. The commit bar sits at
		// the bottom of the viewport so we float the popover upward.
		const rect = anchor.getBoundingClientRect();
		const w = pop.offsetWidth;
		const h = pop.offsetHeight;
		const left = Math.max(
			8,
			Math.min(window.innerWidth - w - 8, rect.right - w),
		);
		const top = Math.max(8, rect.top - h - 8);
		pop.style.left = `${left}px`;
		pop.style.top = `${top}px`;

		let settled = false;
		function finish(result: boolean) {
			if (settled) return;
			settled = true;
			document.removeEventListener("mousedown", onOutside, true);
			document.removeEventListener("keydown", onKey, true);
			pop.remove();
			resolve(result);
		}
		function onOutside(e: MouseEvent) {
			if (!pop.contains(e.target as Node) && e.target !== anchor) {
				finish(false);
			}
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				finish(false);
			}
		}
		cancel.addEventListener("click", () => finish(false));
		confirm.addEventListener("click", () => finish(true));
		document.addEventListener("mousedown", onOutside, true);
		document.addEventListener("keydown", onKey, true);
		// Focus the confirm button so keyboard users can Enter through.
		setTimeout(() => confirm.focus(), 0);
	});
}

// Open the measurement loader. Accepts a local file, a remote URL, or
// pasted CSV text. AutoEQ-style "frequency,raw,..." and plain "freq,SPL"
// formats are both handled by the parser.
export function openMeasurementLoader() {
	const content = document.createElement("div");
	content.className = "flex flex-col gap-4 text-sm";

	const status = document.createElement("div");
	status.className = "text-xs text-gray-400";
	const current = getMeasurement();
	status.textContent = current
		? `Loaded: ${current.name} (${current.points.length} points)`
		: "No measurement loaded.";
	content.appendChild(status);

	function refreshStatus() {
		const m = getMeasurement();
		status.textContent = m
			? `Loaded: ${m.name} (${m.points.length} points)`
			: "No measurement loaded.";
	}

	function finishLoad(text: string, name: string) {
		try {
			const parsed = parseMeasurement(text, name);
			const normalized = normalizeAt(parsed, 1000);
			setMeasurement(normalized);
			renderUI(getEqState());
			log(
				`Loaded FR: ${name} (${parsed.points.length} points, normalized to 0 dB @ 1 kHz).`,
			);
			refreshStatus();
		} catch (err) {
			log(`FR parse error: ${(err as Error).message}`);
		}
	}

	// -- File upload --
	const fileRow = document.createElement("div");
	fileRow.className = "flex flex-col gap-1";
	const fileLabel = document.createElement("label");
	fileLabel.className = "text-xs uppercase text-gray-500";
	fileLabel.textContent = "Upload CSV";
	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = ".csv,.txt,.tsv";
	fileInput.className = "text-xs text-gray-300";
	fileInput.addEventListener("change", async () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		const text = await file.text();
		finishLoad(text, file.name.replace(/\.[^.]+$/, ""));
		fileInput.value = "";
	});
	fileRow.append(fileLabel, fileInput);
	content.appendChild(fileRow);

	// -- Browse AutoEQ --
	const autoeqRow = document.createElement("div");
	autoeqRow.className = "flex flex-col gap-1";
	const autoeqLabel = document.createElement("label");
	autoeqLabel.className = "text-xs uppercase text-gray-500";
	autoeqLabel.textContent = "Browse AutoEQ catalog";
	const autoeqBtn = document.createElement("button");
	autoeqBtn.type = "button";
	autoeqBtn.className =
		"self-start px-3 py-1 rounded font-semibold bg-amber-600 text-black text-xs hover:bg-amber-500";
	autoeqBtn.textContent = "Open AutoEQ picker";
	autoeqBtn.addEventListener("click", () => browseAutoEq());
	const autoeqHint = document.createElement("p");
	autoeqHint.className = "text-[10px] text-gray-500 leading-snug";
	autoeqHint.textContent =
		"jaakkopasanen/AutoEQ on GitHub. Pick a headphone to overlay its FR or apply its precomputed ParametricEQ directly to your bands.";
	autoeqRow.append(autoeqLabel, autoeqBtn, autoeqHint);
	content.appendChild(autoeqRow);

	// -- Browse squig.link --
	const squigRow = document.createElement("div");
	squigRow.className = "flex flex-col gap-1";
	const squigLabel = document.createElement("label");
	squigLabel.className = "text-xs uppercase text-gray-500";
	squigLabel.textContent = "Browse squig.link databases";
	const squigBtn = document.createElement("button");
	squigBtn.type = "button";
	squigBtn.className =
		"self-start px-3 py-1 rounded font-semibold bg-amber-600 text-black text-xs hover:bg-amber-500";
	squigBtn.textContent = "Open reviewer list";
	squigBtn.addEventListener("click", () =>
		browseSquigLink(finishLoad).catch((err: Error) => {
			log(`squig.link error: ${err.message}`);
		}),
	);
	const squigHint = document.createElement("p");
	squigHint.className = "text-[10px] text-gray-500 leading-snug";
	squigHint.textContent =
		"100+ reviewer databases (Super* Review, Precog, Listener, VSG, etc.). Crinacle's own data at graph.hangout.audio is obfuscated and not fetchable.";
	squigRow.append(squigLabel, squigBtn, squigHint);
	content.appendChild(squigRow);

	// -- URL fetch --
	const urlRow = document.createElement("div");
	urlRow.className = "flex flex-col gap-1";
	const urlLabel = document.createElement("label");
	urlLabel.className = "text-xs uppercase text-gray-500";
	urlLabel.textContent = "Fetch from URL";
	const urlHint = document.createElement("p");
	urlHint.className = "text-[10px] text-gray-500 leading-snug";
	urlHint.textContent =
		"Works with CORS-friendly hosts like raw.githubusercontent.com. Example: AutoEQ raw CSV.";
	const urlInputRow = document.createElement("div");
	urlInputRow.className = "flex gap-2";
	const urlInput = document.createElement("input");
	urlInput.type = "url";
	urlInput.placeholder = "https://raw.githubusercontent.com/.../measurement.csv";
	urlInput.className =
		"flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100";
	const urlFetchBtn = document.createElement("button");
	urlFetchBtn.type = "button";
	urlFetchBtn.className =
		"px-3 py-1 rounded font-semibold bg-blue-600 text-white text-xs hover:bg-blue-500";
	urlFetchBtn.textContent = "Fetch";
	urlFetchBtn.addEventListener("click", async () => {
		const url = urlInput.value.trim();
		if (!url) return;
		urlFetchBtn.disabled = true;
		urlFetchBtn.textContent = "…";
		try {
			const resp = await fetch(url);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const text = await resp.text();
			const name =
				decodeURIComponent(url.split("/").pop() ?? "remote").replace(
					/\.[^.]+$/,
					"",
				) || "remote";
			finishLoad(text, name);
			urlInput.value = "";
		} catch (err) {
			log(`Fetch error: ${(err as Error).message}`);
		} finally {
			urlFetchBtn.disabled = false;
			urlFetchBtn.textContent = "Fetch";
		}
	});
	urlInputRow.append(urlInput, urlFetchBtn);
	urlRow.append(urlLabel, urlInputRow, urlHint);
	content.appendChild(urlRow);

	// -- Paste --
	const pasteRow = document.createElement("div");
	pasteRow.className = "flex flex-col gap-1";
	const pasteLabel = document.createElement("label");
	pasteLabel.className = "text-xs uppercase text-gray-500";
	pasteLabel.textContent = "Paste CSV";
	const pasteArea = document.createElement("textarea");
	pasteArea.rows = 4;
	pasteArea.className =
		"w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-100";
	pasteArea.placeholder = "20,78\n100,80\n1000,82\n...";
	const pasteBtn = document.createElement("button");
	pasteBtn.type = "button";
	pasteBtn.className =
		"self-start px-3 py-1 rounded font-semibold bg-green-500 text-black text-xs hover:bg-green-400";
	pasteBtn.textContent = "Load pasted data";
	pasteBtn.addEventListener("click", () => {
		const text = pasteArea.value.trim();
		if (!text) return;
		finishLoad(text, "pasted");
		pasteArea.value = "";
	});
	pasteRow.append(pasteLabel, pasteArea, pasteBtn);
	content.appendChild(pasteRow);

	// -- Offset + clear --
	const offsetRow = document.createElement("div");
	offsetRow.className = "flex items-center gap-3 pt-2 border-t border-gray-700";
	const offsetLabel = document.createElement("label");
	offsetLabel.className = "text-xs text-gray-400";
	offsetLabel.textContent = "Offset";
	const offsetSlider = document.createElement("input");
	offsetSlider.type = "range";
	offsetSlider.min = "-30";
	offsetSlider.max = "30";
	offsetSlider.step = "0.5";
	offsetSlider.value = getMeasurementOffset().toString();
	offsetSlider.className = "flex-1";
	const offsetValue = document.createElement("span");
	offsetValue.className = "text-xs font-mono text-amber-400 w-14 text-right";
	offsetValue.textContent = `${offsetSlider.value} dB`;
	offsetSlider.addEventListener("input", () => {
		const v = Number(offsetSlider.value);
		setMeasurementOffset(v);
		offsetValue.textContent = `${v} dB`;
		renderUI(getEqState());
	});
	offsetRow.append(offsetLabel, offsetSlider, offsetValue);
	content.appendChild(offsetRow);

	const clearBtn = document.createElement("button");
	clearBtn.type = "button";
	clearBtn.className =
		"self-start px-3 py-1 rounded font-semibold bg-red-700 text-white text-xs hover:bg-red-600";
	clearBtn.textContent = "Clear measurement";
	clearBtn.addEventListener("click", () => {
		setMeasurement(null);
		renderUI(getEqState());
		log("FR cleared.");
		refreshStatus();
	});
	content.appendChild(clearBtn);

	customModal("Frequency Response Overlay", content);
}

// Cached once per session so repeat browses don't re-hammer the directory.
let cachedSquigSites: Awaited<ReturnType<typeof fetchSites>> | null = null;
const cachedPhoneBooks = new Map<string, SquigPhoneEntry[]>();
let cachedAutoEqEntries: AutoEqEntry[] | null = null;

// Browse AutoEQ: pick a headphone, then choose between loading the raw
// measurement (FR overlay) or the precomputed ParametricEQ (applied to
// the device bands via the standard text import).
export async function browseAutoEq() {
	const cfg = getActiveConfig();
	if (!cachedAutoEqEntries) {
		log("Loading AutoEQ index from GitHub (once per session)…");
		try {
			cachedAutoEqEntries = await fetchAutoEqIndex();
		} catch (err) {
			log(`AutoEQ: ${(err as Error).message}`);
			return;
		}
	}

	const rows = cachedAutoEqEntries.map((e, i) => ({
		id: String(i),
		title: e.headphone,
		subtitle: `${e.reviewer} / ${e.target}`,
	}));

	const chosen = await searchPickerModal(rows, {
		title: `AutoEQ catalog (${cachedAutoEqEntries.length} entries)`,
		placeholder: "Filter by headphone, reviewer, or target…",
	});
	if (!chosen) return;
	const entry = cachedAutoEqEntries[Number(chosen)];
	if (!entry) return;

	// Action picker: FR overlay vs Parametric EQ.
	const actions: Array<{ id: string; title: string; subtitle?: string }> = [];
	if (entry.csvPath) {
		actions.push({
			id: "fr",
			title: "Load raw FR (overlay)",
			subtitle: `${entry.csvPath.split("/").pop()}`,
		});
	}
	if (entry.parametricEqPath) {
		actions.push({
			id: "peq",
			title: "Apply ParametricEQ (to bands)",
			subtitle: cfg
				? `Writes into the ${cfg.maxFilters}-band ${cfg.label} slots`
				: `Writes into the default ${DEFAULT_FREQS.length}-band layout`,
		});
	}
	if (actions.length === 0) {
		log("No loadable files for this entry.");
		return;
	}
	const action = await pickerModal(actions, {
		title: `${entry.headphone} — choose action`,
	});
	if (!action) return;

	try {
		if (action === "fr" && entry.csvPath) {
			log(`Fetching ${entry.headphone} measurement…`);
			const text = await fetchAutoEqFile(entry.csvPath);
			const parsed = normalizeAt(
				parseMeasurement(text, entry.headphone),
				1000,
			);
			setMeasurement(parsed);
			renderUI(getEqState());
			log(
				`Loaded FR: ${entry.headphone} (${parsed.points.length} points, normalized @ 1 kHz).`,
			);
		} else if (action === "peq" && entry.parametricEqPath) {
			log(`Fetching ${entry.headphone} ParametricEQ…`);
			const text = await fetchAutoEqFile(entry.parametricEqPath);
			snapshot();
			applyProfileText(text, `AutoEQ: ${entry.headphone}`);
			if (cfg) persistProfile(cfg.key);
		}
	} catch (err) {
		log(`AutoEQ fetch failed: ${(err as Error).message}`);
	}
}

async function browseSquigLink(
	onLoad: (text: string, name: string) => void,
) {
	if (!cachedSquigSites) {
		log("Loading squig.link directory…");
		cachedSquigSites = await fetchSites();
	}

	// Flatten sites × their databases (an IEM site may also have a
	// Headphones db; they become separate picker rows).
	const rows: Array<{ id: string; title: string; subtitle?: string }> = [];
	const lookup = new Map<string, string>(); // id → baseUrl
	for (const site of cachedSquigSites) {
		for (const db of resolveDbUrls(site)) {
			const id = db.baseUrl;
			rows.push({
				id,
				title: db.siteLabel,
				subtitle: db.baseUrl,
			});
			lookup.set(id, db.baseUrl);
		}
	}
	rows.sort((a, b) => a.title.localeCompare(b.title));

	const chosenBase = await searchPickerModal(rows, {
		title: "Pick a reviewer database",
		placeholder: "Filter reviewers…",
	});
	if (!chosenBase) return;
	const baseUrl = lookup.get(chosenBase);
	if (!baseUrl) return;

	let phones = cachedPhoneBooks.get(baseUrl);
	if (!phones) {
		log(`Loading ${baseUrl}data/phone_book.json …`);
		phones = await fetchPhoneBook(baseUrl);
		cachedPhoneBooks.set(baseUrl, phones);
	}

	// Each "variant" (entry.files[i]) gets its own picker row so the
	// user can pick between e.g. different insertion depths.
	const phoneRows: Array<{ id: string; title: string; subtitle?: string }> = [];
	for (let i = 0; i < phones.length; i++) {
		const p = phones[i];
		for (let j = 0; j < p.files.length; j++) {
			const suffix = p.suffixes?.[j] ?? "";
			phoneRows.push({
				id: `${i}:${j}`,
				title: `${p.brand} ${p.name}${suffix ? " " + suffix : ""}`.trim(),
				subtitle: p.price ? `${p.price}` : undefined,
			});
		}
	}
	phoneRows.sort((a, b) => a.title.localeCompare(b.title));

	const chosenPhone = await searchPickerModal(phoneRows, {
		title: "Pick a headphone / IEM",
		placeholder: "Filter by name…",
	});
	if (!chosenPhone) return;

	const [iStr, jStr] = chosenPhone.split(":");
	const entry = phones[Number(iStr)];
	if (!entry) return;
	const fileBasename = entry.files[Number(jStr)];

	log(`Fetching FR for ${entry.brand} ${entry.name}…`);
	try {
		const text = await fetchPhoneFR(baseUrl, fileBasename);
		onLoad(text, `${entry.brand} ${entry.name}`.trim());
	} catch (err) {
		log(`squig.link FR fetch failed: ${(err as Error).message}`);
	}
}

// Open a modal with test-signal controls (pink noise, white noise,
// log sine sweep). Signals are played through the user's default output,
// so they pick up whatever EQ the connected DAC is applying.
export function openSignalGenerator() {
	const content = document.createElement("div");
	content.className = "flex flex-col gap-3 text-sm";

	const hint = document.createElement("p");
	hint.className = "text-xs text-gray-400";
	hint.textContent =
		"Plays through your default output. If your DAC is active, the EQ is applied before the sound reaches your ears.";
	content.appendChild(hint);

	const gainRow = document.createElement("div");
	gainRow.className = "flex items-center gap-3";
	const gainLabel = document.createElement("label");
	gainLabel.className = "text-xs text-gray-400";
	gainLabel.textContent = "Output";
	const gainValue = document.createElement("span");
	gainValue.className = "text-xs font-mono text-blue-400 w-14 text-right";
	gainValue.textContent = "-18 dB";
	const gainSlider = document.createElement("input");
	gainSlider.type = "range";
	gainSlider.min = "-40";
	gainSlider.max = "-6";
	gainSlider.step = "1";
	gainSlider.value = "-18";
	gainSlider.className = "flex-1";
	gainSlider.addEventListener("input", () => {
		gainValue.textContent = `${gainSlider.value} dB`;
	});
	gainRow.append(gainLabel, gainSlider, gainValue);
	content.appendChild(gainRow);

	const buttons = document.createElement("div");
	buttons.className = "grid grid-cols-2 gap-2";

	function mkButton(text: string, onClick: () => void) {
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = text;
		b.className =
			"px-3 py-2 rounded font-semibold bg-gray-700 text-white text-sm hover:bg-gray-600";
		b.addEventListener("click", onClick);
		return b;
	}

	const status = document.createElement("div");
	status.className = "text-xs text-gray-400 text-center";

	function syncStatus() {
		const t = getPlayingType();
		status.textContent = t ? `Playing: ${t}` : "Stopped";
	}

	buttons.appendChild(
		mkButton("Pink Noise", () => {
			playPinkNoise(Number(gainSlider.value));
			syncStatus();
		}),
	);
	buttons.appendChild(
		mkButton("White Noise", () => {
			playWhiteNoise(Number(gainSlider.value));
			syncStatus();
		}),
	);
	buttons.appendChild(
		mkButton("Sine Sweep 20→20k Hz", () => {
			playSineSweep({ gainDb: Number(gainSlider.value) });
			syncStatus();
			// Status reverts when the sweep finishes on its own.
			setTimeout(syncStatus, 10500);
		}),
	);
	buttons.appendChild(
		mkButton("Stop", () => {
			stopSignal();
			syncStatus();
		}),
	);

	content.appendChild(buttons);
	content.appendChild(status);

	syncStatus();

	const dialog = customModal("Test Signals", content);
	dialog.addEventListener("close", () => stopSignal());
}

export async function connectToDevice() {
	try {
		const devices = await navigator.hid.requestDevice({
			filters: allVendorFilters(),
		});
		if (devices.length === 0) return;

		const device = devices[0];
		await device.open();
		setDevice(device);

		const cfg = pickDeviceConfig(device);
		setActiveConfig(cfg);

		log(
			`Connected to: ${device.productName} (VID: 0x${device.vendorId.toString(16).toUpperCase()}, Config: ${cfg.label}, maxFilters=${cfg.maxFilters})`,
		);

		clearHistory();

		// Initialize both A and B slots so that A/B comparison has a
		// consistent baseline across the device's full band count.
		const baseline = defaultEqState(cfg);
		resetSlots(baseline, 0);

		const persisted = loadPersistedProfile(cfg.key);
		if (persisted && persisted.eq.length === cfg.maxFilters) {
			setEqState(persisted.eq);
			setGlobalGain(persisted.gain);
			log(
				`Restored saved profile from ${new Date(persisted.savedAt).toLocaleString()}. Sync to apply.`,
			);
		} else {
			setGlobalGain(0);
		}

		// Setup UI state — status pill uses device label from active config.
		applyConnectionUI(cfg.label);

		const gainSlider = document.getElementById(
			"globalGainSlider",
		) as HTMLInputElement | null;
		if (gainSlider) {
			gainSlider.min = cfg.minGain.toString();
			gainSlider.max = cfg.maxGain.toString();
		}

		if (cfg.autoGlobalGain) {
			if (gainSlider) gainSlider.disabled = true;
			const display = document.getElementById("globalGainDisplay");
			if (display) display.innerText = "AUTO";
		}

		const slotSelect = document.getElementById(
			"slotSelect",
		) as HTMLSelectElement | null;
		if (slotSelect) {
			slotSelect.replaceChildren();
			for (const slot of cfg.slots) {
				const opt = document.createElement("option");
				opt.value = slot.id.toString();
				opt.textContent = slot.name;
				slotSelect.appendChild(opt);
			}
			setCurrentSlotId(cfg.slots[0].id);
			slotSelect.value = cfg.slots[0].id.toString();
		}

		enableControls(true);

		// Re-lock preamp after enableControls if autoGlobalGain
		if (cfg.autoGlobalGain && gainSlider) gainSlider.disabled = true;

		renderUI(getEqState());

		if (cfg.supportsReadback) {
			setupListener(device);
			await readDeviceParams(device);
		} else {
			log(
				`Note: read-back is not yet implemented for ${cfg.label}. Shown values are defaults, not the device's current state.`,
			);
		}
	} catch (err) {
		log(`Error: ${(err as Error).message}`);
	}
}

export async function resetToDefaults() {
	const ok = await confirmModal(
		"Reset all bands to Defaults (0 dB, Q=0.75) and optimal frequencies?",
		{ title: "Reset EQ", confirmLabel: "Reset" },
	);
	if (!ok) return;

	log("Resetting to factory defaults...");

	snapshot();
	setEqState(defaultEqState(getActiveConfig()));
	setGlobalGain(0);
	renderUI(getEqState());
	updateHistoryButtons();

	const cfg = getActiveConfig();
	if (cfg) persistProfile(cfg.key);

	await syncToDevice();
	log("Defaults applied and synced.");
}

export function updateState(
	index: number,
	key: string,
	value: string | number | boolean,
) {
	if (key === "freq" || key === "gain" || key === "q")
		value = parseFloat(value as string);
	else if (key === "enabled") value = Boolean(value);

	snapshot();
	setBandField(index, key as keyof Band, value);
	renderUI(getEqState());
	updateHistoryButtons();

	const cfg = getActiveConfig();
	if (cfg) persistProfile(cfg.key);
}

export function onSlotChange(e: Event) {
	const select = e.target as HTMLSelectElement;
	const slotId = Number.parseInt(select.value, 10);
	setCurrentSlotId(slotId);
	log(
		`Slot changed to: ${select.selectedOptions[0].textContent} (id=${slotId})`,
	);
}

// Legacy modal preset picker — kept for programmatic callers. Matches
// applyPresetFromSidebar behaviour: works without a device, falls back
// to DEFAULT_FREQS when no config is active.
export async function openPresetPicker() {
	const cfg = getActiveConfig();
	const maxFilters = cfg?.maxFilters ?? DEFAULT_FREQS.length;
	const defaultFreqs = cfg?.defaultFreqs ?? DEFAULT_FREQS;
	const chosen = await pickerModal(
		PRESETS.map((p) => ({
			id: p.id,
			title: p.name,
			subtitle: p.description,
		})),
		{ title: "Load preset" },
	);
	if (!chosen) return;
	const preset = PRESETS.find((p) => p.id === chosen);
	if (!preset) return;

	snapshot();
	setEqState(applyPreset(preset, maxFilters, defaultFreqs));
	if (typeof preset.preamp === "number" && !cfg?.autoGlobalGain) {
		setGlobalGain(preset.preamp);
	}
	renderUI(getEqState());
	updateHistoryButtons();
	if (cfg) persistProfile(cfg.key);
	log(
		cfg
			? `Loaded preset: ${preset.name}. Sync to apply.`
			: `Loaded preset: ${preset.name}. Connect a device to apply.`,
	);
}

// Keyboard-shortcut handlers. Re-render + update slider UI after apply.
export function undoAction() {
	const snap = undo();
	if (!snap) {
		log("Nothing to undo.");
		updateHistoryButtons();
		return;
	}
	updateGlobalGainUI(snap.gain);
	renderUI(getEqState());
	const cfg = getActiveConfig();
	if (cfg) persistProfile(cfg.key);
	updateHistoryButtons();
	log("Undo.");
}

export function redoAction() {
	const snap = redo();
	if (!snap) {
		log("Nothing to redo.");
		updateHistoryButtons();
		return;
	}
	updateGlobalGainUI(snap.gain);
	renderUI(getEqState());
	const cfg = getActiveConfig();
	if (cfg) persistProfile(cfg.key);
	updateHistoryButtons();
	log("Redo.");
}

// --------------------------------------------------------------------------
// JDS pivot 2026-04-17 — wiring for the new action bar, sidebar, tabs,
// commit bar, and log tray. All wires are optional and ID-based; missing
// elements fail silently.
// --------------------------------------------------------------------------

// Called after every action that may change the history stack. Buttons
// reflect the stack state; callers don't need to know the shape of
// history.ts to keep the UI in sync.
export function updateHistoryButtons() {
	const undoBtn = document.getElementById("btnUndo") as HTMLButtonElement | null;
	const redoBtn = document.getElementById("btnRedo") as HTMLButtonElement | null;
	if (undoBtn) undoBtn.disabled = !canUndo();
	if (redoBtn) redoBtn.disabled = !canRedo();
}

function wireHistoryButtons() {
	document
		.getElementById("btnUndo")
		?.addEventListener("click", () => undoAction());
	document
		.getElementById("btnRedo")
		?.addEventListener("click", () => redoAction());
	updateHistoryButtons();
}

// Preset action bar — Update / Save As New / Get link / Delete. presets.ts
// doesn't yet have user-preset CRUD, so Update and Save As New are TODO
// stubs with visible feedback. Export stays wired via main.ts — we don't
// touch it.
function wirePresetActionBar() {
	// TODO(presets-crud): wire once presets.ts exposes saveOverCurrent().
	document
		.getElementById("btnUpdatePreset")
		?.addEventListener("click", () => {
			console.log("TODO: wire Update Preset");
			toast("Update Preset — not yet implemented");
		});

	// TODO(presets-crud): wire once presets.ts exposes saveAsNew(name).
	document
		.getElementById("btnSaveAsNew")
		?.addEventListener("click", () => {
			const name = window.prompt("Name this preset:");
			if (!name) return;
			console.log("TODO: wire Save As New Preset:", name);
			toast(`Save As New (“${name}”) — not yet implemented`);
		});

	document
		.getElementById("btnGetLink")
		?.addEventListener("click", () => shareCurrentEqLink());

	document
		.getElementById("btnPresetDelete")
		?.addEventListener("click", () => {
			console.log("TODO: wire Delete Preset");
			toast("Delete Preset — not yet implemented");
		});
	// Dual-wire the current index.html ID (#btnDeletePreset) until the HTML
	// agent lands the contract rename to #btnPresetDelete.
	document
		.getElementById("btnDeletePreset")
		?.addEventListener("click", () => {
			console.log("TODO: wire Delete Preset");
			toast("Delete Preset — not yet implemented");
		});
}

// Build a shareable URL with the current EQ state encoded in the hash.
// Simple base64(JSON) rather than the full squiglink codec — good enough
// for MVP cross-device handoff.
async function shareCurrentEqLink() {
	try {
		const payload = {
			v: 1,
			eq: getEqState(),
			gain: getGlobalGainState(),
		};
		const json = JSON.stringify(payload);
		const b64 = btoa(unescape(encodeURIComponent(json)));
		const url = `${location.origin}${location.pathname}#eq=${b64}`;
		await navigator.clipboard.writeText(url);
		toast("Share link copied to clipboard");
		log(`Share link generated (${b64.length} chars).`);
	} catch (err) {
		log(`Share link failed: ${(err as Error).message}`);
		toast("Could not copy share link");
	}
}

// Sidebar "Mode" segmented control. There's no concrete device-level mode
// switching today — we emit an event so future consumers can hook in, and
// toggle the visual state.
function wireModeControl() {
	const hp = document.getElementById("modeHeadphone");
	const rca = document.getElementById("modeRca");
	if (!hp || !rca) return;
	const set = (mode: "headphone" | "rca") => {
		hp.classList.toggle("active", mode === "headphone");
		rca.classList.toggle("active", mode === "rca");
		hp.setAttribute("aria-selected", String(mode === "headphone"));
		rca.setAttribute("aria-selected", String(mode === "rca"));
		// TODO(device-mode): hook into deviceConfig when per-device mode
		// switching lands. For now this is UI-only + a broadcast event.
		setOutputMode(mode);
		console.log(`ddpec:mode-changed ${mode}`);
	};
	hp.addEventListener("click", () => set("headphone"));
	rca.addEventListener("click", () => set("rca"));
}

// Sidebar "Disable EQ" button. Mirrors the bottom `#eqEnabledSwitch`
// checkbox so the two surfaces stay in sync.
function wireEqDisable() {
	const btn = document.getElementById("btnDisableEq") as HTMLButtonElement | null;
	const sw = document.getElementById("eqEnabledSwitch") as HTMLInputElement | null;
	const paint = () => {
		const on = isEqEnabled();
		if (sw && sw.checked !== on) sw.checked = on;
		if (btn) btn.textContent = on ? "Disable EQ" : "Enable EQ";
	};
	btn?.addEventListener("click", () => {
		// TODO(eq-bypass): actually bypass the EQ stack when peq.ts /
		// dsp.ts grow consumers for ddpec:eq-toggled. For now flip state +
		// visual + event.
		setEqEnabled(!isEqEnabled());
		paint();
		console.log(`ddpec:eq-toggled enabled=${isEqEnabled()}`);
	});
	sw?.addEventListener("change", () => {
		setEqEnabled(!!sw.checked);
		paint();
		console.log(`ddpec:eq-toggled enabled=${isEqEnabled()}`);
	});
	paint();
}

// Bottom panel tabs — Tabular EQ / Preamp Gain. There is no existing
// separate preamp panel in the DOM, so this is a placeholder until
// someone builds one.
function wireBottomPanelTabs() {
	const tab1 = document.getElementById("tabTabular");
	const tab2 = document.getElementById("tabPreamp");
	if (!tab1 || !tab2) return;
	const paint = (which: "tabular" | "preamp") => {
		tab1.classList.toggle("active", which === "tabular");
		tab2.classList.toggle("active", which === "preamp");
		tab1.setAttribute("aria-selected", String(which === "tabular"));
		tab2.setAttribute("aria-selected", String(which === "preamp"));
	};
	tab1.addEventListener("click", () => paint("tabular"));
	tab2.addEventListener("click", () => {
		paint("preamp");
		// TODO(preamp-panel): render a dedicated preamp-gain editor.
		console.log("TODO: preamp panel");
	});
}

// Log tray — click to expand / collapse, update caret. `log()` already
// mirrors the latest line into #logTrayLatest (helpers.ts).
function wireLogTray() {
	const tray = document.getElementById("logTray");
	const caret = document.getElementById("logTrayCaret");
	const console_ = document.getElementById("logConsole");
	if (!tray || !console_) return;
	const paint = () => {
		const expanded = tray.classList.contains("expanded");
		tray.setAttribute("aria-expanded", String(expanded));
		if (caret) caret.textContent = expanded ? "▾" : "▸";
		// Expanded = show full console; collapsed = hide it.
		console_.classList.toggle("hidden", !expanded);
		if (expanded) console_.scrollTop = console_.scrollHeight;
	};
	tray.addEventListener("click", () => {
		tray.classList.toggle("expanded");
		paint();
	});
	tray.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			tray.classList.toggle("expanded");
			paint();
		}
	});
	paint();
}

// Top nav tabs — DSP / Device Settings. Device Settings is a stub pane;
// create it on first activation. Dual-wire both the contract IDs and the
// current index.html IDs so this works during the HTML agent's rollout.
function wireNavTabs() {
	const dspBtn =
		(document.getElementById("navTabDsp") as HTMLElement | null) ??
		document.getElementById("tabDsp");
	const devBtn =
		(document.getElementById("navTabDevice") as HTMLElement | null) ??
		document.getElementById("tabDevice");
	if (!dspBtn || !devBtn) return;
	const mainEl = document.querySelector("main") as HTMLElement | null;
	let devicePane: HTMLElement | null = null;

	const showDsp = () => {
		dspBtn.classList.add("active");
		devBtn.classList.remove("active");
		dspBtn.setAttribute("aria-selected", "true");
		devBtn.setAttribute("aria-selected", "false");
		if (mainEl) mainEl.style.display = "";
		if (devicePane) devicePane.style.display = "none";
	};
	const showDevice = () => {
		devBtn.classList.add("active");
		dspBtn.classList.remove("active");
		devBtn.setAttribute("aria-selected", "true");
		dspBtn.setAttribute("aria-selected", "false");
		if (!devicePane) {
			devicePane = document.createElement("div");
			devicePane.id = "deviceSettingsPane";
			devicePane.textContent =
				"Device Settings coming soon — theme toggle, firmware version, factory reset";
			devicePane.style.flex = "1";
			devicePane.style.display = "flex";
			devicePane.style.alignItems = "center";
			devicePane.style.justifyContent = "center";
			devicePane.style.color = "var(--color-text-3)";
			devicePane.style.fontSize = "12px";
			// Insert right after <main> so layout is sane in both states.
			if (mainEl?.parentNode) {
				mainEl.parentNode.insertBefore(devicePane, mainEl.nextSibling);
			} else {
				document.body.appendChild(devicePane);
			}
		}
		if (mainEl) mainEl.style.display = "none";
		devicePane.style.display = "flex";
	};
	dspBtn.addEventListener("click", showDsp);
	devBtn.addEventListener("click", showDevice);
}

// Commit bar — hide when clean, show when any slot is dirty; mirror the
// "Preset changed" chip in the preset action bar. Subscribes to the
// dirty-change event broadcast by state.ts so we don't poll.
function wireCommitBar() {
	const bar = document.getElementById("commitBar");
	const pendingChip = document.getElementById("pendingChangesChip");
	const changedChip = document.getElementById("presetChangedChip");
	const apply = () => {
		const dirty = hasAnyDirty();
		if (bar) bar.classList.toggle("hidden", !dirty);
		if (pendingChip) {
			if (dirty) pendingChip.removeAttribute("hidden");
			else pendingChip.setAttribute("hidden", "");
		}
		if (changedChip) {
			if (dirty) changedChip.removeAttribute("hidden");
			else changedChip.setAttribute("hidden", "");
		}
	};
	document.addEventListener("ddpec:dirty-change", apply);
	// Paint initial state once on boot.
	apply();
}

// `setDirty(bool)` lives in state.ts (see that file). Re-export so callers
// that already pull symbols from fn.ts keep a single import surface.
export { setDirty } from "./state.ts";
