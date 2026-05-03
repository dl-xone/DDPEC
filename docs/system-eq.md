# DDPEC System EQ — v1 Plan

A personal, $0/month equivalent of eqMac built on top of DDPEC. Live host-side
parametric EQ that intercepts macOS system audio (via BlackHole), applies the
user's existing DDPEC band state, and outputs to a chosen device. Coexists with
DDPEC's existing dongle-firmware EQ; never auto-touches the device.

Mac-only, single-user, ships as a Tauri menubar app. Works for the same band
state DDPEC already edits — System EQ is a *second destination* for the
coefficients, not a second tuning model.

---

## Spec (locked, 15 decisions)

| # | Decision |
|---|---|
| 1 | System EQ never writes to the dongle. Passive double-EQ chip if both active. |
| 2 | Shared L+R bands. DSP node structured so per-channel split is a one-line change later. |
| 3 | Source = any OS input device (BlackHole + mic + virtual cable + file). Same dropdown as the existing spectrum analyser. |
| 4 | Output = picker, last choice persisted across sessions. |
| 5 | Tauri menubar app from day one (not browser-first). |
| 6 | No per-app EQ in v1. (Would require Loopback or a custom driver.) |
| 7 | Latency slider hidden under "Advanced" disclosure. Default = comfortable (~30ms). |
| 8 | Presets device-agnostic. Output-bound preset auto-loading deferred. |
| 9 | Main window: System EQ toggle + status pill in header, near the existing "EQ enabled" switch. |
| 10 | Menubar dropdown: on/off, preset picker, output picker, pre-amp slider. |
| 11 | Auto-start at login: optional, off by default, toggle in Device Settings. |
| 12 | Animations: band-point pulse + header level strip + tray icon pulse. Same accent, same decay. |
| 13 | System EQ off = flat passthrough (audio uninterrupted). |
| 14 | First run = three-step wizard, not just a dialog. (Install BlackHole → set system output → pick DDPEC output.) |
| 15 | Menubar icon click → dropdown. "Open editor" button → main window. |

Plus three UX raisers folded into v1:

- **Wizard, not dialog.** Each step shows current vs target state. Dismissible; leaves a "Finish setup" pill in the header until done.
- **Latency under Advanced.** Smart default; the slider only appears if the user opens the disclosure.
- **Routing-drift auto-detect.** When System EQ is on but macOS system output isn't BlackHole, surface a one-click fix pill. Same idea for "dongle EQ isn't flat — possible double-EQ".

---

## Visual language

One vocabulary, used by every surface:

- **Active accent:** existing `#cf4863`. System EQ on = accent everywhere (pill, glow, tray, level strip). No second color introduced.
- **Warning:** amber. Used only when user action is needed.
- **Easing:** ease-out cubic. 180ms for state transitions, 100ms exponential decay for audio-reactive surfaces.
- **Restraint:** every animation is fully quiet within ~150ms of audio stopping. Slick = nothing dances unless audio is moving.

### Surface A — Header status pill + toggle

Sits between the existing "Device status" pill and the Connect button. Same
pill geometry as the device pill so it inherits visual rhythm.

- **Off:** outlined pill, slate dot, label "System EQ".
- **On:** filled accent pill, dot pulses with broad-spectrum RMS, label "System EQ · {DAC short name}".
- **Drift:** amber pill, static dot, "System EQ · Routing issue", inline "Fix" affordance.
- **Click:** popover with on/off, output picker, preset picker, link to dropdown.

### Surface B — Menubar dropdown (280px wide)

```
┌───────────────────────────────────────┐
│ ▁▂▃▄▅▆▇  ← live L/R level strip      │  3px, accent gradient, off=invisible
├───────────────────────────────────────┤
│  System EQ                       ●    │  big toggle, dot breathes when on
│  ───────────────────────────────────  │
│  Output    AKLite (USB)         ▾    │
│  Preset    HD650 — Harman       ▾    │
│  Pre-amp   ▬▬▬▬▬▬●─────  −3 dB       │
├───────────────────────────────────────┤
│  Open editor                       →  │
└───────────────────────────────────────┘
```

Density matches DDPEC's existing instrument-panel feel — sparse, mono labels,
accent only on active controls. The level strip at the top is the "I'm alive"
signal at a glance.

### Surface C — Animations

All driven from a single FFT poll loop sourced from the existing `AnalyserNode`.

