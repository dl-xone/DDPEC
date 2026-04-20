// Minimal promise-based modal to replace blocking alert/confirm.
// Uses the native <dialog> element so focus handling and Escape-to-close
// are free; falls back to a div-overlay if <dialog> is unsupported.

interface ModalOptions {
	title?: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string | null; // pass null for alert-style (single button)
}

function buildDialog({
	title,
	message,
	confirmLabel = "OK",
	cancelLabel = "Cancel",
}: ModalOptions): {
	dialog: HTMLDialogElement;
	confirmBtn: HTMLButtonElement;
	cancelBtn: HTMLButtonElement | null;
} {
	const dialog = document.createElement("dialog");
	dialog.className =
		"bg-[#1e1e1e] text-gray-200 border border-[#333] rounded-lg p-5 max-w-sm backdrop:bg-black/60";

	const container = document.createElement("div");
	container.className = "flex flex-col gap-4";

	if (title) {
		const h = document.createElement("h3");
		h.className = "font-bold text-lg";
		h.textContent = title;
		container.appendChild(h);
	}

	const p = document.createElement("p");
	p.className = "text-sm text-gray-300";
	p.textContent = message;
	container.appendChild(p);

	const actions = document.createElement("div");
	actions.className = "flex justify-end gap-2 mt-2";

	let cancelBtn: HTMLButtonElement | null = null;
	if (cancelLabel !== null) {
		cancelBtn = document.createElement("button");
		cancelBtn.type = "button";
		cancelBtn.className =
			"px-3 py-1.5 rounded font-semibold bg-gray-700 text-white text-sm hover:bg-gray-600";
		cancelBtn.textContent = cancelLabel;
		actions.appendChild(cancelBtn);
	}

	const confirmBtn = document.createElement("button");
	confirmBtn.type = "button";
	confirmBtn.className =
		"px-3 py-1.5 rounded font-semibold bg-green-500 text-black text-sm hover:bg-green-400";
	confirmBtn.textContent = confirmLabel;
	actions.appendChild(confirmBtn);

	container.appendChild(actions);
	dialog.appendChild(container);
	document.body.appendChild(dialog);

	return { dialog, confirmBtn, cancelBtn };
}

export function confirmModal(
	message: string,
	options: Omit<ModalOptions, "message"> = {},
): Promise<boolean> {
	return new Promise((resolve) => {
		const { dialog, confirmBtn, cancelBtn } = buildDialog({
			...options,
			message,
		});
		let resolved = false;

		function finish(result: boolean) {
			if (resolved) return;
			resolved = true;
			dialog.close();
			dialog.remove();
			resolve(result);
		}

		confirmBtn.addEventListener("click", () => finish(true));
		cancelBtn?.addEventListener("click", () => finish(false));
		// Closing via Escape / backdrop click resolves as cancel.
		dialog.addEventListener("cancel", () => finish(false));
		dialog.addEventListener("close", () => finish(false));

		dialog.showModal();
		confirmBtn.focus();
	});
}

export function alertModal(
	message: string,
	options: Omit<ModalOptions, "message"> = {},
): Promise<void> {
	return confirmModal(message, {
		...options,
		cancelLabel: null,
		confirmLabel: options.confirmLabel ?? "OK",
	}).then(() => undefined);
}

// Wave 4.6 — styled error modal. Visually distinct from alertModal via a
// red accent border so users tell "something broke" apart from "FYI".
// If `retry` is supplied, the primary button invokes it instead of just
// dismissing; the promise resolves true when retry is chosen, false otherwise.
export function errorModal(
	message: string,
	options: {
		title?: string;
		retry?: () => void;
		retryLabel?: string;
		dismissLabel?: string;
	} = {},
): Promise<boolean> {
	return new Promise((resolve) => {
		const { dialog, confirmBtn, cancelBtn } = buildDialog({
			title: options.title ?? "Something went wrong",
			message,
			confirmLabel: options.retry
				? (options.retryLabel ?? "Retry")
				: (options.dismissLabel ?? "Dismiss"),
			cancelLabel: options.retry ? (options.dismissLabel ?? "Dismiss") : null,
		});
		// Override the default surface to get a red left-edge accent.
		dialog.classList.add("border-l-4");
		dialog.style.borderLeftColor = "var(--color-danger)";

		let resolved = false;
		function finish(result: boolean) {
			if (resolved) return;
			resolved = true;
			dialog.close();
			dialog.remove();
			resolve(result);
		}

		confirmBtn.addEventListener("click", () => {
			if (options.retry) {
				try {
					options.retry();
				} catch (err) {
					console.error("errorModal retry threw:", err);
				}
			}
			finish(true);
		});
		cancelBtn?.addEventListener("click", () => finish(false));
		dialog.addEventListener("cancel", () => finish(false));
		dialog.addEventListener("close", () => finish(false));

		dialog.showModal();
		confirmBtn.focus();
	});
}

