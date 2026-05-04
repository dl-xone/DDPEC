// First-run wizard for System EQ. Three steps: BlackHole detection →
// macOS system audio routing → DDPEC output. Each step shows current vs
// target state so the user knows what success looks like.
//
// Dismissible. Completion (or explicit "later") flips a localStorage
// flag so the wizard doesn't re-show on every reload — a header pill
// surfaces "Finish setup" until done. Pure DOM, no Tauri-specific APIs;
// the same wizard runs in browser dev too so we can iterate without
// shelling out.

import { log, toast } from "./helpers.ts";
import {
	getSystemEqState,
	listAudioInputs,
	listAudioOutputs,
	setSystemEqInput,
	setSystemEqOutput,
} from "./systemEq.ts";
import { playConfirmationTone } from "./systemEqConfirmTone.ts";

const COMPLETED_KEY = "ddpec.systemEq.wizardCompleted";
const DEFERRED_KEY = "ddpec.systemEq.wizardDeferred";

// macOS Sound preferences deep-link. Only resolves on macOS; on other
// platforms it produces a nav error which we swallow.
const SOUND_PREFS_URL =
	"x-apple.systempreferences:com.apple.preference.sound?Output";
// BlackHole download — the upstream installer page. Surfaced as a real
// link so users can right-click → open in their default browser if Tauri's
// shell.open isn't available.
const BLACKHOLE_DOWNLOAD = "https://existential.audio/blackhole/";

interface WizardState {
	step: 1 | 2 | 3;
	hasBlackHole: boolean;
	pickedInput: string | null;
	pickedOutput: string | null;
	confirmedSystemOutput: boolean;
}

export function isWizardCompleted(): boolean {
	if (typeof localStorage === "undefined") return false;
	return localStorage.getItem(COMPLETED_KEY) === "1";
}

export function isWizardDeferred(): boolean {
	if (typeof localStorage === "undefined") return false;
	return localStorage.getItem(DEFERRED_KEY) === "1";
}

function markCompleted(): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(COMPLETED_KEY, "1");
	localStorage.removeItem(DEFERRED_KEY);
}

function markDeferred(): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(DEFERRED_KEY, "1");
}

export function resetWizardState(): void {
	if (typeof localStorage === "undefined") return;
	localStorage.removeItem(COMPLETED_KEY);
	localStorage.removeItem(DEFERRED_KEY);
}

let activeDialog: HTMLDialogElement | null = null;

