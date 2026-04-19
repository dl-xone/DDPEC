// Theme switcher. Toggles a `data-theme` attribute on <html>; the CSS
// palette override in style.css flips every token by re-binding the same
// --color-* variables. Choice is persisted in localStorage and falls
// back to the user's OS preference on first visit.
//
// Pivot note: the top-bar #btnTheme was removed in the JDS pivot layout.
// `toggleTheme` is exported so the Device Settings tab (or any future host)
// can call it directly; `initTheme` still binds #btnTheme when present so
// legacy / transitional markup continues to work.
//
// JDS pivot 2026-04-17: add an explicit ThemePreference distinct from the
// applied Theme. Preference of "system" means "track OS via matchMedia";
// the applied theme stays "dark" | "light" so consumers (canvas drawing,
// etc.) don't have to branch.

export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";

const STORAGE_KEY = "ddpec.theme";

function systemPreference(): Theme {
	if (typeof window === "undefined" || !window.matchMedia) return "dark";
	return window.matchMedia("(prefers-color-scheme: light)").matches
		? "light"
		: "dark";
}

// Current preference (may be "system"). Used by the Device Settings UI
// to paint the correct radio button.
let currentPreference: ThemePreference = "system";
let mediaQuery: MediaQueryList | null = null;
let mediaListenerBound = false;

export function getTheme(): Theme {
	const attr = document.documentElement.getAttribute("data-theme");
	return attr === "light" ? "light" : "dark";
}

export function getThemePreference(): ThemePreference {
	return currentPreference;
}

export function applyTheme(theme: Theme) {
	if (theme === "light") {
		document.documentElement.setAttribute("data-theme", "light");
	} else {
		document.documentElement.removeAttribute("data-theme");
	}
	updateToggleButton();
}

// Set user preference. "system" means track OS via matchMedia; "light"/
// "dark" pin to that explicit choice. Preference is persisted; applied
// theme is derived.
export function setTheme(pref: ThemePreference) {
	currentPreference = pref;
	try {
		localStorage.setItem(STORAGE_KEY, pref);
	} catch {
		// storage disabled — just don't persist
	}
	const resolved: Theme = pref === "system" ? systemPreference() : pref;
	applyTheme(resolved);
	ensureSystemListener();
	document.dispatchEvent(new CustomEvent("ddpec:theme-change"));
}

// Keep the legacy "flip light<->dark" toggle alive for callers that still
// want a binary swap. Flips the *applied* theme and pins the preference
// to match so it stops tracking system.
export function toggleTheme() {
	const next: Theme = getTheme() === "light" ? "dark" : "light";
	setTheme(next);
}

function ensureSystemListener() {
	if (typeof window === "undefined" || !window.matchMedia) return;
	if (!mediaQuery) mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
	if (mediaListenerBound) return;
	mediaListenerBound = true;
	const listener = () => {
		if (currentPreference === "system") {
			applyTheme(systemPreference());
			document.dispatchEvent(new CustomEvent("ddpec:theme-change"));
		}
	};
	if (typeof mediaQuery.addEventListener === "function") {
		mediaQuery.addEventListener("change", listener);
	} else if (typeof (mediaQuery as any).addListener === "function") {
		(mediaQuery as any).addListener(listener);
	}
}

function updateToggleButton() {
	const btn = document.getElementById("btnTheme");
	if (!btn) return;
	const isLight = getTheme() === "light";
	// Show the destination, not the current state: moon while in light,
	// sun while in dark. Matches the "this is what clicking does" idiom.
	btn.textContent = isLight ? "☾" : "☀";
	btn.setAttribute(
		"aria-label",
		isLight ? "Switch to dark mode" : "Switch to light mode",
	);
	btn.setAttribute("title", isLight ? "Switch to dark" : "Switch to light");
}

export function initTheme() {
	let stored: ThemePreference | null = null;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === "light" || raw === "dark" || raw === "system") stored = raw;
	} catch {
		// ignore
	}
	currentPreference = stored ?? "system";
	const resolved: Theme =
		currentPreference === "system" ? systemPreference() : currentPreference;
	applyTheme(resolved);
	ensureSystemListener();

	document.getElementById("btnTheme")?.addEventListener("click", toggleTheme);
}
