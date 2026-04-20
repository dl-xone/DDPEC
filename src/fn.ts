import { DEFAULT_FREQS, LAB_MODE_MAX_BANDS, MIN_BANDS } from "./constants.ts";
import { allVendorFilters, pickDeviceConfig } from "./deviceConfig.ts";
import {
	flashToFlash,
	readDeviceParams,
	setupListener,
	syncToDevice,
} from "./dsp.ts";
import {
	computeClippingHeadroom,
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
	getThemePreference,
	setTheme,
	type ThemePreference,
} from "./theme.ts";
import {
	confirmModal,
	customModal,
	errorModal,
	pickerModal,
	progressModal,
	searchPickerModal,
} from "./modal.ts";
import {
	addUserPreset,
	applyPreset,
	deleteUserPreset,
	eqToPresetBands,
	getAllPresets,
	isUserPresetId,
	PRESETS,
	updateUserPreset,
} from "./presets.ts";
import { getSession, saveSession } from "./session.ts";
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
import {
	applyProfileText,
	downloadPayload,
	exportAs,
	EXPORT_FORMAT_LABELS,
	type ExportFormat,
} from "./importExport.ts";
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
	type Command,
	openPalette,
	registerCommand,
} from "./commandPalette.ts";
import {
	addBand,
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
	removeBandAt,
	resetSlots,
	setActiveConfig,
	setActiveSlot,
	setBandField,
	setCurrentSlotId,
	setDevice,
	setEqEnabled,
	setEqState,
	setGlobalGainState,
	setLoadedPresetSnapshot,
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

// Re-export so main.ts' keyboard handler can open the palette without
// pulling in commandPalette.ts directly.
export { openPalette } from "./commandPalette.ts";

import { morphToBands } from "./morph.ts";
import { initShortcutOverlay, registerShortcut } from "./shortcutOverlay.ts";

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

	// FR overlay picker.
	document
		.getElementById("btnMeasurement")
		?.addEventListener("click", () => openMeasurementLoader());

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
	wireEqDisable();
	wireBottomPanelTabs();
	wireLogTray();
	wireLogClear();
	wireNavTabs();
	wireCommitBar();
	wireViewToggles();
	wireExportMenu();
	registerDefaultCommands();

	// Feature B — Alt-hold shortcut overlay. Listeners attach once; chip
	// elements inject lazily on first Alt hold so dynamically-rendered
	// targets (e.g. preset bar) are present by then.
	initShortcutOverlay();
	registerShortcut("#btnUndo", "⌘Z");
	registerShortcut("#btnRedo", "⇧⌘Z");
	registerShortcut("#btnSlotSwap", "Alt+S");
	registerShortcut("#btnDisableEq", "Space");
	registerShortcut("#eqEnabledSwitch", "Space");

	// Feature D — ABX harness button + last-score subtitle.
	wireAbxButton();
	paintAbxSubtitle();
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
		["Space", "Toggle EQ bypass"],
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
	refreshDeviceInfoUI();

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
	// Feature 7 — honour the session-level A/B overlay toggle. "hidden"
	// suppresses the inactive curve entirely (no ghost line, no delta).
	const session = getSession();
	const overlayHidden = session.abOverlay === "hidden";
	renderPEQ(
		container,
		eqState,
		(index, key, value) => {
			updateState(index, key, value);
		},
		{
			inactiveBands: overlayHidden ? null : getInactiveEq(),
			onAddBand: addBandHandler,
			onRemoveBand: removeBandHandler,
			onDeleteBand: deleteBandHandler,
			getBandCountCap: getBandCountCap,
			// Delta line depends on the A/B overlay being visible (it
			// compares active vs inactive — useless if inactive is off).
			showDelta: !overlayHidden && !!session.showDelta,
			showPhase: !!session.showPhase,
		},
	);
	updateSlotUI();
	syncViewToggleButtons();
}

// Feature 3 — drag-off-canvas delete. Same history + persistence spine as
// `removeBandHandler` but targets a specific array index (the band that
// was dragged). No-op if removing would take us below the min band count.
export function deleteBandHandler(arrayIdx: number) {
	const cap = getBandCountCap();
	const eq = getEqState();
	if (eq.length <= cap.min) {
		toast(`Min ${cap.min} band${cap.min === 1 ? "" : "s"} required`);
		// Still redraw so the band returns to its pre-drag position instead
		// of hanging wherever the pointer left it.
		renderUI(getEqState());
		return;
	}
	if (arrayIdx < 0 || arrayIdx >= eq.length) return;
	snapshot();
	const removed = removeBandAt(arrayIdx);
	renderUI(getEqState());
	updateHistoryButtons();
	const cfg = getActiveConfig();
	if (cfg) persistProfile(cfg.key);
	if (removed) {
		toast(`Removed band ${Math.round(removed.freq)} Hz`);
		log(`Removed band at ${Math.round(removed.freq)} Hz (dragged off canvas).`);
	}
}

// Band-count cap. Connected → device's maxFilters (hardware floor for
// ring-buffer slots). Disconnected (lab mode) → a soft cap so the UI
// doesn't grow unbounded.
export function getBandCountCap(): { min: number; max: number } {
	const cfg = getActiveConfig();
	return {
		min: MIN_BANDS,
		max: cfg?.maxFilters ?? LAB_MODE_MAX_BANDS,
	};
}

// Append a new band to the active slot. Uses the lowest free hardware slot
// index (important for connected devices where band.index ∈ [0, maxFilters))
// so removing slot 3 and re-adding reuses slot 3 rather than assigning slot
// N+1. History is captured via snapshot() so undo rolls back the addition.
export function addBandHandler() {
	const cap = getBandCountCap();
	const eq = getEqState();
	if (eq.length >= cap.max) {
		toast(`Max ${cap.max} bands for this device`);
		return;
	}

	const freqs = eq.map((b) => b.freq);
	const maxFreq = freqs.length > 0 ? Math.max(...freqs) : 0;
	// Place the new band between the current highest freq and 20 kHz so it
	// lands in empty spectrum. If the top band is already near the ceiling,
	// fall back to 1 kHz — a reasonable default the user can drag anywhere.
	const newFreq =
		maxFreq < 10000 ? Math.round((maxFreq + 20000) / 2) : 1000;

	// Pick the lowest unused hardware slot index so deletions free up slots
	// for reuse (critical for connected devices that cap at maxFilters).
	const used = new Set(eq.map((b) => b.index));
	let nextIdx = 0;
	while (used.has(nextIdx)) nextIdx++;

	const newBand: Band = {
		index: nextIdx,
		freq: newFreq,
		gain: 0,
		q: 0.75,
		type: "PK",
		enabled: true,
	};

	snapshot();
	addBand(newBand);
	renderUI(getEqState());
	updateHistoryButtons();
	const cfg = getActiveConfig();
	if (cfg) persistProfile(cfg.key);
	log(`Added band ${nextIdx + 1} at ${newFreq} Hz.`);
}