1. **Band-point pulse.** Each band dot in the EQ canvas scales `1.0 → 1.4` and
   brightens proportional to FFT energy in its frequency bin. 100ms exponential
   decay.
2. **Header level strip.** 2px full-width strip directly under the header
   border. Fades in over 180ms when audio starts; fades out over 180ms after
   ~150ms of silence. Gradient driven by instantaneous L/R RMS.
3. **Tray icon pulse.** Stylized `●` glyph with soft outer glow that breathes
   with broad-spectrum RMS. 4Hz cap so it never feels frantic.

All three use the same shared `audioReactive.ts` module so they're literally
synchronized.

### Surface D — First-run wizard

Modal, three steps, dismissible (leaves persistent header pill until done).

```
Step 1/3 — Install BlackHole
  Status: [✓ Found 2ch]  or  [⨯ Not detected]
  [Download BlackHole]  [I've installed it — recheck]

Step 2/3 — Route system audio
  Current macOS output: AKLite (USB)
  Target:               BlackHole 2ch
  [Open Sound Settings]   ← deep-link x-apple.systempreferences:com.apple.preference.sound?Output
  [Confirm — output is now BlackHole]

Step 3/3 — Pick DDPEC output
  We'll send EQ'd audio to:  [AKLite (USB)  ▾]   ← detected USB DAC pre-selected
  [Done]
```

Each step shows current vs target. Progress strip at top.

---

## Architecture

### New module: `src/systemEq.ts`

Owns the System EQ DSP node, source/output selection, and lifecycle. Reuses
existing `getContext()` and `buildEqChain()` from `src/signals.ts`.

Public surface:

- `engageSystemEq()` — wire `MediaStreamSource(input) → biquadChain → GainNode → AudioContext.destination(output)`.
- `disengageSystemEq()` — tear down the graph cleanly. Audio must keep flowing — replace biquad chain with a passthrough `GainNode(1.0)`, do not stop the source.
- `setSystemEqInput(deviceId)` — re-attach to a different input device.
- `setSystemEqOutput(deviceId)` — re-route via `setSinkId()`.
- `setSystemEqLatency(ms)` — recreate the AudioContext with the matching `latencyHint`.
- `getSystemEqAnalyser()` — returns the analyser node so `audioReactive.ts` can poll it.

### State additions (`src/state.ts`)

```ts
systemEqEnabled: boolean
systemEqInputDeviceId: string | null
systemEqOutputDeviceId: string | null
systemEqLatencyMs: number       // default 30
systemEqAutoStart: boolean      // default false
systemEqWizardCompleted: boolean
```

Persisted to localStorage alongside existing DDPEC state.

### Shared audio-reactive helper (`src/audioReactive.ts`)

Single FFT poll loop with subscribers. Each subscriber gets a callback with
`{ rms, bandEnergies, peak }` per frame. Decay curve is centralized here so
all three animation surfaces stay synchronized. Implementation: one
`requestAnimationFrame` loop that reads from `getSystemEqAnalyser()`, computes
log-energy in each band's frequency neighbourhood, fans out to subscribers.

### UI surfaces

- `index.html` — System EQ pill in header, level strip element, wizard modal slot.
- `src/style.css` — pill states (off/on/drift), level strip animation, band glow.
- `src/peq.ts` — band-point pulse subscriber.
- `src/main.ts` — wire pill controls, wizard trigger.
- New `src/systemEqDropdown.ts` — menubar dropdown UI (rendered in a separate Tauri webview).
- New `src/wizardSystemEq.ts` — first-run wizard modal.
- New `src/audioReactive.ts` — shared decay/intensity helper.

### Tauri shell (`src-tauri/`)

- Standard Tauri scaffolding (`tauri init`).
- Tray icon with reactive glow via Tauri's `tray` API. Icon updates driven by IPC events from the audioReactive loop (capped at 4Hz to avoid IPC spam).
- Multi-window: main window (full DDPEC) + dropdown window (compact panel from Surface B). Dropdown window is borderless, anchored to tray icon.
- Auto-start via `tauri-plugin-autostart`.
- Login Item registration only if `systemEqAutoStart` is true; user toggles it in Device Settings.

---

## Build phases

Each phase is independently testable. Phase 1 ships as a dev build I can verify
without the Tauri shell.

### Phase 1 — Audio path proof (~½ day)

