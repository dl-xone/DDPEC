// Tauri bridge — only meaningful when running inside the Tauri shell.
// In browser dev / production PWA, this whole module is inert: it
// detects the absence of __TAURI_INTERNALS__ early and exits.
//
// What it does in Tauri mode:
//   - Listens for ddpec:cmd:* events emitted by the Rust side (tray click,
//     dropdown actions) and routes them to the relevant systemEq calls.
//   - Exposes the autostart plugin to systemEqUi.ts via window.ddpecTauriAutoStart
//     so the Device Settings toggle can flip the OS-level Login Item.
//   - Exposes openMainWindow / requestEngage / requestDisengage / setPreamp
//     to the dropdown webview so its UI can drive the main window.
//
// All Tauri-API imports are lazy / dynamic. If the @tauri-apps/* packages
// aren't installed (browser dev), the imports throw and we swallow the
// error rather than blowing up the whole app.

import { log, setGlobalGain as setGlobalGainFromEvent } from "./helpers.ts";
import {
	disengageSystemEq,
	engageSystemEq,
	isSystemEqActive,
	setSystemEqOutput,
} from "./systemEq.ts";

interface AutoStartPlugin {
	enable: () => Promise<void>;
	disable: () => Promise<void>;
	isEnabled: () => Promise<boolean>;
}

interface TauriBridge {
	openMainWindow: () => Promise<void>;
	requestEngage: () => Promise<void>;
	requestDisengage: () => Promise<void>;
	setPreamp: (db: number) => Promise<void>;
}

type TauriEvent<T> = { payload: T };
type TauriListen = <T = unknown>(
	event: string,
	handler: (e: TauriEvent<T>) => void,
) => Promise<() => void>;
type TauriInvoke = (
	cmd: string,
	args?: Record<string, unknown>,
) => Promise<unknown>;

function isTauri(): boolean {
	return (
		typeof window !== "undefined" &&
		(window as unknown as { __TAURI_INTERNALS__?: unknown })
			.__TAURI_INTERNALS__ !== undefined
	);
}

export async function initTauriBridge(): Promise<void> {
	if (!isTauri()) return;

	try {
		// Dynamic imports so the browser bundle doesn't fail when the
		// @tauri-apps/* packages aren't installed (browser preview).
		// Cast through unknown — these packages may or may not be
		// resolvable at type-check time depending on whether `npm
		// install` has fetched them yet.
		const [eventMod, coreMod] = await Promise.all([
			import(/* @vite-ignore */ "@tauri-apps/api/event" as string),
			import(/* @vite-ignore */ "@tauri-apps/api/core" as string),
		]);
		const listen = (eventMod as { listen: TauriListen }).listen;
		const invoke = (coreMod as { invoke: TauriInvoke }).invoke;

		// Wire the four IPC commands the dropdown can call. Each forwards
		// to the in-process systemEq state; the Rust side just routes
		// the click and lets the webview do the work.
		const bridge: TauriBridge = {
			openMainWindow: async () => {
				await invoke("open_main_window");
			},
			requestEngage: async () => {
				await invoke("request_engage_main");
			},
			requestDisengage: async () => {
				await invoke("request_disengage_main");
			},
			setPreamp: async (db: number) => {
				await invoke("set_preamp_main", { db });
			},
		};
		(window as unknown as { ddpecTauriBridge: TauriBridge }).ddpecTauriBridge =
			bridge;

		// Listen for commands the Rust shell forwards from the dropdown
		// window. The main window's webview is the only one that owns the
		// audio context, so engagement always happens here.
		await listen("ddpec:cmd:engage", async () => {
			try {
				await engageSystemEq();
			} catch (err) {
				log(`System EQ: engage from tray failed (${(err as Error).message})`);
			}
		});
		await listen("ddpec:cmd:disengage", async () => {
			try {
				await disengageSystemEq();
			} catch (err) {
				log(
					`System EQ: disengage from tray failed (${(err as Error).message})`,
				);
			}
		});
		// Cmd+Shift+E global hotkey — Rust emits this; we figure out which
		// way to flip it based on current state.
		await listen("ddpec:cmd:toggle", async () => {
			try {
				if (isSystemEqActive()) await disengageSystemEq();
				else await engageSystemEq();
			} catch (err) {
				log(`System EQ: hotkey toggle failed (${(err as Error).message})`);
			}
		});
		await listen<number>("ddpec:cmd:preamp", (event) => {
			const db = Number(event.payload);
			if (Number.isFinite(db)) {
				// Reuse helpers.setGlobalGain by synthesising an Event with
				// the expected target.value shape. Avoids a parallel write
				// path to update both UI + device + state.
				const fakeInput = document.createElement("input");
				fakeInput.value = String(db);
				const fakeEvent = { target: fakeInput } as unknown as Event;
				void setGlobalGainFromEvent(fakeEvent);
			}
		});
		await listen<string>("ddpec:cmd:set-output", async (event) => {
			const id = String(event.payload);
			await setSystemEqOutput(id || null);
		});

		// Expose the autostart plugin so systemEqUi.ts can flip the login
		// item without re-importing @tauri-apps/* (and without making
		// systemEqUi.ts Tauri-aware).
		try {
			const autostart = (await import(
				/* @vite-ignore */ "@tauri-apps/plugin-autostart" as string
			)) as AutoStartPlugin;
			(
				window as unknown as { ddpecTauriAutoStart: AutoStartPlugin }
			).ddpecTauriAutoStart = autostart;
		} catch (err) {
			log(`Tauri autostart plugin missing (${(err as Error).message})`);
		}

		log("Tauri bridge ready.");
	} catch (err) {
		log(`Tauri bridge init failed (${(err as Error).message})`);
	}
}