// Remove the currently-selected band. No explicit selection tracked here
// (peq.ts owns `selectedIndex` as a display concern), so we fall back to
// the highest-frequency band — the most common "I want one less band"
// action. History captures the length change.
export function removeBandHandler() {
	const cap = getBandCountCap();
	const eq = getEqState();
	if (eq.length <= cap.min) {
		toast(`Min ${cap.min} band${cap.min === 1 ? "" : "s"} required`);
		return;
	}

	// Find the highest-freq band's array position.
	let targetArrayIdx = 0;
	let maxFreq = -Infinity;
	for (let i = 0; i < eq.length; i++) {
		if (eq[i].freq > maxFreq) {
			maxFreq = eq[i].freq;
			targetArrayIdx = i;
		}
	}

	snapshot();
	const removed = removeBandAt(targetArrayIdx);
	renderUI(getEqState());
	updateHistoryButtons();
	const cfg = getActiveConfig();
	if (cfg) persistProfile(cfg.key);
	if (removed) {
		log(`Removed band at ${Math.round(removed.freq)} Hz.`);
	}
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
	const selectedId = getSession().selectedPresetId;
	const allPresets = getAllPresets();
	let shown = 0;
	let sawFirstUser = false;
	for (const preset of allPresets) {
		if (q && !`${preset.name} ${preset.description}`.toLowerCase().includes(q))
			continue;
		// Divider before the first user preset in the list (if any shown).
		if (preset.isUser && !sawFirstUser) {
			sawFirstUser = true;
			const divider = document.createElement("div");
			divider.className =
				"text-[10px] uppercase tracking-wider text-text-3 px-2 pt-2 pb-1";
			divider.textContent = "My presets";
			list.appendChild(divider);
		}
		const row = document.createElement("button");
		row.type = "button";
		row.className = "preset-row text-left";
		if (preset.id === selectedId) row.classList.add("active");
		row.dataset.presetId = preset.id;
		const col = document.createElement("div");
		col.className = "flex flex-col";
		const name = document.createElement("div");
		name.className = "text-sm font-semibold";
		name.textContent = preset.isUser ? `★ ${preset.name}` : preset.name;
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

export async function applyPresetFromSidebar(id: string) {
	// No device gate — presets apply to in-memory state. When a device is
	// present we use its config, otherwise we fall back to the default
	// 8-band layout. Syncing later writes the pre-tuned state to hardware.
	const cfg = getActiveConfig();
	const maxFilters = cfg?.maxFilters ?? DEFAULT_FREQS.length;
	const defaultFreqs = cfg?.defaultFreqs ?? DEFAULT_FREQS;
	const preset = getAllPresets().find((p) => p.id === id);
	if (!preset) return;
	if (isDirty(getActiveSlot())) {
		const ok = await confirmModal(
			`Slot ${getActiveSlot()} has unsaved edits. Loading "${preset.name}" will overwrite them.`,
			{ title: "Load preset?", confirmLabel: "Load preset", cancelLabel: "Keep" },
		);
		if (!ok) return;
	}
	snapshot();
	const targetBands = applyPreset(preset, maxFilters, defaultFreqs);
	morphToBands(targetBands, {
		onStep: () => renderUI(getEqState()),
		onDone: () => {
			if (typeof preset.preamp === "number" && !cfg?.autoGlobalGain) {
				setGlobalGain(preset.preamp);
			}
			// Feature 4 — record the preset's values as the "changed vs preset"
			// baseline so subsequent edits decorate their bands with the dot.
			setLoadedPresetSnapshot(getEqState());
			saveSession({ selectedPresetId: preset.id });
			renderPresetSidebar(
				(document.getElementById("presetSearch") as HTMLInputElement | null)?.value ??
					"",
			);
			renderUI(getEqState());
			updateHistoryButtons();
			if (cfg) persistProfile(cfg.key);
			log(
				cfg
					? `Loaded preset: ${preset.name}. Sync to apply.`
					: `Loaded preset: ${preset.name}. Connect a device to apply.`,
			);
		},
	});
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
	saveSession({ activeSlot: slot });
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

// JDS pivot — generic anchored confirm popover. Used by the flash-write
// flow and by the factory-reset action in Device Settings. Resolves true
// on confirm, false on cancel / Escape / outside-click.
export function confirmPopover(opts: {
	anchor: HTMLElement;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
}): Promise<boolean> {
	const { anchor, message } = opts;
	const confirmLabel = opts.confirmLabel ?? "Confirm";
	const cancelLabel = opts.cancelLabel ?? "Cancel";
	return new Promise((resolve) => {
		const pop = document.createElement("div");
		pop.className = "popover";
		pop.setAttribute("role", "dialog");
		pop.setAttribute("aria-label", confirmLabel);

		const msg = document.createElement("div");
		msg.textContent = message;
		msg.style.fontSize = "12px";
		msg.style.color = "var(--color-text-1)";
		msg.style.marginBottom = "10px";
		msg.style.maxWidth = "260px";
		pop.appendChild(msg);

		const row = document.createElement("div");
		row.style.display = "flex";
		row.style.gap = "8px";
		row.style.justifyContent = "flex-end";

		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "btn-ghost";
		cancel.textContent = cancelLabel;

		const confirm = document.createElement("button");
		confirm.type = "button";
		confirm.className = "btn-primary";
		confirm.textContent = confirmLabel;

		row.append(cancel, confirm);
		pop.appendChild(row);

		document.body.appendChild(pop);
		const rect = anchor.getBoundingClientRect();
		const w = pop.offsetWidth;
		const h = pop.offsetHeight;
		const left = Math.max(
			8,
			Math.min(window.innerWidth - w - 8, rect.right - w),
		);
		// Prefer to float above the anchor; flip below if there's no room.
		let top = rect.top - h - 8;
		if (top < 8) top = Math.min(window.innerHeight - h - 8, rect.bottom + 8);
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
		setTimeout(() => confirm.focus(), 0);
	});
}

// Variant of confirmPopover that includes a single checkbox (e.g. "Refine
// (tier B)" for the AutoEQ popover). Resolves with `{ confirmed, checked }`.
// Kept separate from `confirmPopover` so existing boolean-only call sites
// don't need to branch on the return shape.
export function confirmPopoverWithCheckbox(opts: {
	anchor: HTMLElement;
	message: string;
	checkboxLabel: string;
	checkboxDefault?: boolean;
	confirmLabel?: string;
	cancelLabel?: string;
}): Promise<{ confirmed: boolean; checked: boolean }> {
	const { anchor, message, checkboxLabel } = opts;
	const confirmLabel = opts.confirmLabel ?? "Confirm";
	const cancelLabel = opts.cancelLabel ?? "Cancel";
	const defaultChecked = opts.checkboxDefault !== false;
	return new Promise((resolve) => {
		const pop = document.createElement("div");
		pop.className = "popover";
		pop.setAttribute("role", "dialog");
		pop.setAttribute("aria-label", confirmLabel);

		const msg = document.createElement("div");
		msg.textContent = message;
		msg.style.fontSize = "12px";
		msg.style.color = "var(--color-text-1)";
		msg.style.marginBottom = "10px";
		msg.style.maxWidth = "260px";
		pop.appendChild(msg);

		const cbRow = document.createElement("label");
		cbRow.style.display = "flex";
		cbRow.style.alignItems = "center";
		cbRow.style.gap = "6px";
		cbRow.style.fontSize = "11px";
		cbRow.style.color = "var(--color-text-2)";
		cbRow.style.marginBottom = "10px";
		cbRow.style.cursor = "pointer";
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.checked = defaultChecked;
		const cbText = document.createElement("span");
		cbText.textContent = checkboxLabel;
		cbRow.append(cb, cbText);
		pop.appendChild(cbRow);

		const row = document.createElement("div");
		row.style.display = "flex";
		row.style.gap = "8px";
		row.style.justifyContent = "flex-end";

		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "btn-ghost";
		cancel.textContent = cancelLabel;

		const confirm = document.createElement("button");
		confirm.type = "button";
		confirm.className = "btn-primary";
		confirm.textContent = confirmLabel;

		row.append(cancel, confirm);
		pop.appendChild(row);

		document.body.appendChild(pop);
		const rect = anchor.getBoundingClientRect();
		const w = pop.offsetWidth;
		const h = pop.offsetHeight;
		const left = Math.max(
			8,
			Math.min(window.innerWidth - w - 8, rect.right - w),
		);
		let top = rect.top - h - 8;
		if (top < 8) top = Math.min(window.innerHeight - h - 8, rect.bottom + 8);
		pop.style.left = `${left}px`;
		pop.style.top = `${top}px`;

		let settled = false;
		function finish(confirmed: boolean) {
			if (settled) return;
			settled = true;
			document.removeEventListener("mousedown", onOutside, true);
			document.removeEventListener("keydown", onKey, true);
			const checked = cb.checked;
			pop.remove();
			resolve({ confirmed, checked });
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
		setTimeout(() => confirm.focus(), 0);
	});
}

// Thin wrapper that preserves the previous flash-write caller's API.
function confirmFlashPopover(anchor: HTMLElement): Promise<boolean> {
	return confirmPopover({
		anchor,
		message: "Write to device flash? This persists across power cycles.",
		confirmLabel: "Confirm write",
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

// Loose device fingerprint used for auto-reconnect disambiguation. No
// serial number — we treat vendor+product+productName as sufficient.
function deviceKey(device: HIDDevice): string {
	const vid = device.vendorId ?? 0;
	const pid = device.productId ?? 0;
	const name = device.productName ?? "";
	return `${vid.toString(16)}:${pid.toString(16)}:${name}`;
}

export async function connectToDevice(
	preselected?: HIDDevice,
	opts: { silent?: boolean } = {},
) {
	try {
		let device: HIDDevice | undefined = preselected;
		if (!device) {
			const devices = await navigator.hid.requestDevice({
				filters: allVendorFilters(),
			});
			if (devices.length === 0) return;
			device = devices[0];
		}
		if (!device.opened) await device.open();
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

		// Remember this device for auto-reconnect on next boot.
		saveSession({ lastDeviceKey: deviceKey(device) });

		renderUI(getEqState());
		refreshDeviceInfoUI();

		if (cfg.supportsReadback) {
			setupListener(device);
			await readDeviceParams(device);
		} else {
			log(
				`Note: read-back is not yet implemented for ${cfg.label}. Shown values are defaults, not the device's current state.`,
			);
		}
	} catch (err) {
		if (!opts.silent) log(`Error: ${(err as Error).message}`);
	}
}

// Silent auto-reconnect. Uses `navigator.hid.getDevices()` which only
// returns devices the user has already granted permission to, so no
// chooser prompt is shown. Any failure mode (unsupported browser, no
// matches, permission revoked, open() throws) is a silent no-op EXCEPT
// the "nothing to reconnect to" case which logs a one-line hint so the
// user knows we tried and why nothing happened.
export async function autoReconnectDevice() {
	// Respect the user's preference — skip entirely if auto-reconnect is off.
	if (!getSession().autoReconnect) return;
	try {
		if (typeof navigator === "undefined" || !navigator.hid) return;
		const devices = await navigator.hid.getDevices();
		if (!devices || devices.length === 0) {
			log(
				"Auto-reconnect: no authorized device available. Click Connect.",
			);
			return;
		}

		const filters = allVendorFilters();
		const vendorSet = new Set(
			filters.map((f) => f.vendorId).filter((v): v is number => typeof v === "number"),
		);

		const matches = devices.filter((d) => vendorSet.has(d.vendorId));
		if (matches.length === 0) {
			log(
				"Auto-reconnect: no authorized device available. Click Connect.",
			);
			return;
		}

		let picked: HIDDevice;
		if (matches.length === 1) {
			picked = matches[0];
		} else {
			const saved = getSession().lastDeviceKey;
			picked =
				(saved && matches.find((d) => deviceKey(d) === saved)) || matches[0];
		}

		await connectToDevice(picked, { silent: true });
		if (getDevice() === picked) {
			log(`Auto-reconnected to ${picked.productName ?? "device"}.`);
		} else {
			log(
				"Auto-reconnect: no authorized device available. Click Connect.",
			);
		}
	} catch {
		// Silent: permission may have been revoked, or the browser doesn't
		// support the API. Leaving the user disconnected is the safe default.
	}
}

/**
 * Restore UI chrome from the persisted session and kick off a silent
 * auto-reconnect attempt. Must run AFTER initState() so DOM elements and
 * wiring exist; uses the existing setters so state broadcasts fire and
 * listeners paint consistently.
 */
export function initSession() {
	const s = getSession();

	// Restore EQ enabled flag.
	setEqEnabled(s.eqEnabled);
	const eqBtn = document.getElementById("btnDisableEq");
	const eqSw = document.getElementById("eqEnabledSwitch") as HTMLInputElement | null;
	if (eqSw) eqSw.checked = s.eqEnabled;
	if (eqBtn) eqBtn.textContent = s.eqEnabled ? "Disable EQ" : "Enable EQ";

	// Restore nav tab — simulate a click on the right tab so wireNavTabs'
	// internal state (devicePane creation) stays the source of truth.
	if (s.navTab === "device") {
		const devBtn =
			document.getElementById("navTabDevice") ??
			document.getElementById("tabDevice");
		(devBtn as HTMLElement | null)?.click();
	}

	// Restore bottom-panel tab the same way.
	if (s.bottomPanelTab === "preamp") {
		document.getElementById("tabPreamp")?.click();
	}

	// Restore log tray expanded state.
	if (s.logTrayExpanded) {
		const tray = document.getElementById("logTray");
		if (tray && !tray.classList.contains("expanded")) {
			tray.classList.add("expanded");
			tray.setAttribute("aria-expanded", "true");
			const caret = document.getElementById("logTrayCaret");
			if (caret) caret.textContent = "▾";
			document.getElementById("logConsole")?.classList.remove("hidden");
		}
	}

	// Restore active slot. Only flip if it differs from the in-memory
	// default so we don't log a spurious "Switched to slot A" on boot.
	if (s.activeSlot === "B") {
		setActiveSlot("B");
		updateGlobalGainUI(getGlobalGainState());
		renderUI(getEqState());
		updateSlotUI();
	}

	// Restore selected preset highlight (but don't re-apply the preset —
	// EQ state is restored separately via persistProfile).
	if (s.selectedPresetId) {
		const all = getAllPresets();
		if (!all.some((p) => p.id === s.selectedPresetId)) {
			// Saved preset was deleted or otherwise unavailable; clear silently.
			saveSession({ selectedPresetId: null });
		} else {
			renderPresetSidebar();
		}
	}

	// Kick off auto-reconnect — fire-and-forget; any failure is silent.
	void autoReconnectDevice();
}

export async function resetToDefaults() {
	const ok = await confirmModal(
		"Reset all bands to Defaults (0 dB, Q=0.75) and optimal frequencies?",
		{ title: "Reset EQ", confirmLabel: "Reset" },
	);
	if (!ok) return;

	log("Resetting to factory defaults...");

	snapshot();
	const defaults = defaultEqState(getActiveConfig());
	await new Promise<void>((resolve) => {
		morphToBands(defaults, {
			onStep: () => renderUI(getEqState()),
			onDone: () => {
				setGlobalGain(0);
				// Feature 4 — no preset is the baseline after a factory reset, so
				// the "changed vs preset" dots stay suppressed until the user
				// loads one.
				setLoadedPresetSnapshot(null);
				renderUI(getEqState());
				updateHistoryButtons();
				resolve();
			},
		});
	});

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
	setLoadedPresetSnapshot(getEqState());
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

// Preset action bar — Update / Save As New / Get link / Delete. Now
// backed by the user-preset layer in presets.ts; built-ins remain
// read-only with a toast pointing the user at Save As New.
function wirePresetActionBar() {
	document
		.getElementById("btnUpdatePreset")
		?.addEventListener("click", () => handleUpdatePreset());

	document
		.getElementById("btnSaveAsNew")
		?.addEventListener("click", () => handleSaveAsNew());

	document
		.getElementById("btnGetLink")
		?.addEventListener("click", () => shareCurrentEqLink());

	document
		.getElementById("btnPresetDelete")
		?.addEventListener("click", () => handleDeletePreset());
	// Dual-wire the current index.html ID (#btnDeletePreset) until the HTML
	// agent lands the contract rename to #btnPresetDelete.
	document
		.getElementById("btnDeletePreset")
		?.addEventListener("click", () => handleDeletePreset());
}

// Public so main.ts' dynamic-import fallback can locate them by name, and
// so the static call from wirePresetActionBar resolves without a round trip.
export function handleSaveAsNew() {
	const name = window.prompt("Name this preset:");
	if (!name) return;
	const trimmed = name.trim();
	if (!trimmed) return;
	const preset = addUserPreset({
		name: trimmed,
		description: "Saved from current EQ",
		bands: eqToPresetBands(getEqState()),
		preamp: getGlobalGainState(),
	});
	saveSession({ selectedPresetId: preset.id });
	// After saving, the current EQ IS the preset baseline — suppress dots
	// until the user edits again. Same principle for Update Preset below.
	setLoadedPresetSnapshot(getEqState());
	renderPresetSidebar(
		(document.getElementById("presetSearch") as HTMLInputElement | null)?.value ??
			"",
	);
	renderUI(getEqState());
	toast(`Preset saved: ${preset.name}`);
	log(`Saved preset "${preset.name}".`);
}

export function handleUpdatePreset() {
	const selectedId = getSession().selectedPresetId;
	if (!selectedId || !isUserPresetId(selectedId)) {
		toast("Cannot modify built-in preset — use Save As New");
		return;
	}
	const updated = updateUserPreset(selectedId, {
		bands: eqToPresetBands(getEqState()),
		preamp: getGlobalGainState(),
	});
	if (!updated) {
		toast("Preset not found");
		return;
	}
	setLoadedPresetSnapshot(getEqState());
	renderPresetSidebar(
		(document.getElementById("presetSearch") as HTMLInputElement | null)?.value ??
			"",
	);
	renderUI(getEqState());
	toast(`Updated: ${updated.name}`);
	log(`Updated preset "${updated.name}".`);
}

export function handleDeletePreset() {
	const selectedId = getSession().selectedPresetId;
	if (!selectedId || !isUserPresetId(selectedId)) {
		toast("Only user presets can be deleted");
		return;
	}
	const ok = deleteUserPreset(selectedId);
	if (!ok) {
		toast("Preset not found");
		return;
	}
	saveSession({ selectedPresetId: null });
	renderPresetSidebar(
		(document.getElementById("presetSearch") as HTMLInputElement | null)?.value ??
			"",
	);
	toast("Preset deleted");
	log("Deleted user preset.");
}

// Re-export so main.ts' `callFnHandler(handleGetLink, ...)` keeps working.
export function handleGetLink() {
	void shareCurrentEqLink();
}

// Feature 7/8 — view-toggle buttons in the preset action bar. Each flips
// a session flag, persists it, then repaints the canvas. Kept grouped so
// the user sees "these three buttons control what you see on the graph".
export function toggleAbOverlay() {
	const current = getSession().abOverlay;
	const next: "auto" | "hidden" = current === "hidden" ? "auto" : "hidden";
	saveSession({ abOverlay: next });
	renderUI(getEqState());
	toast(next === "hidden" ? "A/B overlay hidden" : "A/B overlay shown");
}

export function toggleDelta() {
	const next = !getSession().showDelta;
	saveSession({ showDelta: next });
	renderUI(getEqState());
	toast(next ? "Δ line on" : "Δ line off");
}

export function togglePhaseView() {
	const next = !getSession().showPhase;
	saveSession({ showPhase: next });
	renderUI(getEqState());
	toast(next ? "Phase view on" : "Phase view off");
}

// Keep the three toggle buttons' visual state (pressed / not pressed) in
// sync with session flags. Called at the end of every renderUI so session
// writes from other code paths (e.g. command palette later) still paint.
function syncViewToggleButtons() {
	const s = getSession();
	const setPressed = (id: string, on: boolean) => {
		const el = document.getElementById(id);
		if (!el) return;
		el.classList.toggle("toggle-on", on);
		el.setAttribute("aria-pressed", on ? "true" : "false");
	};
	setPressed("btnToggleAbOverlay", s.abOverlay !== "hidden");
	setPressed("btnToggleDelta", !!s.showDelta);
	setPressed("btnTogglePhase", !!s.showPhase);
	// Spectrum button paints from live state (not session): we only show
	// the "active" indicator if the analyser is actually running. On cold
	// start spectrumSource may be e.g. "mic" but we never auto-start
	// (capture needs a user gesture), so the button remains in resume
	// mode until the user clicks.
	const spectrumBtn = document.getElementById("btnToggleSpectrum");
	if (spectrumBtn) {
		const last = s.spectrumSource;
		spectrumBtn.setAttribute(
			"title",
			last === "off"
				? "Live audio spectrum"
				: `Live audio spectrum (last: ${last}) — click to start`,
		);
	}
	// Feature 10 — AutoEQ button only lights up when both a target AND a
	// measurement are loaded (needed to compute the error vector).
	const autoEqBtn = document.getElementById("btnAutoEq") as HTMLButtonElement | null;
	if (autoEqBtn) {
		const ready = !!getTarget() && !!getMeasurement();
		autoEqBtn.disabled = !ready;
		autoEqBtn.setAttribute(
			"title",
			ready
				? "Fit bands to target − measurement"
				: "Load a target AND a measurement to enable AutoEQ",
		);
	}
	// Feature 9 — update the export button's tooltip with the last-used
	// format so the click-main-action path doesn't feel like a black box.
	const exportBtn = document.getElementById("btnExport");
	if (exportBtn) {
		const label = EXPORT_FORMAT_LABELS[s.exportFormat];
		exportBtn.setAttribute(
			"title",
			`Export as ${label} (click to change format)`,
		);
	}
}

function wireViewToggles() {
	document
		.getElementById("btnToggleAbOverlay")
		?.addEventListener("click", () => toggleAbOverlay());
	document
		.getElementById("btnToggleDelta")
		?.addEventListener("click", () => toggleDelta());
	document
		.getElementById("btnTogglePhase")
		?.addEventListener("click", () => togglePhaseView());
	document
		.getElementById("btnToggleSpectrum")
		?.addEventListener("click", (e) => {
			const anchor = e.currentTarget as HTMLElement;
			handleSpectrumToggleClick(anchor);
		});
}

// Feature A — spectrum toggle. Active → stop. Inactive → open a popover
// listing sources. The actual capture work lives in spectrum.ts; this
// handler is purely UI orchestration + session persistence.
async function handleSpectrumToggleClick(anchor: HTMLElement) {
	const { isSpectrumActive, startSpectrum, stopSpectrum, listAudioInputDevices } =
		await import("./spectrum.ts");
	const { startSpectrumLoop, stopSpectrumLoop } = await import("./peq.ts");

	if (isSpectrumActive()) {
		stopSpectrum();
		stopSpectrumLoop();
		setSpectrumButtonActive(false);
		saveSession({ spectrumSource: "off" });
		return;
	}

	openSpectrumPicker(anchor, async (choice, file) => {
		try {
			if (choice === "virtual") {
				const devices = await listAudioInputDevices();
				if (devices.length === 0) {
					toast("No audio input devices found.");
					return;
				}
				const picked = await openDevicePicker(anchor, devices);
				if (!picked) return;
				await startSpectrum("virtual", { deviceId: picked });
			} else if (choice === "file") {
				if (!file) return;
				await startSpectrum("file", { file });
			} else {
				await startSpectrum(choice);
			}
			startSpectrumLoop();
			setSpectrumButtonActive(true);
			saveSession({ spectrumSource: choice });
			log(`Spectrum source: ${choice}`);
		} catch (err) {
			toast("Audio source not available.");
			log(`Spectrum start failed: ${(err as Error).message}`);
		}
	});
}

function setSpectrumButtonActive(active: boolean) {
	const btn = document.getElementById("btnToggleSpectrum");
	if (!btn) return;
	btn.classList.toggle("toggle-on", active);
	btn.classList.toggle("spectrum-active", active);
	btn.setAttribute("aria-pressed", active ? "true" : "false");
}

interface SpectrumPickerOption {
	id: "tab" | "system" | "mic" | "virtual" | "file";
	label: string;
	hint: string;
}

function openSpectrumPicker(
	anchor: HTMLElement,
	onPick: (
		choice: "tab" | "system" | "mic" | "virtual" | "file",
		file?: File,
	) => void,
) {
	const existing = document.getElementById("spectrumPicker");
	if (existing) {
		existing.remove();
		return;
	}
	const options: SpectrumPickerOption[] = [
		{ id: "tab", label: "Tab audio", hint: "Capture a specific tab (all platforms)" },
		{ id: "system", label: "System audio", hint: "Chrome / Windows only" },
		{ id: "mic", label: "Microphone", hint: "Ambient room sound" },
		{
			id: "virtual",
			label: "Virtual device",
			hint: "BlackHole / VB-Cable (required on macOS)",
		},
		{ id: "file", label: "File…", hint: "Drop or pick an audio file" },
	];

	const menu = document.createElement("div");
	menu.id = "spectrumPicker";
	menu.className = "export-menu spectrum-picker";
	menu.setAttribute("role", "menu");
	const rect = anchor.getBoundingClientRect();
	menu.style.position = "fixed";
	menu.style.top = `${rect.bottom + 4}px`;
	menu.style.left = `${rect.left}px`;
	menu.style.zIndex = "1000";

	for (const opt of options) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "export-menu-item spectrum-picker-item";
		const title = document.createElement("div");
		title.className = "spectrum-picker-title";
		title.textContent = opt.label;
		const hint = document.createElement("div");
		hint.className = "spectrum-picker-hint";
		hint.textContent = opt.hint;
		item.append(title, hint);
		item.addEventListener("click", () => {
			menu.remove();
			if (opt.id === "file") {
				const input = document.createElement("input");
				input.type = "file";
				input.accept = "audio/*";
				input.addEventListener("change", () => {
					const file = input.files?.[0];
					if (file) onPick("file", file);
				});
				input.click();
			} else {
				onPick(opt.id);
			}
		});
		menu.appendChild(item);
	}
	document.body.appendChild(menu);

	const closeOnOutside = (ev: MouseEvent) => {
		if (!menu.contains(ev.target as Node) && ev.target !== anchor) {
			menu.remove();
			document.removeEventListener("mousedown", closeOnOutside);
		}
	};
	setTimeout(() => document.addEventListener("mousedown", closeOnOutside), 0);
}

function openDevicePicker(
	anchor: HTMLElement,
	devices: MediaDeviceInfo[],
): Promise<string | null> {
	return new Promise((resolve) => {
		const existing = document.getElementById("spectrumDevicePicker");
		if (existing) existing.remove();
		const menu = document.createElement("div");
		menu.id = "spectrumDevicePicker";
		menu.className = "export-menu spectrum-picker";
		const rect = anchor.getBoundingClientRect();
		menu.style.position = "fixed";
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.left = `${rect.left}px`;
		menu.style.zIndex = "1000";
		let resolved = false;
		for (const d of devices) {
			const item = document.createElement("button");
			item.type = "button";
			item.className = "export-menu-item";
			item.textContent = d.label || `Input ${d.deviceId.slice(0, 6)}`;
			item.addEventListener("click", () => {
				resolved = true;
				menu.remove();
				resolve(d.deviceId);
			});
			menu.appendChild(item);
		}
		document.body.appendChild(menu);
		const closeOnOutside = (ev: MouseEvent) => {
			if (!menu.contains(ev.target as Node)) {
				menu.remove();
				document.removeEventListener("mousedown", closeOnOutside);
				if (!resolved) resolve(null);
			}
		};
		setTimeout(() => document.addEventListener("mousedown", closeOnOutside), 0);
	});
}

// Feature D — ABX button wiring. Click → opens modal. After each run
// the score persists into session.lastAbxScore and the subtitle updates.
function wireAbxButton() {
	document
		.getElementById("btnAbx")
		?.addEventListener("click", () => openAbxModal());
}

function paintAbxSubtitle() {
	const el = document.getElementById("btnAbxScore");
	if (!el) return;
	const score = getSession().lastAbxScore;
	if (!score) {
		el.textContent = "";
		return;
	}
	el.textContent = `${score.correct}/${score.rounds} (p=${score.pValue.toFixed(2)})`;
}

async function openAbxModal() {
	const abx = await import("./abx.ts");
	const slotA = getEqState();
	const slotB = getInactiveEq();
	if (slotA.length === 0 || slotB.length === 0) {
		toast("Both slots need bands to ABX.");
		return;
	}

	const totalRounds = 10;
	let roundIdx = 0;
	let correct = 0;
	let currentRound: ReturnType<typeof abx.createRound> | null = null;
	let answered = false;

	const content = document.createElement("div");
	content.className = "abx-modal";

	const progress = document.createElement("div");
	progress.className = "abx-progress";
	const status = document.createElement("div");
	status.className = "abx-result";
	status.textContent = "Click Start to begin a 10-round blind comparison of slots A and B.";

	const controls = document.createElement("div");
	controls.className = "abx-controls";

	const btnStart = makeBtn("Start");
	const btnPlayX = makeBtn("Play X");
	const btnA = makeBtn("A");
	const btnB = makeBtn("B");
	const btnNext = makeBtn("Next");
	[btnPlayX, btnA, btnB, btnNext].forEach((b) => (b.disabled = true));
	controls.append(btnStart, btnPlayX, btnA, btnB, btnNext);

	content.append(progress, status, controls);

	const dialog = customModal("ABX blind test", content, { cancelLabel: "Close" });
	dialog.addEventListener("close", () => abx.stopAbxPlayback());

	function makeBtn(label: string): HTMLButtonElement {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "btn-outline";
		b.textContent = label;
		return b;
	}

	function refreshProgress() {
		progress.textContent = `Round ${Math.min(roundIdx + 1, totalRounds)} of ${totalRounds} · Correct: ${correct}`;
	}

	function startNewRound() {
		if (roundIdx >= totalRounds) {
			finish();
			return;
		}
		answered = false;
		currentRound = abx.createRound(slotA, slotB, "pink");
		// Auto-play X so the user immediately hears the round's stimulus.
		void currentRound.playX();
		btnPlayX.disabled = false;
		btnA.disabled = false;
		btnB.disabled = false;
		btnNext.disabled = true;
		btnStart.disabled = true;
		status.textContent = "Listening to X. Pick A or B.";
		refreshProgress();
	}

	function answer(choice: "A" | "B") {
		if (!currentRound || answered) return;
		answered = true;
		const isCorrect = currentRound.x === choice;
		if (isCorrect) correct++;
		status.textContent = `${isCorrect ? "Correct" : "Wrong"} — X was ${currentRound.x}.`;
		btnA.disabled = true;
		btnB.disabled = true;
		btnNext.disabled = false;
		refreshProgress();
	}

	function finish() {
		abx.stopAbxPlayback();
		const result = abx.computeAbxResult(correct, totalRounds);
		const significant = result.pValue < 0.05;
		const interp = significant
			? `Significant difference detected (p < 0.05).`
			: `No reliable difference (p = ${result.pValue.toFixed(3)}).`;
		status.innerHTML = `<div>Final: <strong>${result.correct} / ${result.rounds}</strong></div><div class="abx-significance">${interp}</div>`;
		btnStart.textContent = "Run again";
		btnStart.disabled = false;
		[btnPlayX, btnA, btnB, btnNext].forEach((b) => (b.disabled = true));
		saveSession({ lastAbxScore: result });
		paintAbxSubtitle();
	}

	btnStart.addEventListener("click", () => {
		roundIdx = 0;
		correct = 0;
		startNewRound();
	});
	btnPlayX.addEventListener("click", () => currentRound?.playX());
	btnA.addEventListener("click", () => {
		void currentRound?.playA();
		// Allow A/B preview even after answer — only the first answer counts.
		if (!answered) answer("A");
	});
	btnB.addEventListener("click", () => {
		void currentRound?.playB();
		if (!answered) answer("B");
	});
	btnNext.addEventListener("click", () => {
		roundIdx++;
		startNewRound();
	});

	refreshProgress();
}

// Feature 9 — export format dispatcher. Click main button → download with
// last-used format. Click arrow button → open popover to pick a new
// format; picking downloads immediately AND persists the choice.
export function handleExportClick() {
	const fmt = getSession().exportFormat;
	runExport(fmt);
}

function runExport(format: ExportFormat) {
	try {
		const payload = exportAs(format);
		downloadPayload(payload);
		saveSession({ exportFormat: format });
		syncViewToggleButtons();
		toast(`Exported as ${EXPORT_FORMAT_LABELS[format]}`);
		log(`Exported ${payload.filename} (${EXPORT_FORMAT_LABELS[format]}).`);
	} catch (err) {
		log(`Export failed: ${(err as Error).message}`);
		toast("Export failed");
	}
}

// Floating menu anchored under the arrow button. Vanilla DOM (no popover
// lib). Click-outside and Esc close it. Selecting an item triggers the
// download + persists the choice.
function openExportMenu(anchor: HTMLElement) {
	const existing = document.getElementById("exportMenu");
	if (existing) {
		existing.remove();
		return;
	}
	const menu = document.createElement("div");
	menu.id = "exportMenu";
	menu.className = "export-menu";
	const rect = anchor.getBoundingClientRect();
	menu.style.position = "fixed";
	menu.style.top = `${rect.bottom + 4}px`;
	menu.style.right = `${window.innerWidth - rect.right}px`;
	menu.style.zIndex = "1000";

	const formats: ExportFormat[] = [
		"json",
		"rew",
		"eapo",
		"wavelet",
		"camilla",
		"peace",
	];
	for (const fmt of formats) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "export-menu-item";
		item.textContent = EXPORT_FORMAT_LABELS[fmt];
		item.addEventListener("click", () => {
			menu.remove();
			runExport(fmt);
		});
		menu.appendChild(item);
	}
	document.body.appendChild(menu);

	// Dismiss on Esc or click-outside.
	const dismiss = (e: Event) => {
		if (e instanceof KeyboardEvent && e.key !== "Escape") return;
		if (
			e instanceof MouseEvent &&
			(menu.contains(e.target as Node) || anchor.contains(e.target as Node))
		)
			return;
		menu.remove();
		document.removeEventListener("click", dismiss);
		document.removeEventListener("keydown", dismiss);
	};
	// Defer so the click that opened the menu doesn't close it.
	setTimeout(() => {
		document.addEventListener("click", dismiss);
		document.addEventListener("keydown", dismiss);
	}, 0);
}

function wireExportMenu() {
	const main = document.getElementById("btnExport");
	if (main) {
		main.addEventListener("click", () => handleExportClick());
	}
	const arrow = document.getElementById("btnExportMenu");
	if (arrow) {
		arrow.addEventListener("click", (e) => {
			e.stopPropagation();
			openExportMenu(arrow);
		});
	}
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

		// Feature 6 — try the Web Share API first on supporting platforms
		// (iOS Safari, Android Chrome, some desktop Chromium builds). Users
		// get the native share sheet, which routes to Messages/Mail/etc.
		// A plain clipboard copy is the fallback on desktops without it.
		if (typeof navigator.share === "function") {
			try {
				await navigator.share({ title: "DDPEC preset", url });
				toast("Share sheet opened");
				log(`Share sheet invoked (${b64.length} chars).`);
				return;
			} catch (err) {
				// AbortError = user dismissed the sheet; stay silent.
				if ((err as DOMException)?.name === "AbortError") return;
				// Any other failure (permissions, unsupported scheme) falls
				// through to the clipboard path below so the user still
				// gets a link somewhere useful.
			}
		}

		await navigator.clipboard.writeText(url);
		toast("Link copied");
		log(`Share link generated (${b64.length} chars).`);
	} catch (err) {
		log(`Share link failed: ${(err as Error).message}`);
		toast("Could not copy share link");
	}
}

// Sidebar "Disable EQ" button. Mirrors the bottom `#eqEnabledSwitch`
// checkbox so the two surfaces stay in sync.
//
// JDS pivot 2026-04-17: toggling now actually bypasses the EQ stack:
//  - dsp.ts `writeBand` writes gain=0 for every band when bypassed.
//  - peq.ts renders the curve in muted color + 0 dB reference line.
//  - When a device is connected, we auto-sync so the new bypass state
//    reaches the hardware immediately (no extra Sync click needed).
// Shared apply-logic for any surface that flips EQ bypass. Requeries the
// DOM on each call so callers without captured refs (Space-bar handler in
// main.ts) can trigger the exact same UI + device + session side effects.
// Order matters: flip the session flag first so the repaint sees the new
// state, then paint the button/switch, then repaint the canvas + toast,
// then fire the auto-sync if a device is attached.
async function applyEqBypassSideEffects() {
	const on = isEqEnabled();
	const btn = document.getElementById("btnDisableEq") as HTMLButtonElement | null;
	const sw = document.getElementById("eqEnabledSwitch") as HTMLInputElement | null;
	if (sw && sw.checked !== on) sw.checked = on;
	if (btn) btn.textContent = on ? "Disable EQ" : "Enable EQ";
	saveSession({ eqEnabled: on });
	renderUI(getEqState()); // repaint canvas with muted / live colors
	toast(on ? "EQ enabled" : "EQ bypassed");
	// Auto-flush to device so the new bypass state takes effect.
	if (getDevice()) {
		try {
			await syncToDevice();
			markSynced(getActiveSlot());
		} catch (err) {
			log(`Auto-sync after EQ toggle failed: ${(err as Error).message}`);
		}
	}
}

// Flip the global EQ-enabled flag and run the shared side effects. Exported
// so the keyboard shortcut in main.ts (Space) can share the same code path
// as the sidebar button and bottom switch.
export function toggleEqBypass() {
	setEqEnabled(!isEqEnabled());
	void applyEqBypassSideEffects();
}

// Feature 10 — AutoEQ one-click fit. Pops an anchored confirm popover with
// a "Refine (tier B)" checkbox (default on). On confirm, computes a fresh
// band set from `target − measurement` error and replaces the active slot's
// EQ with it. History snapshot captures the pre-fit bands so undo works.
export async function handleAutoEq() {
	const target = getTarget();
	const measurement = getMeasurement();
	if (!target || !measurement) {
		toast("Load a target + measurement first");
		return;
	}
	const anchor = document.getElementById("btnAutoEq") as HTMLElement | null;
	// Fall back to a generic confirm modal when the button isn't in the DOM
	// (e.g. command-palette-only invocation on some future layout variant).
	let confirmed = false;
	let tierB = true;
	if (anchor) {
		const result = await confirmPopoverWithCheckbox({
			anchor,
			message: "Fit bands to target − measurement?",
			checkboxLabel: "Refine (tier B)",
			checkboxDefault: true,
			confirmLabel: "Run AutoEQ",
		});
		confirmed = result.confirmed;
		tierB = result.checked;
	} else {
		confirmed = await confirmModal(
			"Fit bands to target − measurement? This replaces your current bands.",
			{ title: "AutoEQ", confirmLabel: "Run AutoEQ" },
		);
	}
	if (!confirmed) return;

	// Lazy-import so the autofit module loads only when AutoEQ actually runs
	// — keeps the initial-paint bundle lean.
	const autofit = await import("./autofit.ts");
	const currentBands = getEqState();
	const before = autofit.fitMse(target, measurement, currentBands);
	const cap = getBandCountCap();
	const newBands = autofit.autoFitBands(target, measurement, currentBands, {
		tierB,
		maxBands: cap.max,
	});
	const after = autofit.fitMse(target, measurement, newBands);

	snapshot();
	await new Promise<void>((resolve) => {
		morphToBands(newBands, {
			onStep: () => renderUI(getEqState()),
			onDone: () => {
				renderUI(getEqState());
				updateHistoryButtons();
				resolve();
			},
		});
	});
	const cfg = getActiveConfig();
	if (cfg) persistProfile(cfg.key);

	// Auto-sync to device if one is connected so the user hears the fit
	// immediately without a second click.
	if (getDevice()) {
		try {
			await syncToDevice();
			markSynced(getActiveSlot());
		} catch (err) {
			log(`Auto-sync after AutoEQ failed: ${(err as Error).message}`);
		}
	}

	toast(
		`AutoEQ fit complete (${newBands.length} band${newBands.length === 1 ? "" : "s"}, MSE ${before.toFixed(2)} → ${after.toFixed(2)} dB²)`,
	);
	log(
		`AutoEQ: ${newBands.length} bands placed (tier ${tierB ? "A+B" : "A"}), MSE ${before.toFixed(3)} → ${after.toFixed(3)} dB².`,
	);
}

function wireEqDisable() {
	const btn = document.getElementById("btnDisableEq") as HTMLButtonElement | null;
	const sw = document.getElementById("eqEnabledSwitch") as HTMLInputElement | null;
	const paint = () => {
		const on = isEqEnabled();
		if (sw && sw.checked !== on) sw.checked = on;
		if (btn) btn.textContent = on ? "Disable EQ" : "Enable EQ";
	};
	btn?.addEventListener("click", () => toggleEqBypass());
	sw?.addEventListener("change", () => {
		// The switch drives the flag directly (not a toggle) so checking and
		// unchecking via click both reach the shared side-effect path.
		setEqEnabled(!!sw.checked);
		void applyEqBypassSideEffects();
	});
	paint();
}

// Bottom panel tabs — Tabular EQ / Preamp Gain. Preamp pane is built on
// first activation and injected next to the tabular editor; switching
// tabs toggles visibility without rebuilding.
function wireBottomPanelTabs() {
	const tab1 = document.getElementById("tabTabular");
	const tab2 = document.getElementById("tabPreamp");
	if (!tab1 || !tab2) return;

	let preampPane: HTMLElement | null = null;
	let preampValueInput: HTMLInputElement | null = null;
	let preampSlider: HTMLInputElement | null = null;
	let preampPeakHint: HTMLElement | null = null;
	// Feature 5 — warning icon span sitting next to the Pre-amp label.
	// Null until the preamp pane is first built (lazy).
	let preampClipWarn: HTMLElement | null = null;

	const getTabularParts = () => {
		const container = document.getElementById("eqContainer");
		return {
			bandEditor: container?.querySelector<HTMLElement>("#bandEditor") ?? null,
			bandEditorHeader:
				container?.querySelector<HTMLElement>("#bandEditorHeader") ?? null,
			root: container?.querySelector<HTMLElement>("#peq-root") ?? null,
		};
	};

	const recomputePeakHint = () => {
		if (!preampPeakHint) return;
		const bands = getEqState();
		let peak = 0;
		for (const b of bands) {
			if (!b.enabled) continue;
			if (b.gain > peak) peak = b.gain;
		}
		preampPeakHint.textContent = `Negative preamp headroom prevents digital clipping when boosting bands. Current peak boost: +${peak.toFixed(1)} dB.`;

		// Feature 5 — toggle the inline clipping warning. Tooltip spells
		// out the exact deficit so the user can dial the preamp to clear it.
		if (preampClipWarn) {
			const headroom = computeClippingHeadroom(bands, getGlobalGainState());
			if (headroom < 0) {
				const deficit = Math.abs(headroom).toFixed(1);
				preampClipWarn.hidden = false;
				preampClipWarn.title = `Summed band boosts exceed pre-amp headroom. Reduce gains or lower pre-amp by ${deficit} dB.`;
			} else {
				preampClipWarn.hidden = true;
				preampClipWarn.title = "";
			}
		}
	};

	const buildPreampPane = (): HTMLElement => {
		const pane = document.createElement("div");
		pane.id = "preampPane";
		pane.className = "preamp-pane";

		// Label row — text plus the Feature 5 clipping warning icon. Row
		// stays a block-level flex so the icon stays on the same baseline
		// without shifting the slider below.
		const labelRow = document.createElement("div");
		labelRow.className = "label flex items-center gap-2";
		const label = document.createElement("span");
		label.textContent = "Pre-amp Gain";
		labelRow.appendChild(label);

		const warn = document.createElement("span");
		warn.id = "preampClipWarning";
		warn.hidden = true;
		warn.setAttribute("aria-label", "Clipping warning");
		warn.style.color = "var(--color-warning, #e5b850)";
		warn.style.display = "inline-flex";
		warn.style.alignItems = "center";
		// Build the SVG via DOM methods so no innerHTML is used.
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "14");
		svg.setAttribute("height", "14");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "currentColor");
		svg.setAttribute("aria-hidden", "true");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute(
			"d",
			"M12 2 1 21h22L12 2zm0 6 7.53 13H4.47L12 8zm-1 4v4h2v-4h-2zm0 6v2h2v-2h-2z",
		);
		svg.appendChild(path);
		warn.appendChild(svg);
		labelRow.appendChild(warn);
		preampClipWarn = warn;
		pane.appendChild(labelRow);

		const value = document.createElement("input");
		value.type = "number";
		value.min = "-20";
		value.max = "10";
		value.step = "0.1";
		value.value = String(getGlobalGainState());
		value.className = "value-input";
		pane.appendChild(value);
		preampValueInput = value;

		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = "-20";
		slider.max = "10";
		slider.step = "0.1";
		slider.value = String(getGlobalGainState());
		slider.className = "wide-slider";
		pane.appendChild(slider);
		preampSlider = slider;

		const autoBtn = document.createElement("button");
		autoBtn.type = "button";
		autoBtn.className = "btn-outline";
		autoBtn.textContent = "Auto (prevent clipping)";
		pane.appendChild(autoBtn);

		const hint = document.createElement("div");
		hint.className = "hint";
		pane.appendChild(hint);
		preampPeakHint = hint;
		recomputePeakHint();

		const push = (v: number) => {
			const clamped = Math.max(-20, Math.min(10, v));
			setGlobalGain(clamped);
			if (preampValueInput) preampValueInput.value = String(clamped);
			if (preampSlider) preampSlider.value = String(clamped);
			recomputePeakHint();
			const cfg = getActiveConfig();
			if (cfg) persistProfile(cfg.key);
		};
		value.addEventListener("input", () => {
			const v = Number(value.value);
			if (Number.isFinite(v)) push(v);
		});
		slider.addEventListener("input", () => {
			const v = Number(slider.value);
			if (Number.isFinite(v)) push(v);
		});
		autoBtn.addEventListener("click", () => {
			const bands = getEqState();
			let peak = 0;
			for (const b of bands) {
				if (!b.enabled) continue;
				if (b.gain > peak) peak = b.gain;
			}
			snapshot();
			push(-Math.max(0, peak));
			updateHistoryButtons();
			toast(`Auto preamp set to ${(-Math.max(0, peak)).toFixed(1)} dB`);
		});

		return pane;
	};

	const syncPreampFromState = () => {
		const gain = getGlobalGainState();
		if (preampValueInput && document.activeElement !== preampValueInput)
			preampValueInput.value = String(gain);
		if (preampSlider && document.activeElement !== preampSlider)
			preampSlider.value = String(gain);
		recomputePeakHint();
	};

	const showTabular = () => {
		const parts = getTabularParts();
		if (parts.bandEditor) parts.bandEditor.style.display = "";
		if (parts.bandEditorHeader) parts.bandEditorHeader.style.display = "";
		if (preampPane) preampPane.style.display = "none";
	};
	const showPreamp = () => {
		const parts = getTabularParts();
		if (parts.bandEditor) parts.bandEditor.style.display = "none";
		if (parts.bandEditorHeader) parts.bandEditorHeader.style.display = "none";
		if (!preampPane) {
			preampPane = buildPreampPane();
			// Insert inside #peq-root after the canvas's parent so it shares
			// the same flex column as the tabular editor.
			const root = parts.root;
			if (root) root.appendChild(preampPane);
			else document.body.appendChild(preampPane);
		} else {
			syncPreampFromState();
		}
		preampPane.style.display = "flex";
	};

	const paint = (which: "tabular" | "preamp") => {
		tab1.classList.toggle("active", which === "tabular");
		tab2.classList.toggle("active", which === "preamp");
		tab1.setAttribute("aria-selected", String(which === "tabular"));
		tab2.setAttribute("aria-selected", String(which === "preamp"));
		if (which === "tabular") showTabular();
		else showPreamp();
	};
	tab1.addEventListener("click", () => {
		paint("tabular");
		saveSession({ bottomPanelTab: "tabular" });
	});
	tab2.addEventListener("click", () => {
		paint("preamp");
		saveSession({ bottomPanelTab: "preamp" });
	});

	// Keep the preamp pane's widgets in sync when the global gain moves
	// from elsewhere (top-bar slider, preset apply, history undo, etc.).
	document.addEventListener("ddpec:dirty-change", syncPreampFromState);
}

// Log console "Clear" button — empties #logConsole and #logTrayLatest so
// a power user can reset noisy output without reloading.
function wireLogClear() {
	const btn = document.getElementById("btnLogClear") as HTMLButtonElement | null;
	if (!btn) return;
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		const c = document.getElementById("logConsole");
		if (c) {
			// Remove every child except the Clear button itself.
			for (const child of Array.from(c.childNodes)) {
				if (child instanceof HTMLElement && child.id === "btnLogClear") continue;
				child.remove();
			}
		}
		const latest = document.getElementById("logTrayLatest");
		if (latest) latest.textContent = "";
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
		saveSession({ logTrayExpanded: tray.classList.contains("expanded") });
		paint();
	});
	tray.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			tray.classList.toggle("expanded");
			saveSession({ logTrayExpanded: tray.classList.contains("expanded") });
			paint();
		}
	});
	paint();
}

