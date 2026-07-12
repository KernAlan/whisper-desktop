# Product Gaps

The product promise is: speak naturally into any interface, get clean text in the right place, and keep working without touching the keyboard.

This document tracks the gaps between that promise and the current product. It is ordered by dependency and user impact, not by implementation convenience.

## Audience And Distribution

Whisper Desktop is currently an open-source tool for people who are comfortable installing software from GitHub and bringing their own provider key. A managed transcription service, subscription, and mainstream commercial onboarding are not current product requirements.

## P0: Trust And Setup

- **In-app credential setup:** a new user must be able to configure or replace the Groq API key without creating an `.env` file. The key must be encrypted at rest and never returned to a renderer.
- **Release-safe runtime:** production dependencies must not contain known critical vulnerabilities. Packaging, signing, updating, and supported-platform requirements need explicit release work.
- **Target and clipboard safety:** insertion must preserve target focus and clipboard contents, fail visibly, and keep generated text available when paste fails.
- **Bounded local storage:** every persistent collection must have explicit entry, age, and byte limits. Cleanup must run automatically after writes and at startup.
- **End-to-end verification:** OS focus, permission, hotkey, selection, and paste behavior require real Electron workflow tests in addition to unit tests.

## P1: Fast Universal Input

- **Streaming transcription:** implemented as one early confidence preview plus persisted, silence-aware checkpoints for long sessions. Short dictations still use one final request.
- **Tail-latency control:** timeouts and provider failures must degrade to a useful draft quickly; a rare 10-second stall damages trust more than small median improvements help it.
- **Optional wake phrase:** implemented as an opt-in local `Hey Whisper` detector with endpointing, no ambient cloud upload, no ambient disk writes, and the global shortcut retained as the dependable baseline. The remaining refinement is a short in-memory pre-roll if dogfooding shows first-word loss.
- **Application compatibility:** maintain a tested matrix for terminals, browsers, Electron apps, native editors, remote desktops, and applications that reject clipboard paste.

## P2: Voice Editing

- **Spoken corrections:** support operations such as scratch that, replace the last sentence, append this, and undo the last insertion.
- **Safe submission:** provide an explicit, configurable way to submit or press Enter without accidental sends.
- **Focused context:** identify the active application and focused input type only when it improves formatting or insertion. Avoid broad screen capture.
- **Developer language:** handle paths, symbols, CLI flags, product names, and repository vocabulary without forcing users to spell every term.

## P3: Product Reach

- **Provider abstraction:** allow additional cloud or local transcription engines without leaking provider choices throughout the UI and pipeline.
- **Personalization:** learn corrections, vocabulary, and formatting preferences locally and per application.
- **Cross-device input:** evaluate mobile only after desktop insertion is consistently reliable and low latency.

## Completed Foundation Milestone

The first milestone was **painless, release-safe setup**:

1. Remove vulnerable and unused input dependencies.
2. Modernize the Electron and build-tool baseline.
3. Add encrypted in-app Groq credential storage and runtime updates.
4. Add focused tests and update setup documentation.

## Delivered: Target Trust And Bounded Recovery

The target-trust milestone is now implemented:

1. The initiating window is captured without recording its title or broad screen contents. Windows, macOS, and Linux have platform-specific restore and paste paths.
2. Dictation activation shows the overlay immediately; target capture completes in the background and is matched to the active recording by an opaque capture id.
3. Successful target-aware insertions are recorded as reversible transactions with a short undo window.
4. History stores raw text, final text, target metadata, paste metadata, and undo state in bounded JSON records. Legacy text records remain readable.
5. Failed audio is pruned by session count, age, and bytes at save time and startup. Successful audio is not retained by default.
6. The previous clipboard is restored by default after insertion. `off` explicitly leaves generated text available on the clipboard.

The remaining P0 gap is real-world coverage across the compatibility matrix and release work such as icons, signing, and supported-platform packaging.

## Next Milestone

The next milestone should deliver **hands-free speed and dogfood reliability**:

1. Measure and reduce stop-to-insert p95 latency, especially polish and provider tail failures.
2. Validate checkpoint boundary quality and final assembly through regular 30-minute meeting dogfooding.
3. Dogfood the local wake phrase across target applications; tune threshold, endpointing, listening-state feedback, and add a short in-memory pre-roll only if first-word loss is observed.
4. Build and maintain a real compatibility matrix for browsers, coding agents, terminals, native editors, remote desktops, and paste-hostile controls.
5. Add spoken correction commands such as scratch that, append this, replace the last sentence, and safe explicit submit.