export function openSystemEqWizard(): void {
	if (activeDialog) {
		activeDialog.showModal();
		return;
	}
	const dialog = document.createElement("dialog");
	dialog.className = "system-eq-wizard";
	dialog.setAttribute("aria-label", "System EQ first-run setup");
	const state: WizardState = {
		step: 1,
		hasBlackHole: false,
		pickedInput: getSystemEqState().inputDeviceId,
		pickedOutput: getSystemEqState().outputDeviceId,
		confirmedSystemOutput: false,
	};

	function close(completed: boolean): void {
		if (completed) markCompleted();
		else markDeferred();
		dialog.close();
		dialog.remove();
		activeDialog = null;
	}

	function render(): void {
		dialog.replaceChildren();

		const head = document.createElement("div");
		head.className = "system-eq-wizard-head";
		const stepLabel = document.createElement("span");
		stepLabel.className = "system-eq-wizard-stepnum";
		stepLabel.textContent = `Step ${state.step} / 3`;
		head.appendChild(stepLabel);
		const title = document.createElement("h2");
		title.className = "system-eq-wizard-title";
		title.textContent =
			state.step === 1
				? "Install BlackHole"
				: state.step === 2
					? "Route system audio"
					: "Pick DDPEC output";
		head.appendChild(title);

		const progress = document.createElement("div");
		progress.className = "system-eq-wizard-progress";
		for (let i = 1; i <= 3; i++) {
			const dot = document.createElement("span");
			dot.className = "system-eq-wizard-dot";
			if (i < state.step) dot.classList.add("is-done");
			if (i === state.step) dot.classList.add("is-current");
			progress.appendChild(dot);
		}
		head.appendChild(progress);
		dialog.appendChild(head);

		const body = document.createElement("div");
		body.className = "system-eq-wizard-body";
		dialog.appendChild(body);

		if (state.step === 1) renderStep1(body, state, render);
		else if (state.step === 2) renderStep2(body, state, render);
		else renderStep3(body, state, render, close);

		const footer = document.createElement("div");
		footer.className = "system-eq-wizard-footer";

		const skip = document.createElement("button");
		skip.type = "button";
		skip.className = "system-eq-wizard-skip";
		skip.textContent = "Set up later";
		skip.addEventListener("click", () => close(false));
		footer.appendChild(skip);

		const navGroup = document.createElement("div");
		navGroup.className = "system-eq-wizard-nav";

		if (state.step > 1) {
			const back = document.createElement("button");
			back.type = "button";
			back.className = "btn-ghost";
			back.textContent = "Back";
			back.addEventListener("click", () => {
				state.step = (state.step - 1) as WizardState["step"];
				render();
			});
			navGroup.appendChild(back);
		}

		const next = document.createElement("button");
		next.type = "button";
		next.className = "btn-primary";
		const isLast = state.step === 3;
		next.textContent = isLast ? "Done" : "Next";
		next.disabled = !canAdvance(state);
		next.addEventListener("click", () => {
			if (!canAdvance(state)) return;
			if (state.step < 3) {
				state.step = (state.step + 1) as WizardState["step"];
				render();
			} else {
				// Step 3 next = done. Persist final picks so engagement works
				// without revisiting.
				if (state.pickedInput) setSystemEqInput(state.pickedInput);
				if (state.pickedOutput) void setSystemEqOutput(state.pickedOutput);
				toast("System EQ ready · listen for the tone");
				// Brief 500 Hz tone routed *directly* to the picked output via
				// setSinkId so it bypasses the BlackHole loop the user just
				// configured. The wizard's whole point was to set up that
				// routing; we shouldn't lose the confirmation tone to the
				// same plumbing. Fire-and-forget; don't block dismissal.
				void playConfirmationTone(state.pickedOutput);
				close(true);
			}
		});
		navGroup.appendChild(next);
		footer.appendChild(navGroup);
		dialog.appendChild(footer);
	}

	render();
	dialog.addEventListener("cancel", (e) => {
		e.preventDefault();
		close(false);
	});
	document.body.appendChild(dialog);
	activeDialog = dialog;
	dialog.showModal();
}

function canAdvance(state: WizardState): boolean {
	if (state.step === 1) return state.hasBlackHole;
	if (state.step === 2) return state.confirmedSystemOutput;
	if (state.step === 3) return !!state.pickedOutput;
	return false;
}

function renderStep1(
	body: HTMLElement,
	state: WizardState,
	rerender: () => void,
): void {
	const desc = document.createElement("p");
	desc.className = "system-eq-wizard-desc";
	desc.textContent =
		"BlackHole is a free virtual audio device that lets DDPEC capture system audio.";
	body.appendChild(desc);

	const status = document.createElement("div");
	status.className = "system-eq-wizard-status";
	body.appendChild(status);

	void detectBlackHole().then((found) => {
		state.hasBlackHole = found;
		status.replaceChildren();
		const icon = document.createElement("span");
		icon.className = "system-eq-wizard-status-icon";
		icon.textContent = found ? "✓" : "○";
		icon.classList.toggle("is-ok", found);
		icon.classList.toggle("is-pending", !found);
		status.appendChild(icon);
		const text = document.createElement("span");
		text.textContent = found
			? "BlackHole detected. Continue when ready."
			: "BlackHole not detected.";
		status.appendChild(text);
		const btn = body.querySelector<HTMLButtonElement>(
			".system-eq-wizard-step1-next",
		);
		if (btn) btn.disabled = !state.hasBlackHole;
		rerender();
	});

	const actions = document.createElement("div");
	actions.className = "system-eq-wizard-actions";
	const dl = document.createElement("a");
	dl.href = BLACKHOLE_DOWNLOAD;
	dl.target = "_blank";
	dl.rel = "noopener noreferrer";
	dl.className = "btn-outline";
	dl.textContent = "Download BlackHole";
	actions.appendChild(dl);

	const recheck = document.createElement("button");
	recheck.type = "button";
	recheck.className = "btn-ghost";
	recheck.textContent = "I've installed it — recheck";
	recheck.addEventListener("click", async () => {
		state.hasBlackHole = await detectBlackHole();
		if (state.hasBlackHole) toast("BlackHole detected");
		rerender();
	});
	actions.appendChild(recheck);
	body.appendChild(actions);
}