// Top nav tabs — DSP / Device Settings. The Device Settings pane is a
// real static <section id="deviceSettingsPane"> in index.html; this
// function wires its radio buttons, toggles, and action buttons.
function wireNavTabs() {
	const dspBtn =
		(document.getElementById("navTabDsp") as HTMLElement | null) ??
		document.getElementById("tabDsp");
	const devBtn =
		(document.getElementById("navTabDevice") as HTMLElement | null) ??
		document.getElementById("tabDevice");
	if (!dspBtn || !devBtn) return;
	const mainEl = document.querySelector("main") as HTMLElement | null;
	const commitBar = document.getElementById("commitBar");
	const devicePane = document.getElementById("deviceSettingsPane");

	let deviceWired = false;

	const showDsp = () => {
		dspBtn.classList.add("active");
		devBtn.classList.remove("active");
		dspBtn.setAttribute("aria-selected", "true");
		devBtn.setAttribute("aria-selected", "false");
		if (mainEl) mainEl.style.display = "";
		if (commitBar) commitBar.classList.toggle("hidden", !hasAnyDirty());
		if (devicePane) {
			devicePane.classList.add("hidden");
			devicePane.classList.remove("flex");
		}
	};
	const showDevice = () => {
		devBtn.classList.add("active");
		dspBtn.classList.remove("active");
		devBtn.setAttribute("aria-selected", "true");
		dspBtn.setAttribute("aria-selected", "false");
		if (mainEl) mainEl.style.display = "none";
		// Hide commit bar under Device Settings — it only applies to DSP.
		if (commitBar) commitBar.classList.add("hidden");
		if (devicePane) {
			devicePane.classList.remove("hidden");
			devicePane.classList.add("flex");
			if (!deviceWired) {
				wireDeviceSettingsPane();
				deviceWired = true;
			}
			refreshDeviceInfoUI();
			refreshThemeRadios();
		}
	};
	dspBtn.addEventListener("click", () => {
		showDsp();
		saveSession({ navTab: "dsp" });
	});
	devBtn.addEventListener("click", () => {
		showDevice();
		saveSession({ navTab: "device" });
	});

	// Keep the device-info block live while the pane is visible (connect /
	// disconnect happens from the top bar).
	document.addEventListener("ddpec:theme-change", refreshThemeRadios);
}