**Goal:** open DDPEC in Vite dev, pick BlackHole as source, pick DAC as output, hear EQ'd audio.

**Files:**
- New `src/systemEq.ts` — engage/disengage/setInput/setOutput.
- New `src/systemEq.test.ts` — synthetic AudioContext mock test for chain construction.
- Temporary debug toggle in `index.html` for development iteration.

**Verification I can do:**
- Unit tests for chain topology, input/output device switching, latency reconfiguration.
- FFT comparison test: with EQ on, energy at boosted band should exceed input by expected dB; with EQ off, output should match input within tolerance.

**Verification you do:**
1. Audio plays uninterrupted with System EQ off.
2. Audio plays with EQ applied with System EQ on.
3. Toggling does not glitch.
4. Latency feels right at default (~30ms).

### Phase 2 — Main-window UI (~½ day)

- System EQ status pill in header (between device status pill and Connect).
- Off/On/drift visual states.
- Source picker, output picker.
- Latency slider behind "Advanced" disclosure.
- Double-EQ warning chip.

**Files:** `index.html`, `src/style.css`, `src/main.ts`, `src/systemEq.ts` UI hooks.

### Phase 3 — Animations (~½ day)

- New `src/audioReactive.ts` — shared FFT poll, decay curve, subscriber model.
- Band-point pulse subscriber wired in `src/peq.ts`.
- Header level strip subscriber driving CSS custom properties.

**Files:** new `src/audioReactive.ts`, `src/peq.ts`, `src/style.css`, `index.html`.

### Phase 4 — Tauri shell (~1 day)

- Scaffold `src-tauri/`.
- Tray icon with reactive glow (subscriber to audioReactive, 4Hz cap).
- Menubar dropdown window — Surface B layout.
- Auto-start toggle in Device Settings.
- First-run wizard modal — Surface D.

**Files:** new `src-tauri/`, new `src/systemEqDropdown.ts`, new `src/wizardSystemEq.ts`, `src/main.ts` wizard trigger.

### Phase 5 — Polish (~½ day)