function renderStep2(
	body: HTMLElement,
	state: WizardState,
	rerender: () => void,
): void {
	const desc = document.createElement("p");
	desc.className = "system-eq-wizard-desc";
	desc.textContent =
		"Set BlackHole as your Mac's audio output so System EQ receives whatever your Mac plays.";
	body.appendChild(desc);

	const grid = document.createElement("div");
	grid.className = "system-eq-wizard-grid";
	const current = document.createElement("div");
	current.className = "system-eq-wizard-grid-cell";
	const currentLabel = document.createElement("span");
	currentLabel.className = "system-eq-wizard-cell-label";
	currentLabel.textContent = "Now";
	current.appendChild(currentLabel);
	const currentValue = document.createElement("span");
	currentValue.className = "system-eq-wizard-cell-value";
	currentValue.textContent =
		"macOS chooses based on what you've set in Sound Settings.";
	current.appendChild(currentValue);
	const target = document.createElement("div");
	target.className = "system-eq-wizard-grid-cell";
	const targetLabel = document.createElement("span");
	targetLabel.className = "system-eq-wizard-cell-label";
	targetLabel.textContent = "Target";
	target.appendChild(targetLabel);
	const targetValue = document.createElement("span");
	targetValue.className = "system-eq-wizard-cell-value is-target";
	targetValue.textContent = "BlackHole 2ch";
	target.appendChild(targetValue);
	grid.appendChild(current);
	grid.appendChild(target);
	body.appendChild(grid);

	const actions = document.createElement("div");
	actions.className = "system-eq-wizard-actions";
	const open = document.createElement("a");
	open.href = SOUND_PREFS_URL;
	open.className = "btn-outline";
	open.textContent = "Open Sound Settings";
	open.addEventListener("click", () => {
		// Best-effort hint — no programmatic confirmation that the user
		// actually changed it; rely on the user's "Yes, I switched" click.
		log("System EQ wizard: opened Sound Settings deep-link.");
	});
	actions.appendChild(open);

	const confirm = document.createElement("button");
	confirm.type = "button";
	confirm.className = "btn-primary";
	confirm.textContent = state.confirmedSystemOutput
		? "✓ Confirmed"
		: "I switched output to BlackHole";
	confirm.addEventListener("click", () => {
		state.confirmedSystemOutput = true;
		rerender();
	});
	actions.appendChild(confirm);
	body.appendChild(actions);
}

function renderStep3(
	body: HTMLElement,
	state: WizardState,
	rerender: () => void,
	_close: (completed: boolean) => void,
): void {
	const desc = document.createElement("p");
	desc.className = "system-eq-wizard-desc";
	desc.textContent =
		"Choose where System EQ should send EQ'd audio — usually the USB DAC you're using DDPEC with.";
	body.appendChild(desc);

	const row = document.createElement("div");
	row.className = "system-eq-wizard-row";
	const label = document.createElement("label");
	label.className = "system-eq-wizard-row-label";
	label.htmlFor = "wizardOutputSelect";
	label.textContent = "Output";
	row.appendChild(label);
	const select = document.createElement("select");
	select.id = "wizardOutputSelect";
	select.className = "system-eq-popover-select";
	row.appendChild(select);
	body.appendChild(row);

	const inputRow = document.createElement("div");
	inputRow.className = "system-eq-wizard-row";
	const inputLabel = document.createElement("label");
	inputLabel.className = "system-eq-wizard-row-label";
	inputLabel.htmlFor = "wizardInputSelect";
	inputLabel.textContent = "Source";
	inputRow.appendChild(inputLabel);
	const inputSelect = document.createElement("select");
	inputSelect.id = "wizardInputSelect";
	inputSelect.className = "system-eq-popover-select";
	inputRow.appendChild(inputSelect);
	body.appendChild(inputRow);

	void Promise.all([listAudioInputs(), listAudioOutputs()]).then(
		([inputs, outputs]) => {
			fillSelect(select, outputs, "system default", state.pickedOutput);
			fillSelect(inputSelect, inputs, "first detected", state.pickedInput);

			// Smart defaults: prefer a BlackHole input, prefer a non-default
			// output (i.e. an actual DAC). Both are best-effort.
			if (!state.pickedInput) {
				const blackhole = inputs.find((d) => /blackhole/i.test(d.label || ""));
				if (blackhole) {
					state.pickedInput = blackhole.deviceId;
					inputSelect.value = blackhole.deviceId;
				}
			}
			if (!state.pickedOutput && outputs.length > 0) {
				// Pick the first non-empty-labelled output that isn't system
				// default. Falls back to the very first if all are unlabeled.
				const labeled = outputs.find(
					(d) => d.label && !/default/i.test(d.label),
				);
				const pick = labeled ?? outputs[0];
				state.pickedOutput = pick.deviceId;
				select.value = pick.deviceId;
			}
			rerender();
		},
	);

	select.addEventListener("change", () => {
		state.pickedOutput = select.value || null;
		rerender();
	});
	inputSelect.addEventListener("change", () => {
		state.pickedInput = inputSelect.value || null;
		rerender();
	});
}