// Paint the theme radio buttons to reflect the current preference.
function refreshThemeRadios() {
	const pref = getThemePreference();
	for (const el of document.querySelectorAll<HTMLInputElement>(
		'input[name="themePref"]',
	)) {
		el.checked = el.value === pref;
	}
}

// Paint the device info rows (or empty-state) based on current connection.
function refreshDeviceInfoUI() {
	const empty = document.getElementById("deviceInfoEmpty");
	const rows = document.getElementById("deviceInfoRows");
	const name = document.getElementById("deviceInfoName");
	const ids = document.getElementById("deviceInfoIds");
	const device = getDevice();
	if (!empty || !rows) return;
	if (device) {
		empty.classList.add("hidden");
		rows.classList.remove("hidden");
		rows.classList.add("flex");
		if (name) name.textContent = device.productName ?? "(unnamed device)";
		if (ids) {
			const vid = device.vendorId?.toString(16).toUpperCase().padStart(4, "0");
			const pid = device.productId?.toString(16).toUpperCase().padStart(4, "0");
			ids.textContent = `0x${vid} / 0x${pid}`;
		}
		// #fwVersion is filled in by dsp.ts inputreport handler when readback
		// lands; nothing to do here.
	} else {
		empty.classList.remove("hidden");
		rows.classList.add("hidden");
		rows.classList.remove("flex");
	}
}