## Product Decisions

- The keyboard shortcut remains the primary reliable activation method.
- The only planned hands-free activation path is an optional wake phrase.
- Wake detection must run locally. Ambient audio must not be sent to a cloud service until the wake phrase activates a recording.
- Wake detection may keep only a short in-memory pre-roll; it must not continuously write ambient audio to disk.
- Wake mode must include a clear listening indicator, an immediate disable control, an explicit close phrase, and protection against accidental activation. The current implementation uses `Hey Whisper` to start, `Stop Whisper` to finish, and only uses a short pre-speech timeout to discard accidental activations; overlay-level listening feedback remains a dogfood refinement.
- Hardware-specific triggers such as headset buttons, mouse buttons, foot pedals, and external push-to-talk devices are out of scope.
- The existing live transcript preview is the primary user signal that speech is being captured; a separate waveform or audio meter is not required.
- Bring-your-own-key is the intended open-source setup model, not a temporary commercial limitation.
- Privacy work should remain pragmatic engineering hygiene: do not log user content, document what is sent to providers, and bound local retention. An enterprise privacy dashboard is out of scope.
- Rich history should default to text and metadata. Audio is the expensive data type and must never grow without a byte quota and retention policy.

## Dogfooding Method

Work backward from the intended feeling, not from a competitor feature list. A successful interaction should feel:

1. **Ready:** activation works immediately and does not disturb the target.
2. **Heard:** the live preview confirms that speech is being captured.
3. **Understood:** the final text preserves meaning, names, numbers, and technical language.
4. **Landed:** the text appears in the intended place exactly once.
5. **Recoverable:** mistakes, timeouts, and incorrect transformations can be corrected without repeating the original thought.
6. **Uninterrupted:** the user returns to work without reaching for the keyboard or mouse.

The primary product measure is **hands-free completion rate**: the percentage of dictation sessions completed without keyboard or mouse recovery after activation. Supporting measures are:

- Correct-target insertion rate.
- Lost-recording count, which should remain zero.
- Stop-to-insert latency at p50 and p95.
- Paste failure and retry rate by application.
- Raw-to-final correction rate.
- Polish fallback rate and reason.
- Recovery usage rate.
- Local history and recovery disk usage.

Do not add invasive analytics for this stage. Use existing local diagnostics, bounded metadata, and short manual notes during dogfooding.

### Core Scenarios

Exercise these workflows repeatedly rather than relying on one clean demo:

- A one-sentence message in a browser or chat interface.
- A long, loosely spoken prompt into Codex or another coding agent.
- Technical language containing paths, filenames, acronyms, CLI flags, and code identifiers.
- Speech with pauses, restarts, filler, and an explicit self-correction.
- Rewriting selected text with a spoken instruction.
- Switching focus during recording or processing.
- A destination that rejects or delays clipboard paste.
- A provider timeout, offline transition, or failed polish request.
- A microphone disconnect, device change, sleep, and resume.
- A long recording that crosses chunking and recovery boundaries.

Maintain a small compatibility matrix for the applications used in real work. Record whether activation, focus preservation, insertion, multiline text, selection replacement, and submission behave correctly in each one.

### Session Notes

When an interaction feels wrong, capture only enough information to reproduce it:

- Intended outcome.
- Target application and control type.
- Whether keyboard or mouse recovery was required.
- Whether the problem occurred during capture, transcription, polishing, insertion, or recovery.
- Approximate latency and the smallest useful reproduction.

Do not store sensitive dictated content in issue reports. Use a synthetic reproduction when possible.

### Decision Rules

- Fix repeated friction before adding breadth.
- Prefer automatic behavior over another mode or setting when the inference can be made safely.
- Never infer an irreversible action such as submission without an explicit user command or application policy.
- Every failure path must preserve the user's best available text or audio.
- Every persistent data type must declare entry, age, and byte limits before it ships.
- Optimize p95 experience and recovery, not only the fastest successful demonstration.
- A feature is not complete until it works in at least one real target application and has a focused regression test where practical.
- Remove or simplify features that require more attention than they save.