- Persisted output choice across sessions (already in state spec).
- Auto-detect routing drift (poll macOS default output via Tauri shell, compare to BlackHole; surface fix pill).
- Sleep/wake recovery (re-attach AudioContext after `visibilitychange` + `AudioContext.state === 'interrupted'`).
- Tray icon pulse polish.
- Double-EQ detection (compare dongle's current coefficients to flat; raise chip).

### Phase 6 — Flair & nice touches (~½–1 day)

The "really really nice to use" pass. Restraint over feature count — every item
on this list earns its keep by removing a friction or making the product feel
unmistakably crafted. Design principle stays the same: nothing dances unless
audio is moving, every animation quiets within 150ms, single accent color.

**Motion & physics**

- Cross-fade on output switching: gain-duck → swap sink → unduck, ~80ms each
  side. Device changes never pop or click.
- 180ms slide+fade for menubar dropdown enter/exit. Main window respects the
  same vocabulary.
- All transitions use ease-out cubic. No springs, no bounces.

**Native macOS feel**

- NSVisualEffectView vibrancy on the dropdown panel via Tauri's
  `transparent + vibrancy` window config. Sits naturally on whatever's behind it.
- Native traffic lights and a proper draggable title region on the main window.
- Respect `prefers-reduced-motion` — disables band glow, level strip, tray
  pulse. Functionality unchanged.
- Optional opt-in to macOS accent color override (if set, replaces `#cf4863`).

**Personality**

- Tray glyph shifts by state: `●` active, `◌` bypassed, `⚠` drift, `◐` engaging.
- Status pill hover tooltip summarizes current source / output / preset /
  pre-amp. No click required for the at-a-glance state.
- Toast copy is specific — "Synced to AKLite — 5 bands updated", never generic
  "Saved!". Reads like a person wrote it.
- First successful engage plays a level-matched 1s confirmation tone through
  the System EQ chain. Subtle proof the wiring works, never repeats unless the
  user re-runs the wizard.

**Power-user touches**

- Global hotkey for System EQ on/off (default Cmd+Shift+E) via
  `tauri-plugin-global-shortcut`. Configurable in Device Settings.
- Quick output switcher entry in the existing command palette
  (`src/commandPalette.ts`).
- Existing `src/haptic.ts` wired into toggle, preset switch, and slider snap
  events on devices that support it.

**Smart defaults**

- Output auto-pick priority on first engage: connected USB DAC → last-used →
  system default. User never sees a "pick an output" empty state on first run.
- Pre-engagement drift check: if BlackHole isn't currently receiving audio
  (silent input stream for >500ms after engage), surface the routing-fix pill
  *before* the user toggles into silence and wonders what broke.

**Files touched:** `src/systemEq.ts` (cross-fade, drift check, smart output
default), `src/style.css` (vibrancy, motion vocabulary), `src/main.ts`
(haptic + toast wiring, hotkey registration), `src/commandPalette.ts`
(output switcher entry), `src-tauri/` (vibrancy config, global shortcut
plugin, tray glyph state machine), `index.html` (tooltip).

**Verification you do:** subjective — does it feel slick? Where does it still
feel off? This phase is iterative; expect a feedback round.

### Phase 7 — QA pass (~½ day)

Catch issues introduced during implementation, verify nothing existing broke,
document what I cannot verify so the user knows where to test.

**Automated checks I run:**

- `npm test` — all existing + new tests pass.
- `npm run build` — TypeScript compiles, Vite produces a clean bundle.
- `npm run format` — Biome lints clean.

**Self-review pass on every new file:** dead code, missing edge cases,
inconsistent naming, leftover debug toggles, unhandled async rejections.

**Cross-cut audit:**

- All new state fields persist correctly across reload.
- System EQ on/off is checked consistently everywhere it matters
  (no double-EQ writes, no orphaned audio nodes after disengage).
- Wizard state machine has no unreachable / dead-end states.
- Drift detection doesn't false-positive on legitimate setups.
- Audio-reactive subscribers all clean up on unmount.

**Manual-verification checklist for the user.** A specific list of things to
listen for / click on / sleep through, organized by phase, so the user knows
exactly what they're verifying when. Lives at the bottom of this doc.

---

## Risks

- **WebHID inside Tauri's WKWebView.** macOS WebView historically has spotty WebHID support. Phase 1 must verify USB DAC connect/sync still works in the Tauri shell, ideally early. Fallback if broken: keep DDPEC running in browser for device editing, run Tauri menubar separately for System EQ; same band state synced via localStorage.
- **Sleep/wake.** AudioContext can enter `interrupted` state when Mac sleeps. Phase 5 handles re-attach, but worth proving early — bad sleep/wake = silent audio with no obvious cause.
- **`setSinkId()` browser support.** Standard in Chromium-based webviews; should work in Tauri's WKWebView on macOS 14+. If not, fallback is routing via the OS default device only (less flexible but functional).
- **BlackHole permission flow.** First install requires user approval in System Settings → Privacy → Audio. Wizard step 1 must surface this clearly.
- **Latency vs. video sync.** 30ms default is fine for music, slightly noticeable for video. The Advanced slider exists for this; document it in the wizard.

---

## Out of scope for v1 (parking lot)

- Per-app EQ (requires Loopback or a custom audio driver).
- Per-channel L/R bands.
- Output-bound preset auto-loading.
- Custom audio driver (no need; BlackHole is good enough for a personal stack).
- Cross-platform (Windows/Linux). Tauri makes this easier later, but not in v1.

---

## Verification I can do without your ears

- Synthetic AudioContext tests for chain construction, source/output selection, latency reconfiguration.
- FFT comparison test: with EQ on, energy at boosted band should exceed input by expected dB; with EQ off, output should match input.
- UI snapshot tests for the new components.
- Integration test: connect → engage System EQ → assert Web Audio graph topology.

## Verification I need you for

- Glitch-free audio at default buffer.
- Subjective tuning matches the predicted graph.
- Animations subtle vs. distracting.
- Latency feel for music vs. video.
- Wizard flow at first launch.
- Sleep/wake recovery (close the lid, open it, audio resumes).

---

## Phase 7 — manual verification checklist

A concrete pass to run on macOS with a USB DAC dongle. Each line maps to
the phase that introduced the behaviour, so a regression points back to a
specific change.

### Phase 1 — audio path
1. Install BlackHole 2ch.
2. `npm run dev` and open the page.
3. In DevTools: `await ddpecSystemEq.listAudioInputs()` — confirm the
   array includes a BlackHole entry (after one `getUserMedia` grant).
4. Set system output to BlackHole 2ch in macOS Sound preferences.
5. `ddpecSystemEq.setSystemEqInput("<BlackHole id>")` and
   `ddpecSystemEq.setSystemEqOutput("<your DAC id>")`.
6. `await ddpecSystemEq.engageSystemEq()` and play any audio.
   - Expect audio through your DAC, EQ applied.
   - No clicks/pops on engage or disengage.
7. `await ddpecSystemEq.disengageSystemEq()` — expect audio to keep
   playing through the system default once the OS reroutes.

### Phase 2 — main-window UI
8. Click the System EQ pill in the header — popover opens beneath it.
   Click outside — popover closes. Press Escape — popover closes.
9. Toggle the switch on; pill turns accent-coloured, dot pulses.
10. Pick a different output from the dropdown — audio swaps without a
    pop (cross-fade applied).
11. Open Advanced disclosure; the latency slider appears with the
    current value labelled (Tight / Balanced / Comfortable).
12. Resize the window and scroll — popover stays anchored to the pill.

### Phase 3 — animations
13. With System EQ engaged and audio playing, the band dots in the EQ
    canvas pulse with the audio (more energy at boosted bands).
14. The thin 2px strip directly below the header glows when audio is
    flowing; fades to invisible when audio stops.
15. Pause audio for >150ms — every animation surface goes quiet.
16. Toggle macOS reduced-motion in System Settings → Accessibility —
    the breathing dot stops, level strip stays invisible, band-pulse
    halos stop drawing.

### Phase 4 — Tauri shell
17. `npm run tauri:dev` — Tauri main window opens with the same layout
    as the browser build. A tray icon appears in the macOS menubar.
18. Click the tray icon — compact dropdown panel slides down beneath it.
    Click elsewhere — dropdown hides.
19. Right-click the tray icon — context menu shows Open editor / Quit.
20. Toggle "Start at login" in Device Settings → System EQ. Quit and
    re-login. Expect DDPEC to start automatically.
21. On a fresh launch (clear `ddpec.systemEq.wizardCompleted` from
    localStorage), the wizard appears. Walk through all three steps.
    Step 1 detect should turn ✓ once BlackHole is installed and a
    `getUserMedia` permission has been granted at least once.

### Phase 5 — drift, double-EQ, sleep/wake
22. Engage System EQ with macOS output set to your DAC (NOT BlackHole)
    — after ~5 seconds, the pill turns amber (drift state).
23. Switch macOS output back to BlackHole — within 3 seconds the pill
    returns to accent.
24. Engage System EQ with the dongle connected and a non-flat preset
    loaded — the popover shows the "Possible double-EQ" chip.
25. Flatten the dongle (load Default preset, sync) — chip clears.
26. Close the laptop lid for >30s, reopen — audio resumes within a few
    seconds. The log tray shows the "AudioContext interrupted… resume"
    sequence.

### Phase 6 — flair
27. Toggle System EQ — taptic feedback fires (if your trackpad supports
    it; reduced-motion respected).
28. Drag the latency slider — taps once per detent change, not buzz.
29. Open Cmd+K palette — search "system eq". Should see Engage /
    Disengage / Setup wizard / Switch output entries. Run "Switch
    output" — picker modal opens with current outputs.
30. Press Cmd+Shift+E from any app on macOS — DDPEC toggles System EQ.
31. Run the wizard to completion — a brief 500 Hz tone plays through
    the System EQ chain after Done.
32. Open the popover with no output set — output dropdown should be
    pre-selected to your connected DAC (smart default).

### Things I cannot verify

- Audible quality of the EQ output (clicks, distortion, frequency
  response correctness on real hardware).
- Tauri build success on macOS — `cargo build` requires the Rust
  toolchain + Tauri's transitive C dependencies. The scaffold matches
  the Tauri 2 / plugin-autostart / plugin-global-shortcut docs.
- macOS-specific behaviours — Login Item registration, Sound
  preferences deep-link, vibrancy on the dropdown panel.
- Hardware-in-the-loop sleep/wake recovery — only checkable on a real
  Mac with a USB DAC connected.

If any of those go sideways, the symptoms map to identifiable code
points: search for `"System EQ:"` in the log tray output (every
relevant module logs there), and check the docs of `setAudioReactiveAnalyser`
/ `engageSystemEq` / `tauriBridge` for the IPC pattern in play.
