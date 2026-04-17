// Theme switcher. Toggles a `data-theme` attribute on <html>; the CSS
// palette override in style.css flips every token by re-binding the same
// --color-* variables. Choice is persisted in localStorage and falls
// back to the user's OS preference on first visit.
//
// Pivot note: the top-bar #btnTheme was removed in the JDS pivot layout.
// `toggleTheme` is exported so the Device Settings tab (or any future host)
// can call it directly; `initTheme` still binds #btnTheme when present so
// legacy / transitional markup continues to work.

export type Theme = "dark" | "light";

const STORAGE_KEY = "ddpec.theme";

function systemPreference(): Theme {
	if (typeof window === "undefined" || !window.matchMedia) return "dark";
	return window.matchMedia("(prefers-color-scheme: light)").matches
		? "light"
		: "dark";
}

export function getTheme(): Theme {
	const attr = document.documentElement.getAttribute("data-theme");
	return attr === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
	if (theme === "light") {
		document.documentElement.setAttribute("data-theme", "light");
	} else {
		document.documentElement.removeAttribute("data-theme");
	}
	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		// storage disabled — choice just won't persist
	}
	updateToggleButton();
}

export function toggleTheme() {
	applyTheme(getTheme() === "light" ? "dark" : "light");
	document.dispatchEvent(new CustomEvent("ddpec:theme-change"));
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
	let stored: Theme | null = null;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === "light" || raw === "dark") stored = raw;
	} catch {
		// ignore
	}
	applyTheme(stored ?? systemPreference());

	document.getElementById("btnTheme")?.addEventListener("click", toggleTheme);
}
