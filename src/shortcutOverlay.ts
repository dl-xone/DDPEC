// Alt-hold shortcut overlay. While Alt (Option on macOS) is held down,
// every interactive control with a registered shortcut grows a tiny
// keycap chip. Released → fades out. Linear / Figma pattern.
//
// Implementation strategy: we never destroy the chips after first injection.
// They sit in the DOM with opacity: 0 by default; a CSS rule keyed off
// `body[data-alt-hold="1"]` flips them to opacity: 1.

interface Registration {
	selector: string;
	keys: string;
}

const registrations: Registration[] = [];
let initialized = false;
let chipsInjected = false;

export function registerShortcut(targetSelector: string, keys: string): void {
	registrations.push({ selector: targetSelector, keys });
	// If we've already initialized AND chips already injected, the new
	// registration won't paint until the next initShortcutOverlay run.
	// Re-inject lazily on next Alt hold so dynamic registrations work.
	if (chipsInjected) chipsInjected = false;
}

function injectChips() {
	for (const reg of registrations) {
		const target = document.querySelector(reg.selector);
		if (!target) continue;
		// Skip if a chip is already attached.
		if (
			target.parentElement?.querySelector(
				`.kbd-chip[data-for="${cssEscape(reg.selector)}"]`,
			)
		)
			continue;
		// Ensure the target itself is the positioning context. Setting
		// position: relative inline is the safest path — won't conflict
		// with future tailwind utilities.
		const el = target as HTMLElement;
		const computed = getComputedStyle(el).position;
		if (computed === "static") {
			el.style.position = "relative";
		}
		const chip = document.createElement("span");
		chip.className = "kbd-chip";
		chip.dataset.for = reg.selector;
		chip.textContent = reg.keys;
		el.appendChild(chip);
	}
	chipsInjected = true;
}

// Minimal CSS-escape — the registered selectors here are simple
// id-selectors, so quoting is enough. Avoids depending on the platform
// CSS.escape (broadly supported in 2026 but cheap to inline-guard).
function cssEscape(s: string): string {
	return s.replace(/(["\\])/g, "\\$1");
}

export function initShortcutOverlay(): void {
	if (initialized) return;
	initialized = true;
	if (typeof window === "undefined") return;

	const onKeyDown = (e: KeyboardEvent) => {
		// Bare Alt only — Cmd/Ctrl/Shift+Alt have their own meanings.
		if (e.key !== "Alt" || e.ctrlKey || e.metaKey || e.shiftKey) return;
		// Suppress while typing — opening chips during text input is jarring.
		const t = e.target as HTMLElement | null;
		if (
			t instanceof HTMLInputElement ||
			t instanceof HTMLTextAreaElement ||
			t instanceof HTMLSelectElement
		) {
			return;
		}
		// Lazy-inject on first Alt hold so the registration can include
		// elements that mounted late (preset action bar, etc).
		if (!chipsInjected) injectChips();
		document.body.dataset.altHold = "1";
	};

	const clearOverlay = () => {
		if (document.body.dataset.altHold === "1") {
			delete document.body.dataset.altHold;
		}
	};

	window.addEventListener("keydown", onKeyDown);
	window.addEventListener("keyup", (e) => {
		if (e.key === "Alt") clearOverlay();
	});
	window.addEventListener("blur", clearOverlay);
}
