import "./style.css";
import {
	handleFlashClick,
	handleSyncClick,
	initSession,
	initState,
	onSlotChange,
	openKeyboardHelp,
	redoAction,
	swapABSlots,
	toggleConnection,
	toggleEqBypass,
	undoAction,
} from "./fn.ts";
import { initTheme } from "./theme.ts";
import { setGlobalGain } from "./helpers.ts";
import { exportProfile, importProfile } from "./importExport.ts";

export type Band = {
	index: number;
	freq: number;
	gain: number;
	q: number;
	type: string;
	enabled: boolean;
};
export type EQ = Band[];

// Initialize immediately. Theme first so the first paint respects the
// persisted / system preference; state + canvas come second.
initTheme();
initState();
// Session restore must run after initState() so the wiring it patches
// (mode buttons, tabs, log tray) already exists in the DOM.
initSession();

/**
 * Helper: dynamically import a named export from fn.ts and call it.
 * Used for handlers that the fn.ts agent is still stubbing — avoids
 * build-time failure if the export isn't there yet.
 */
async function callFnHandler(name: string, fallbackMessage: string) {
	try {
		const mod = (await import("./fn.ts")) as Record<string, unknown>;
		const fn = mod[name];
		if (typeof fn === "function") {
			(fn as () => void)();
			return;
		}
	} catch (err) {
		console.warn(`Failed to import ${name} from fn.ts:`, err);
	}
	console.log(fallbackMessage);
	alert(fallbackMessage);
}

/**
 * CONNECTION LOGIC
 */
document
	.getElementById("btnConnect")
	?.addEventListener("click", async () => toggleConnection());

/**
 * SYNC LOGIC — wrapper adds progress modal + inert guard + errorModal.
 */
document
	.getElementById("btnSync")
	?.addEventListener("click", () => handleSyncClick());

/**
 * FLASH LOGIC — same wrapping for the permanent-write path.
 */
document
	.getElementById("btnFlash")
	?.addEventListener("click", () => handleFlashClick());

/**
 * GLOBAL GAIN LOGIC
 */
document
	.getElementById("globalGainSlider")
	?.addEventListener("change", async (e) => setGlobalGain(e));

/**
 * SLOT LOGIC — dropdown (still present in DOM for fallback) + A/B buttons
 * are wired inside fn.ts initState so they survive this file's cleanup.
 */
document
	.getElementById("slotSelect")
	?.addEventListener("change", (e) => onSlotChange(e));

/**
 * IMPORT / EXPORT LOGIC — #btnImport is hidden in the new layout but still
 * in the DOM; keep it wired so the file input path keeps working.
 */
document
	.getElementById("btnExport")
	?.addEventListener("click", () => exportProfile());

const btnImport = document.getElementById("btnImport");
const btnImportJson = document.getElementById("btnImportJson");
const fileInput = document.getElementById("fileInput") as HTMLInputElement | null;
btnImport?.addEventListener("click", () => fileInput?.click());
// JDS pivot 2026-04-17: visible entry point in the preset sidebar.
btnImportJson?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", (e) => importProfile(e));

/**
 * UNDO / REDO TOOLBAR BUTTONS (new in pivot layout)
 */
document
	.getElementById("btnUndo")
	?.addEventListener("click", () => undoAction());
document
	.getElementById("btnRedo")
	?.addEventListener("click", () => redoAction());

/**
 * PRESET COMMIT BAR (new in pivot layout). Handlers may still be stubs in
 * fn.ts — dynamic-import with a graceful fallback so nothing crashes.
 */
document
	.getElementById("btnUpdatePreset")
	?.addEventListener("click", () =>
		callFnHandler("handleUpdatePreset", "Update preset: not implemented yet."),
	);
document
	.getElementById("btnSaveAsNew")
	?.addEventListener("click", () =>
		callFnHandler("handleSaveAsNew", "Save as new preset: not implemented yet."),
	);
document
	.getElementById("btnGetLink")
	?.addEventListener("click", () =>
		callFnHandler("handleGetLink", "Get shareable link: not implemented yet."),
	);

/**
 * TOP NAV TABS — DSP vs Device Settings. Prefer fn.ts's setActiveNavTab
 * when it lands; fall back to a simple .active class toggle so the UI is
 * still usable during the transition.
 */
function activateNavTab(which: "dsp" | "device") {
	import("./fn.ts")
		.then((mod) => {
			const fn = (mod as Record<string, unknown>).setActiveNavTab;
			if (typeof fn === "function") {
				(fn as (w: "dsp" | "device") => void)(which);
				return;
			}
			toggleNavTabsInline(which);
		})
		.catch(() => toggleNavTabsInline(which));
}

function toggleNavTabsInline(which: "dsp" | "device") {
	const dspTab = document.getElementById("navTabDsp");
	const deviceTab = document.getElementById("navTabDevice");
	dspTab?.classList.toggle("active", which === "dsp");
	deviceTab?.classList.toggle("active", which === "device");
}

document
	.getElementById("navTabDsp")
	?.addEventListener("click", () => activateNavTab("dsp"));
document
	.getElementById("navTabDevice")
	?.addEventListener("click", () => activateNavTab("device"));

/**
 * KEYBOARD SHORTCUTS — undo / redo / swap / help. Preserved from the
 * pre-pivot build; the '?' shortcut replaces the removed header help icon.
 */
window.addEventListener("keydown", (e) => {
	// Ignore while typing in form inputs so we don't hijack text editing.
	const target = e.target as HTMLElement | null;
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLSelectElement ||
		target instanceof HTMLTextAreaElement
	) {
		return;
	}

	const key = e.key.toLowerCase();

	// Space: toggle EQ bypass. Quick A/B of "with EQ" vs "raw" without
	// hunting for the sidebar button. Guarded above so typing a space
	// inside a form input still writes a literal space.
	if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
		e.preventDefault();
		toggleEqBypass();
		return;
	}

	// Alt+S: swap A ↔ B. Alt avoids conflict with Cmd+S save dialogs.
	if (e.altKey && key === "s") {
		e.preventDefault();
		swapABSlots();
		return;
	}

	// "?" opens the keyboard help. On most layouts this arrives as
	// shift+/, hence the explicit check for the resolved character.
	if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
		e.preventDefault();
		openKeyboardHelp();
		return;
	}

	const mod = e.ctrlKey || e.metaKey;
	if (!mod) return;

	if (key === "z" && !e.shiftKey) {
		e.preventDefault();
		undoAction();
	} else if ((key === "z" && e.shiftKey) || key === "y") {
		e.preventDefault();
		redoAction();
	}
});