// Wave 4.6 — inline progress modal for sync/flash. Caller owns the handle;
// calls `update(n)` after each packet and `close()` at the end (or on error).
export interface ProgressHandle {
	update(n: number, label?: string): void;
	close(): void;
}

export function progressModal(options: {
	title: string;
	total: number;
	initial?: number;
}): ProgressHandle {
	const dialog = document.createElement("dialog");
	dialog.className =
		"bg-[#1e1e1e] text-gray-200 border border-[#333] rounded-lg p-5 w-[20rem] max-w-[90vw] backdrop:bg-black/60";
	dialog.setAttribute("aria-busy", "true");

	const container = document.createElement("div");
	container.className = "flex flex-col gap-3";

	const h = document.createElement("h3");
	h.className = "font-bold text-sm";
	h.textContent = options.title;
	container.appendChild(h);

	const counter = document.createElement("div");
	counter.className = "text-xs font-mono text-gray-300";
	counter.textContent = `${options.initial ?? 0} / ${options.total}`;
	container.appendChild(counter);

	const bar = document.createElement("progress");
	bar.className = "w-full h-2";
	bar.max = options.total;
	bar.value = options.initial ?? 0;
	container.appendChild(bar);

	dialog.appendChild(container);
	document.body.appendChild(dialog);
	dialog.showModal();

	return {
		update(n: number, label?: string) {
			const clamped = Math.max(0, Math.min(options.total, n));
			bar.value = clamped;
			counter.textContent = label ?? `${clamped} / ${options.total}`;
		},
		close() {
			dialog.close();
			dialog.remove();
		},
	};
}

// Render a modal with fully custom content. The caller owns the returned
// dialog and decides when to close it.
export function customModal(
	title: string,
	content: HTMLElement,
	options: { cancelLabel?: string } = {},
): HTMLDialogElement {
	const dialog = document.createElement("dialog");
	dialog.className =
		"bg-[#1e1e1e] text-gray-200 border border-[#333] rounded-lg p-5 w-[28rem] max-w-[90vw] backdrop:bg-black/60";

	const container = document.createElement("div");
	container.className = "flex flex-col gap-4";

	const h = document.createElement("h3");
	h.className = "font-bold text-lg";
	h.textContent = title;
	container.appendChild(h);

	container.appendChild(content);

	const actions = document.createElement("div");
	actions.className = "flex justify-end";
	const close = document.createElement("button");
	close.type = "button";
	close.className =
		"px-3 py-1.5 rounded font-semibold bg-gray-700 text-white text-sm hover:bg-gray-600";
	close.textContent = options.cancelLabel ?? "Close";
	close.addEventListener("click", () => {
		dialog.close();
		dialog.remove();
	});
	actions.appendChild(close);
	container.appendChild(actions);

	dialog.appendChild(container);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.appendChild(dialog);
	dialog.showModal();
	return dialog;
}

// List-select modal: renders a scrollable list of options and resolves
// with the chosen id (or null if cancelled).
export interface PickerItem {
	id: string;
	title: string;
	subtitle?: string;
}

