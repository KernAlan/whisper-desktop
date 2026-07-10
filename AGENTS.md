# Product Direction

Whisper Desktop is a universal voice keyboard, not a general-purpose agent.

## Core Promise

Speak naturally into any interface, get clean text in the right place, and keep working without touching the keyboard.

The product should make voice a dependable replacement for keyboard input across coding agents, terminals, editors, browsers, chat applications, and other text interfaces. It is a bridge into tools such as Codex, Claude Code, and other agents; it should not attempt to replace those tools or duplicate their reasoning and execution capabilities.

## Product Priorities

1. Insert text into the intended field reliably without stealing or losing focus.
2. Preserve the user's meaning while producing clean, appropriately formatted text.
3. Minimize the need to use a keyboard or mouse for activation, correction, editing, and submission.
4. Keep stop-to-insert latency low and make failures recoverable without losing speech.
5. Adapt narrowly to the active interface when useful, such as prose, Markdown, terminal, or coding-agent prompts.
6. Make installation, permissions, microphone setup, and everyday operation painless.

## Interaction Scope

The product may support:

- Universal voice dictation.
- Spoken corrections and editing commands.
- Basic interface commands such as submit, cancel, undo, and new line.
- Developer vocabulary, file paths, symbols, and application-aware formatting.

The product should not grow into:

- A replacement for coding agents or assistants.
- A general autonomous computer-use agent.
- A system that reads or reasons over the entire screen when focused input context is sufficient.

When choosing between features, prefer the option that makes speaking into existing tools faster, more reliable, and less dependent on keyboard or mouse input.

## Runtime Model

Whisper Desktop is an Electron application with a small overlay and a separate settings window.

The primary flow is:

1. Electron registers a global shortcut in the main process.
2. The shortcut opens the inactive overlay without taking focus from the target application.
3. The renderer records microphone audio and displays recording or preview state.
4. Audio crosses the preload IPC bridge to the main process for Groq transcription.
5. Dictation may be polished, or command mode may transform selected text.
6. The main process captures the initiating target asynchronously, returns focus to it, and inserts the result through the clipboard and native paste shortcuts.
7. Transcripts, diagnostics, settings, dictionary terms, and failed audio are stored locally under Electron's user-data directory.

Preserving the original target, user intent, clipboard contents, and recoverable audio is more important than adding another transformation step.

## Codebase Index

- `src/main/main.js`: application lifecycle, global shortcuts, service construction, IPC handlers, and runtime wiring.
- `src/main/ui/window-manager.js`: overlay and settings windows, positioning, visibility, and focus behavior.
- `src/main/services/transcription-service.js`: Groq transcription, preview requests, queueing, timeouts, model fallback, chunking, and audio recovery.
- `src/main/services/text-processing-service.js`: polished dictation and voice-command text transformations.
- `src/main/services/typing-service.js`: target insertion, native paste shortcuts, selection capture, clipboard preservation, and restoration.
- `src/main/services/target-context-service.js`: cross-platform active-window capture and target restoration for paste, copy, and undo.
- `src/main/services/runtime-settings-service.js`: saved mutable settings and validation.
- `src/main/services/credential-service.js`: encrypted API credential persistence through Electron secure storage.
- `src/main/services/dictionary-service.js`: local vocabulary and transcription prompt hints.
- `src/main/services/transcript-store.js`: local transcript history and pruning.
- `src/main/services/diagnostics-service.js`: pipeline metrics, runtime diagnostics, and dictionary suggestions.
- `src/main/services/console-service.js`: commands accepted from the terminal CLI.
- `src/preload/preload.js`: the context-isolated API exposed to renderer windows.
- `src/renderer/renderer.js`: overlay DOM updates, event wiring, and renderer bootstrap.
- `src/renderer/core/recorder-controller.js`: recording state, preview scheduling, final processing, retries, cancellation, and paste orchestration.
- `src/renderer/core/audio-engine.js`: microphone stream and Web Audio lifecycle.
- `src/renderer/core/device-manager.js`: microphone discovery and selection.
- `src/renderer/core/recorder-state-machine.js`: legal recorder states and transitions.
- `src/shared/config.js`: environment defaults and startup configuration validation.
- `index.html`: overlay markup and styling.
- `settings.html` and `src/renderer/settings.js`: settings interface and behavior.
- `cli.js`: interactive and one-shot terminal entry point.
- `test/`: Node test suite organized by service or renderer behavior.

## Where To Make Changes

- Recording, microphone, or device behavior: start in `src/renderer/core/`.
- Transcription latency, models, preview, chunking, or recovery: start in `transcription-service.js` and `recorder-controller.js`.
- Dictation cleanup or spoken editing behavior: start in `text-processing-service.js`.
- Focus, selection, clipboard, or insertion failures: start in `typing-service.js` and `window-manager.js`.
- Active-window capture or target-aware undo: start in `target-context-service.js` and trace into `main.js` and `recorder-controller.js`.
- Overlay presentation or interaction: change `index.html` and `renderer.js` together.
- Settings: trace the full path through `settings.html`, `renderer/settings.js`, `runtime-settings-service.js`, and `main.js`.
- Hotkeys, application startup, resume handling, or IPC: start in `main.js` and `preload.js`.
- CLI commands: change `cli.js` only for client behavior; add application commands in `console-service.js`.
- History, logs, metrics, or vocabulary: use the corresponding service rather than adding storage logic to a renderer.

## Engineering Invariants

- Do not steal focus from the application receiving dictated text.
- Never discard captured audio on a failed transcription path.
- Preserve the user's content words unless they explicitly request a rewrite.
- Keep raw transcription available when polishing fails or is rejected.
- Preserve and restore all clipboard formats, not only plain text, when restoration is enabled.
- Restore the previous clipboard by default after insertion; `off` is the explicit opt-out that leaves generated text available there.
- Keep target-aware insertion fail-closed when the initiating target cannot be restored.
- Keep renderer access behind `preload.js`; retain `contextIsolation: true` and `nodeIntegration: false`.
- Treat transcript, clipboard, selection, and recovery data as private local user data. Do not log their full contents.
- Keep configuration defaults in `src/shared/config.js` and saved runtime behavior in `runtime-settings-service.js`.
- Add focused tests for changed failure paths, shared behavior, and lifecycle transitions.

## Development Commands

```powershell
npm install
npm start       # Start or attach through the terminal CLI
npm run dev     # Launch Electron directly
npm test
npm run check
npm run build
```

Before finishing a change, run `npm test` and `npm run check`. For focus, paste, hotkey, microphone, or window changes, also exercise the real Electron workflow in at least one target application; unit tests do not reproduce operating-system focus and permission behavior.
