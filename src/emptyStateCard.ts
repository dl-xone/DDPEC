// First-run / cold-start empty-state card. Overlays the centre of the EQ
// canvas when a user has no device, no active preset, and nothing loaded —
// gives them three real next steps instead of leaving them staring at a
// dense grid they don't know how to use. Dismisses on first interaction
// (any of the three actions, the explicit ×, or Esc) and stays dismissed
// for the rest of the session. Returns next reload if the predicate is
// still true.

import { getMeasurement, getTarget } from "./measurements.ts";
import { getSession } from "./session.ts";
import { getDevice } from "./state.ts";

const CARD_ID = "emptyStateCard";
const SVG_NS = "http://www.w3.org/2000/svg";
let dismissedThisSession = false;
let mounted: HTMLElement | null = null;

function shouldShow(): boolean {
	if (dismissedThisSession) return false;
	if (getDevice() !== null) return false;
	if (getSession().selectedPresetId) return false;
	if (getTarget() !== null) return false;
	if (getMeasurement() !== null) return false;
	return true;
}

function dismiss(returnFocusToConnect = false) {
	dismissedThisSession = true;
	if (!mounted) return;
	mounted.classList.add("is-leaving");
	const node = mounted;
	mounted = null;
	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (reduced) {
		node.remove();
	} else {
		setTimeout(() => node.remove(), 160);
	}
	document.removeEventListener("keydown", onKeydown, { capture: true });
	if (returnFocusToConnect) {
		(document.getElementById("btnConnect") as HTMLButtonElement | null)?.focus();
	}
}

function onKeydown(e: KeyboardEvent) {
	if (e.key === "Escape" && mounted) {
		e.stopPropagation();
		dismiss(true);
	}
}

// Build a small stroke-only icon from a list of child-element specs.
// createElementNS avoids innerHTML — content is hardcoded but the DOM
// layer stays untainted.
function makeIcon(
	children: ReadonlyArray<{ tag: string; attrs: Record<string, string> }>,
): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("width", "12");
	svg.setAttribute("height", "12");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("aria-hidden", "true");
	for (const c of children) {
		const el = document.createElementNS(SVG_NS, c.tag);
		for (const [k, v] of Object.entries(c.attrs)) el.setAttribute(k, v);
		svg.appendChild(el);
	}
	return svg;
}

const ICON_DISMISS = () =>
	makeIcon([{ tag: "path", attrs: { d: "M18 6L6 18M6 6l12 12" } }]);

const ICON_DEVICE = () =>
	makeIcon([
		{
			tag: "rect",
			attrs: { x: "2", y: "6", width: "20", height: "12", rx: "2" },
		},
		{ tag: "path", attrs: { d: "M6 10h.01M10 10h.01" } },
	]);

const ICON_STAR = () =>
	makeIcon([
		{
			tag: "polygon",
			attrs: {
				points: "12 2 15 9 22 9 16 14 18 22 12 18 6 22 8 14 2 9 9 9 12 2",
			},
		},
	]);

const ICON_WAVE = () =>
	makeIcon([{ tag: "path", attrs: { d: "M3 12h3l3-8 4 16 3-8h5" } }]);

function makeAction(
	label: string,
	icon: SVGSVGElement,
	onClick: () => void,
): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "empty-state-card__action";
	btn.appendChild(icon);
	const span = document.createElement("span");
	span.textContent = label;
	btn.appendChild(span);
	btn.addEventListener("click", onClick);
	return btn;
}

function mount(container: HTMLElement) {
	if (mounted) return;

	const card = document.createElement("section");
	card.id = CARD_ID;
	card.className = "empty-state-card";
	card.setAttribute("role", "region");
	card.setAttribute("aria-label", "Getting started");

	const header = document.createElement("div");
	header.className = "empty-state-card__header";

	const eyebrow = document.createElement("span");
	eyebrow.className = "empty-state-card__eyebrow";
	eyebrow.textContent = "GET STARTED";

	const dismissBtn = document.createElement("button");
	dismissBtn.type = "button";
	dismissBtn.className = "btn-ghost-icon empty-state-card__dismiss";
	dismissBtn.setAttribute("aria-label", "Dismiss");
	dismissBtn.title = "Dismiss";
	dismissBtn.appendChild(ICON_DISMISS());
	dismissBtn.addEventListener("click", () => dismiss(true));

	header.append(eyebrow, dismissBtn);

	const headline = document.createElement("h2");
	headline.className = "empty-state-card__headline";
	headline.textContent = "Tune your audio";

	const body = document.createElement("p");
	body.className = "empty-state-card__body";
	body.textContent =
		"DDPEC connects to CrinEar devices over WebHID. No device? Explore with a preset or measurement.";

	const actions = document.createElement("div");
	actions.className = "empty-state-card__actions";

	const connectBtn = makeAction("Connect device", ICON_DEVICE(), () => {
		dismiss();
		(document.getElementById("btnConnect") as HTMLButtonElement | null)?.click();
	});

	const presetBtn = makeAction("Pick a preset", ICON_STAR(), () => {
		dismiss();
		const search = document.getElementById(
			"presetSearch",
		) as HTMLInputElement | null;
		search?.focus();
		search?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	});

	const measurementBtn = makeAction(
		"Load measurement",
		ICON_WAVE(),
		() => {
			dismiss();
			(
				document.getElementById("btnMeasurement") as HTMLButtonElement | null
			)?.click();
		},
	);

	actions.append(connectBtn, presetBtn, measurementBtn);
	card.append(header, headline, body, actions);

	container.appendChild(card);
	mounted = card;

	requestAnimationFrame(() => connectBtn.focus());
	document.addEventListener("keydown", onKeydown, { capture: true });
}

// Called from renderPresetHeader on every relevant state change (plus
// once at init). Cheap no-op when the predicate matches the mounted state.
export function paintEmptyStateCard(): void {
	const show = shouldShow();
	if (show && !mounted) {
		const container = document.getElementById("eqContainer");
		if (container) mount(container);
	} else if (!show && mounted) {
		dismiss();
	}
}

// One-time init on boot. Safe to call before DOMContentLoaded — if the
// container isn't there yet, the next paintEmptyStateCard() call mounts.
export function initEmptyStateCard(): void {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", paintEmptyStateCard, {
			once: true,
		});
	} else {
		paintEmptyStateCard();
	}
}