// Wire the static device-settings pane's interactive widgets. Idempotent —
// called once on first show, because child elements are real HTML not
// re-rendered.
function wireDeviceSettingsPane() {
	// Theme radio buttons.
	for (const el of document.querySelectorAll<HTMLInputElement>(
		'input[name="themePref"]',
	)) {
		el.addEventListener("change", () => {
			if (!el.checked) return;
			const v = el.value as ThemePreference;
			setTheme(v);
		});
	}

	// Auto-reconnect switch.
	const autoSw = document.getElementById(
		"autoReconnectSwitch",
	) as HTMLInputElement | null;
	if (autoSw) {
		autoSw.checked = getSession().autoReconnect;
		autoSw.addEventListener("change", () => {
			saveSession({ autoReconnect: autoSw.checked });
			toast(
				autoSw.checked
					? "Auto-reconnect enabled"
					: "Auto-reconnect disabled",
			);
		});
	}

	// Manual disconnect.
	document
		.getElementById("btnManualDisconnect")
		?.addEventListener("click", () => toggleConnection());

	// Test signals launcher.
	document
		.getElementById("btnOpenSignals")
		?.addEventListener("click", () => openSignalGenerator());

	// Factory reset — anchored confirm popover.
	const resetBtn = document.getElementById(
		"btnFactoryReset",
	) as HTMLElement | null;
	resetBtn?.addEventListener("click", async () => {
		const ok = await confirmPopover({
			anchor: resetBtn,
			message:
				"Reset slot A, slot B, and pre-amp to defaults? This cannot be undone.",
			confirmLabel: "Reset all",
		});
		if (!ok) return;
		await resetToDefaults();
	});
}