// Searchable picker: like pickerModal but with a text input that
// filters title+subtitle as the user types.
export function searchPickerModal(
	items: PickerItem[],
	options: {
		title?: string;
		cancelLabel?: string;
		placeholder?: string;
	} = {},
): Promise<string | null> {
	return new Promise((resolve) => {
		const dialog = document.createElement("dialog");
		dialog.className =
			"bg-[#1e1e1e] text-gray-200 border border-[#333] rounded-lg p-5 w-[32rem] max-w-[95vw] backdrop:bg-black/60";

		const container = document.createElement("div");
		container.className = "flex flex-col gap-3";

		if (options.title) {
			const h = document.createElement("h3");
			h.className = "font-bold text-lg";
			h.textContent = options.title;
			container.appendChild(h);
		}

		const search = document.createElement("input");
		search.type = "search";
		search.placeholder = options.placeholder ?? "Filter…";
		search.className =
			"w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100";
		container.appendChild(search);

		const list = document.createElement("div");
		list.className = "flex flex-col gap-1 max-h-[60vh] overflow-y-auto";
		container.appendChild(list);

		let resolved = false;
		function finish(id: string | null) {
			if (resolved) return;
			resolved = true;
			dialog.close();
			dialog.remove();
			resolve(id);
		}

		function render(filter: string) {
			list.replaceChildren();
			const q = filter.trim().toLowerCase();
			let shown = 0;
			for (const item of items) {
				if (q) {
					const hay = `${item.title} ${item.subtitle ?? ""}`.toLowerCase();
					if (!hay.includes(q)) continue;
				}
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className =
					"text-left p-2 rounded bg-gray-800 hover:bg-gray-700 border border-transparent hover:border-gray-600 transition-colors";
				const title = document.createElement("div");
				title.className = "text-sm font-semibold text-gray-100";
				title.textContent = item.title;
				btn.appendChild(title);
				if (item.subtitle) {
					const sub = document.createElement("div");
					sub.className = "text-xs text-gray-400";
					sub.textContent = item.subtitle;
					btn.appendChild(sub);
				}
				btn.addEventListener("click", () => finish(item.id));
				list.appendChild(btn);
				shown++;
				if (shown >= 300) break; // cap for DOM sanity
			}
			if (shown === 0) {
				const empty = document.createElement("div");
				empty.className = "text-xs text-gray-500 p-2";
				empty.textContent = "No matches.";
				list.appendChild(empty);
			}
		}

		search.addEventListener("input", () => render(search.value));
		render("");

		const actions = document.createElement("div");
		actions.className = "flex justify-end";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className =
			"px-3 py-1.5 rounded font-semibold bg-gray-700 text-white text-sm hover:bg-gray-600";
		cancel.textContent = options.cancelLabel ?? "Cancel";
		cancel.addEventListener("click", () => finish(null));
		actions.appendChild(cancel);
		container.appendChild(actions);

		dialog.appendChild(container);
		dialog.addEventListener("cancel", () => finish(null));
		dialog.addEventListener("close", () => finish(null));
		document.body.appendChild(dialog);
		dialog.showModal();
		setTimeout(() => search.focus(), 0);
	});
}

export function pickerModal(
	items: PickerItem[],
	options: { title?: string; cancelLabel?: string } = {},
): Promise<string | null> {
	return new Promise((resolve) => {
		const dialog = document.createElement("dialog");
		dialog.className =
			"bg-[#1e1e1e] text-gray-200 border border-[#333] rounded-lg p-5 w-[28rem] max-w-[90vw] backdrop:bg-black/60";

		const container = document.createElement("div");
		container.className = "flex flex-col gap-4";

		if (options.title) {
			const h = document.createElement("h3");
			h.className = "font-bold text-lg";
			h.textContent = options.title;
			container.appendChild(h);
		}

		const list = document.createElement("div");
		list.className = "flex flex-col gap-2 max-h-[50vh] overflow-y-auto";
		let resolved = false;

		function finish(id: string | null) {
			if (resolved) return;
			resolved = true;
			dialog.close();
			dialog.remove();
			resolve(id);
		}

		for (const item of items) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className =
				"text-left p-3 rounded bg-gray-800 hover:bg-gray-700 border border-transparent hover:border-gray-600 transition-colors";
			const title = document.createElement("div");
			title.className = "font-semibold text-gray-100";
			title.textContent = item.title;
			btn.appendChild(title);
			if (item.subtitle) {
				const sub = document.createElement("div");
				sub.className = "text-xs text-gray-400 mt-1";
				sub.textContent = item.subtitle;
				btn.appendChild(sub);
			}
			btn.addEventListener("click", () => finish(item.id));
			list.appendChild(btn);
		}

		container.appendChild(list);

		const actions = document.createElement("div");
		actions.className = "flex justify-end";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className =
			"px-3 py-1.5 rounded font-semibold bg-gray-700 text-white text-sm hover:bg-gray-600";
		cancel.textContent = options.cancelLabel ?? "Cancel";
		cancel.addEventListener("click", () => finish(null));
		actions.appendChild(cancel);
		container.appendChild(actions);

		dialog.appendChild(container);
		dialog.addEventListener("cancel", () => finish(null));
		dialog.addEventListener("close", () => finish(null));
		document.body.appendChild(dialog);
		dialog.showModal();
	});
}