function fillSelect(
	select: HTMLSelectElement,
	devices: MediaDeviceInfo[],
	emptyLabel: string,
	preselect: string | null,
): void {
	select.replaceChildren();
	const placeholder = document.createElement("option");
	placeholder.value = "";
	placeholder.textContent = `— ${emptyLabel} —`;
	select.appendChild(placeholder);
	for (const d of devices) {
		const opt = document.createElement("option");
		opt.value = d.deviceId;
		opt.textContent = d.label || "(no label)";
		select.appendChild(opt);
	}
	if (preselect && devices.some((d) => d.deviceId === preselect)) {
		select.value = preselect;
	}
}

// Best-effort BlackHole detection. Browsers hide device labels until the
// user has granted media permission at least once, so this requires a
// prior `getUserMedia` call to be useful. We treat any input device with
// "blackhole" in its label as confirmation.
async function detectBlackHole(): Promise<boolean> {
	const devices = await listAudioInputs();
	if (devices.length === 0) return false;
	return devices.some((d) => /blackhole/i.test(d.label || ""));
}

// Heuristic: a user counts as "existing DDPEC user" if they already have
// any non-System-EQ ddpec.* keys in localStorage (presets, theme,
// connection state, etc.). For those users, the wizard never auto-opens
// — they get a "Run wizard…" button in Device Settings instead. New
// users (empty storage) get the auto-show.
//
// Without this guard, every existing DDPEC user gets a surprise modal on
// the first reload after this feature ships. That's the worst kind of
// UX: a tool you've used for months suddenly demanding setup.
function looksLikeExistingDdpecUser(): boolean {
	if (typeof localStorage === "undefined") return false;
	const ownKeys = new Set([
		"ddpec.systemEq",
		"ddpec.systemEq.wizardCompleted",
		"ddpec.systemEq.wizardDeferred",
		"ddpec.systemEq.autoStart",
	]);
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (!k) continue;
			if (k.startsWith("ddpec.") && !ownKeys.has(k)) return true;
		}
	} catch {
		// Storage access denied — fall through to "treat as fresh" so the
		// auto-show still has a chance for genuinely new users.
	}
	return false;
}

// Show the wizard automatically on first launch — call from main.ts after
// the rest of the app is up. Skips if completed, explicitly deferred,
// or if we detect existing DDPEC usage.
export function maybeShowWizardOnFirstRun(): void {
	if (typeof window === "undefined") return;
	if (isWizardCompleted()) return;
	if (isWizardDeferred()) return;
	if (looksLikeExistingDdpecUser()) {
		// Mark as deferred so we don't keep checking; user can still launch
		// from Device Settings → System EQ → Run wizard.
		if (typeof localStorage !== "undefined") {
			try {
				localStorage.setItem("ddpec.systemEq.wizardDeferred", "1");
			} catch {
				// ignore
			}
		}
		return;
	}
	// Defer to the next animation frame so we don't block first paint.
	requestAnimationFrame(() => {
		// Don't auto-open if a modal/dialog is already up (e.g. AutoEQ in
		// the middle of opening). Opening a second dialog stacks them
		// confusingly.
		if (document.querySelector("dialog[open]")) return;
		openSystemEqWizard();
	});
}