// Commit bar — hide when clean, show when any slot is dirty; mirror the
// "Preset changed" chip in the preset action bar. Subscribes to the
// dirty-change event broadcast by state.ts so we don't poll.
//
// JDS pivot 2026-04-17: stays hidden entirely while the Device Settings
// tab is active — commit actions belong to DSP view only.
function wireCommitBar() {
	const bar = document.getElementById("commitBar");
	const pendingChip = document.getElementById("pendingChangesChip");
	const changedChip = document.getElementById("presetChangedChip");
	const apply = () => {
		const dirty = hasAnyDirty();
		const onDeviceTab = getSession().navTab === "device";
		if (bar) bar.classList.toggle("hidden", !dirty || onDeviceTab);
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

// Feature 11 — register every command the palette surfaces. Called once
// from initState(). Commands close over live state via `availableWhen`
// callbacks rather than capturing booleans, so "Connect device" hides the
// moment a device arrives and reappears when it leaves.
//
// Preset commands are synthesized at palette-open time via a `keywords`
// flag: we register a sentinel "load-preset" dispatcher and, additionally,
// one command per preset present at init time. Presets added later won't
// appear until next reload — acceptable MVP trade-off; the plan deferred
// lazy re-registration.
function registerDefaultCommands() {
	const cmds: Command[] = [
		{
			id: "device.connect",
			title: "Connect device",
			keywords: ["pair", "hid", "usb"],
			run: () => toggleConnection(),
			availableWhen: () => !getDevice(),
		},
		{
			id: "device.disconnect",
			title: "Disconnect device",
			keywords: ["unpair"],
			run: () => toggleConnection(),
			availableWhen: () => !!getDevice(),
		},
		{
			id: "device.sync",
			title: "Sync to RAM",
			keywords: ["push", "apply", "write"],
			run: () => handleSyncClick(),
			availableWhen: () => !!getDevice(),
		},
		{
			id: "device.flash",
			title: "Save to flash",
			keywords: ["persist", "save", "commit"],
			run: () => handleFlashClick(),
			availableWhen: () => !!getDevice(),
		},
		{
			id: "slot.swap",
			title: "Swap A \u2194 B slots",
			keywords: ["toggle", "a b"],
			shortcut: "Alt+S",
			run: () => swapABSlots(),
		},
		{
			id: "history.undo",
			title: "Undo",
			shortcut: "\u2318Z",
			run: () => undoAction(),
		},
		{
			id: "history.redo",
			title: "Redo",
			shortcut: "\u21E7\u2318Z",
			run: () => redoAction(),
		},
		{
			id: "export.json",
			title: "Export as JSON",
			keywords: ["download", "share"],
			run: () => runExport("json"),
		},
		{
			id: "export.rew",
			title: "Export as REW",
			keywords: ["download"],
			run: () => runExport("rew"),
		},
		{
			id: "export.eapo",
			title: "Export as EqualizerAPO",
			keywords: ["equalizer apo", "download"],
			run: () => runExport("eapo"),
		},
		{
			id: "export.wavelet",
			title: "Export as Wavelet",
			keywords: ["download"],
			run: () => runExport("wavelet"),
		},
		{
			id: "export.camilla",
			title: "Export as CamillaDSP",
			keywords: ["camilla", "yaml", "download"],
			run: () => runExport("camilla"),
		},
		{
			id: "export.peace",
			title: "Export as Peace",
			keywords: ["download"],
			run: () => runExport("peace"),
		},
		{
			id: "import.file",
			title: "Import preset from file",
			keywords: ["load", "json"],
			run: () => {
				const input = document.getElementById("fileInput") as HTMLInputElement | null;
				input?.click();
			},
		},
		{
			id: "target.load",
			title: "Load target curve\u2026",
			keywords: ["harman", "curve"],
			run: () => openTargetLoader(),
		},
		{
			id: "measurement.load",
			title: "Load FR overlay\u2026",
			keywords: ["measurement", "frequency response"],
			run: () => openMeasurementLoader(),
		},
		{
			id: "autoeq.browse",
			title: "Browse AutoEQ database\u2026",
			keywords: ["headphones", "catalog"],
			run: () => browseAutoEq(),
		},
		{
			id: "squiglink.browse",
			title: "Browse squig.link\u2026",
			keywords: ["reviewers", "measurements"],
			run: () => {
				void browseSquigLink((text, name) => {
					try {
						const parsed = parseMeasurement(text, name);
						setMeasurement(normalizeAt(parsed, 1000));
						renderUI(getEqState());
						log(`Loaded FR: ${name} (${parsed.points.length} points).`);
					} catch (err) {
						log(`FR parse error: ${(err as Error).message}`);
					}
				}).catch((err: Error) => log(`squig.link error: ${err.message}`));
			},
		},
		{
			id: "eq.bypass",
			title: "Toggle EQ bypass",
			keywords: ["disable", "enable", "mute"],
			shortcut: "Space",
			run: () => toggleEqBypass(),
		},
		{
			id: "view.phase",
			title: "Toggle phase response view",
			keywords: ["overlay"],
			run: () => togglePhaseView(),
		},
		{
			id: "view.abOverlay",
			title: "Toggle A/B overlay",
			keywords: ["inactive slot"],
			run: () => toggleAbOverlay(),
		},
		{
			id: "view.delta",
			title: "Toggle delta line",
			keywords: ["difference", "a minus b"],
			run: () => toggleDelta(),
		},
		{
			id: "autoeq.fit",
			title: "AutoEQ fit bands",
			keywords: ["auto", "fit", "target"],
			run: () => handleAutoEq(),
			availableWhen: () => !!getTarget() && !!getMeasurement(),
		},
		{
			id: "state.reset",
			title: "Reset to defaults",
			keywords: ["factory", "clear"],
			run: () => resetToDefaults(),
		},
		{
			id: "help.keyboard",
			title: "Open keyboard help",
			keywords: ["shortcuts", "hotkeys"],
			shortcut: "?",
			run: () => openKeyboardHelp(),
		},
		{
			id: "palette.open",
			title: "Open command palette",
			keywords: ["commands"],
			shortcut: "\u2318K",
			run: () => openPalette(),
		},
	];
	for (const cmd of cmds) registerCommand(cmd);

	// Synthesize one command per preset present at init time. Using
	// `getAllPresets()` includes both built-ins and anything already in
	// localStorage. Saving a new preset later won't surface here until
	// the user reloads — accepted MVP trade-off per the plan.
	for (const preset of getAllPresets()) {
		registerCommand({
			id: `preset.load.${preset.id}`,
			title: `Load preset: ${preset.name}`,
			keywords: ["preset", preset.description ?? ""],
			run: () => applyPresetFromSidebar(preset.id),
		});
	}
}

// Call once from initState so the palette has commands on first open.
// Exported to make unit-level re-registration cheap in tests.
export { registerDefaultCommands };
