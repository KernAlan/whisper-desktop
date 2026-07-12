# Whisper Desktop

Whisper Desktop is an Electron-based application that allows users to transcribe speech to text using OpenAI's Whisper model through the Groq API. It provides a simple interface for recording audio and automatically transcribing it into text, which can then be inserted into any active text input field.

## Download

<p align="center">
  <a href="https://github.com/KernAlan/whisper-desktop/releases/latest/download/Whisper-Desktop-Windows-Setup.exe"><img src="https://img.shields.io/badge/Windows-Download-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows"></a><br><br>
  <a href="https://github.com/KernAlan/whisper-desktop/releases/latest/download/Whisper-Desktop-macOS-Apple-Silicon.dmg"><img src="https://img.shields.io/badge/macOS_Apple_Silicon-Download-111111?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS Apple Silicon"></a><br><br>
  <a href="https://github.com/KernAlan/whisper-desktop/releases/latest/download/Whisper-Desktop-macOS-Intel.dmg"><img src="https://img.shields.io/badge/macOS_Intel-Download-111111?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS Intel"></a>
</p>

The buttons above always point to the latest GitHub release. The app uses your own Groq API key; after installation, enter it in **Settings**.

![ezgif com-video-to-gif-converter](https://github.com/KernAlan/whisper-desktop/assets/63753020/b8232278-ece9-4f53-a34a-3354be0bcc01)

Tl;dr With the magic that is Whisper and the speed of the Groq servers, I thought I'd spend a weekend to make a tool to help me speak globally into my computer. 

## Features

- Global hotkey (Ctrl+Shift+Space) to start/stop recording
- Optional local "Hey Whisper" wake phrase for hands-free dictation
- Command hotkey (Ctrl+Shift+E) to rewrite selected text by voice
- Real-time audio recording using the system microphone
- Early live preview followed by stable long-session checkpoints
- Automatic microphone selection with device change detection
- Transcription using Groq Whisper models (fast default with fallback)
- Optional polished dictation using a text model for punctuation, capitalization, and formatting
- Local custom dictionary to bias transcription toward your names and jargon
- Target-aware insertion of transcribed text into the field that started dictation
- Reversible recent insertion with an **Undo Last Insert** recovery action
- Clipboard restoration by default, with an opt-out for keeping generated text on the clipboard
- Audio recovery — failed recordings are saved instead of deleted
- Chunked transcription — large recordings (>20MB) are auto-split to stay under the API size limit
- Terminal CLI for runtime configuration and diagnostics
- Settings window for hotkeys, modes, models, dictionary terms, and long-text tuning
- Encrypted in-app Groq API key setup using the operating system credential store
- Saved settings so runtime tweaks survive restarts
- One-shot CLI commands for scripting and automation

## Installation

1. Clone the repository:

   ```
   git clone https://github.com/kernalan/whisper-desktop.git
   cd whisper-desktop
   ```

2. Install dependencies:

   ```
   npm install
   ```

3. Start the application, open **Settings**, and enter your Groq API key under **Speech Service**. The key is encrypted with the operating system credential store and is never displayed again.

   You can obtain a key from [Groq Console](https://console.groq.com/keys).

   For development or managed environments, you can instead create a `.env` file and set `GROQ_API_KEY`:
   ```
   GROQ_API_KEY=your_api_key_here
   # Optional (defaults shown)
   APP_HOTKEY=CommandOrControl+Shift+Space
   APP_COMMAND_HOTKEY=CommandOrControl+Shift+E
   APP_HIDE_WINDOW_MS=5000
   APP_DONE_HIDE_WINDOW_MS=900
   APP_MEDIARECORDER_TIMESLICE_MS=150
   APP_PREVIEW_INTERVAL_MS=2500
   APP_DICTATION_MODE=polished
   APP_WAKE_PHRASE_ENABLED=false
   APP_PASTE_CHUNK_CHARS=1500
   APP_PASTE_CHUNK_DELAY_MS=80
   APP_CLIPBOARD_RESTORE_MODE=deferred
   APP_CLIPBOARD_RESTORE_DELAY_MS=120
   APP_LOG_FILE=logs/app.log
   APP_LOG_MAX_FILES=3
   APP_LOG_MAX_BYTES=2097152
   GROQ_TRANSCRIPTION_MODEL=whisper-large-v3-turbo
   GROQ_FALLBACK_TRANSCRIPTION_MODEL=whisper-large-v3
   GROQ_TRANSCRIPTION_TIMEOUT_MS=5000
   GROQ_TRANSCRIPTION_MAX_QUEUE=2
   GROQ_TEXT_MODEL=llama-3.1-8b-instant
   GROQ_TEXT_TIMEOUT_MS=20000
   GROQ_POLISH_CHUNK_WORDS=450
   GROQ_POLISH_MAX_WORDS=10000
   ```

## Usage

1. Start the application:

   ```
   npm start
   ```

2. Press `Ctrl+Shift+Space` (or `Cmd+Shift+Space` on macOS) to start recording
3. Speak into your microphone
4. Press `Ctrl+Shift+Space` again to stop recording and initiate transcription
5. The transcribed text will be automatically inserted into the active text input field

By default, dictation is lightly polished before paste. It should preserve content words and only drop obvious filler/speech artifacts. Set `APP_DICTATION_MODE=fast` or run `set dictation fast` if you want raw Whisper output with less latency.

For hands-free use, enable **Wake Phrase** in Settings or run `node cli.js set wake on`. The local detector listens for `Hey Whisper` on the selected microphone, then opens dictation. Say `Stop Whisper` to finish; pauses are preserved, and a short pre-speech timeout only cancels accidental activations. Ambient audio stays local and in memory until activation; the normal Groq transcription request starts only after speech is captured. Disable it with `node cli.js set wake off` or from Settings. The keyboard shortcut remains available as the dependable manual fallback.

Short dictations use one final transcription request. Longer recordings are persisted and transcribed as standalone, silence-aware checkpoints, then assembled before polishing. Polishing runs in text chunks up to `GROQ_POLISH_CHUNK_WORDS`; recordings over `GROQ_POLISH_MAX_WORDS` paste the raw transcript.

Long inserts are pasted in chunks too. The app preserves your clipboard once, pastes each chunk, then restores the clipboard after the full insert.
Set `APP_CLIPBOARD_RESTORE_MODE=off` when you prefer the inserted text to remain on the clipboard for follow-up use.

### Trying It Locally

Once the app is running, you can check that the hotkeys and models loaded:

```
node cli.js status
```

Then put your cursor in any text field and try:

- `Ctrl+Shift+Space` to dictate
- `Ctrl+Shift+E` to edit selected text by voice

Open settings from the terminal if you want to change the main runtime options without remembering every CLI command:

```
node cli.js settings
```

The settings window is also where you connect or replace the Groq API key. A securely saved key takes precedence over `GROQ_API_KEY`; clearing it returns to the environment key when one is present.

Settings changed from the window or CLI are saved locally and loaded next time. The `.env` file is still the default source, and `reset settings` goes back to those defaults.

To shut it down from the terminal:

```
node cli.js quit
```

### Command Mode

1. Select text in any app
2. Press `Ctrl+Shift+E` (or `Cmd+Shift+E` on macOS)
3. Say an instruction like "make this shorter" or "turn this into bullets"
4. Press the command hotkey again to stop
5. The selected text is replaced with the rewritten result

This uses the text model configured by `GROQ_TEXT_MODEL`.

If no selected text is captured, the overlay says so and command mode treats your instruction as a request to generate new text instead of rewriting a selection.

### Dictionary

If Whisper keeps getting a name, acronym, or product term wrong, add it to the local dictionary:

```
node cli.js dict add KernAlan
node cli.js dict
node cli.js dict remove KernAlan
```

Dictionary terms are stored locally and used as hints during transcription and command mode.

### CLI

`npm start` launches an interactive console where you can configure the app at runtime:

```
whisper> help
  status                     Show current config
  set model <name>           Change transcription model
  set text-model <name>      Change cleanup/command text model
  set dictation <mode>       fast | polished
  set wake <on|off>          Enable or disable the local wake phrase
  set hotkey <combo>         Change global shortcut
  set command-hotkey <combo> Change command-mode shortcut
  set injection <mode>       deferred | blocking | off
  set profile <name>         fast | balanced
  set timeslice <ms>         Recorder timeslice (min 50)
  set preview <ms>           Initial live preview delay (min 1000)
  set timeout <ms>           Transcription timeout (min 3000)
  set restore-delay <ms>     Clipboard restore delay
  refresh mic                Refresh microphone
  test mic                   Test microphone levels
  devices                    List audio inputs
  perf                       Performance stats
  settings                   Open settings window
  reset settings             Reset saved settings to .env/defaults
  last [n]                   Show last N transcriptions (default 1)
  last-command               Show last command-mode run
  history                    List recent transcriptions
  dict                       List dictionary terms
  dict suggest               Suggest terms from recent transcripts
  dict add-suggested [n]     Add suggested terms
  dict add <term>            Add a dictionary term
  dict remove <term>         Remove a dictionary term
  recovery                   List saved recordings
  retry <latest|file|session> Re-transcribe saved audio
  quit                       Exit
```

You can also send one-shot commands to a running instance:

```
node cli.js status
node cli.js set model whisper-large-v3
node cli.js set dictation fast
node cli.js set wake on
node cli.js set hotkey Ctrl+Shift+Z
node cli.js dict add KernAlan
node cli.js perf
node cli.js refresh mic
node cli.js reset settings
```

This works from scripts, Stream Deck buttons, or any automation tool.

### Audio Recovery

If a transcription fails (network error, timeout, API limit), the audio is saved to a recovery folder instead of being deleted. The app retries the saved audio automatically. If that still fails, the overlay stays open with a retry button. If there is partial text, it is copied to your clipboard and you can copy it again from the overlay.

Long recordings are saved as one checkpoint recovery session, so retry works on the whole recording without manual stitching. Checkpoint audio is removed after successful insertion. Failed audio is bounded by session count, age, and total bytes; successful short-dictation audio is not retained.

To list and retry saved recordings:

```
whisper> recovery
  recording-2026-02-16T15-30-00.webm  4.2MB  2026-02-16 15:30:00

whisper> retry latest
  Transcription (342 chars):
  ...
```

The CLI is a backup path. `retry latest` works for both normal recordings and long chunked sessions. You can also retry a specific filename or session id from `recovery`.

The recovery folder is capped at 10 sessions. Oldest sessions are pruned automatically.

### Terminal Diagnostics

On startup, the terminal shows the current configuration. During usage it logs:

- Selected microphone device and refresh events
- Pipeline latency per transcription (`preprocess`, `transcribe`, `polish`, `paste`, paste chunks, `restore`)
- Rolling performance summaries every 10 runs (`p50`/`p95`)
- Persistent daily logs (`app-YYYYMMDD.log`) in the configured log directory

### Platform-Specific Notes

#### macOS
- You may need to grant permission for the app to access your microphone. If prompted, allow microphone access in System Preferences > Security & Privacy > Privacy > Microphone.

#### Linux
- Ensure you have the necessary audio libraries installed. On Ubuntu or Debian-based systems, you might need to run:

   ```
   sudo apt-get install libasound2-dev
   ```

- Install `xdotool` for selection capture and text insertion:

   ```
   sudo apt-get install xdotool
   ```

## Development

The main components of the application are:

- `cli.js`: Terminal wrapper — interactive REPL and one-shot CLI
- `settings.html`: Settings window
- `src/main/main.js`: Main process orchestration + IPC wiring
- `src/main/services/console-service.js`: Named pipe server for CLI commands
- `src/main/services/runtime-settings-service.js`: saved runtime settings
- `src/main/services/credential-service.js`: encrypted Groq API key persistence
- `src/main/services/transcription-service.js`: queue/timeout/fallback transcription pipeline
- `src/main/services/text-processing-service.js`: command-mode rewrite pipeline
- `src/main/services/dictionary-service.js`: persistent custom dictionary
- `src/main/services/typing-service.js`: paste injection with clipboard restore
- `src/main/services/diagnostics-service.js`: startup and runtime terminal diagnostics
- `src/main/ui/window-manager.js`: app window/menu management
- `src/renderer/renderer.js`: renderer bootstrap + UX orchestration
- `src/renderer/core/wake-controller.js`: local wake lifecycle and PCM resampling
- `src/main/services/wake-word-service.js`: sherpa-onnx keyword detector
- `src/renderer/settings.js`: settings window controller
- `src/renderer/core/`: state machine, device manager, audio engine, recorder controller
- `src/shared/config.js`: runtime config parsing and validation

To modify the application:

1. Make changes to the relevant files
2. Restart the application to see the changes

### Checks and Tests

```bash
npm run check
npm test
```

## Building

To build the application for distribution:

   ```
   npm run build
   ```

The packaged application includes the small Apache-2.0 English wake model as an external resource so the native detector can read it without writing model data into the user profile.

This will create distributable packages for your platform in the `dist` folder.

## Troubleshooting

If you encounter any issues with audio recording or transcription:

1. Ensure your microphone is properly connected and selected as the default input device
2. Check the console logs for any error messages
3. Verify that your Groq API key is correctly set in the `.env` file
4. If Windows selects the wrong Bluetooth microphone, start speaking once after connecting your device. The app auto-refreshes its mic selection when devices change.
5. If the CLI can't connect, make sure the app is running (`npm start` or `npm run dev`).

## Roadmap

The following are ideas for future development:

- Allow for using different providers (e.g. OpenAI or self-host)
- Make the UI more customizable
- Add a feature to save and manage transcription history
- Develop a mobile companion app for remote control and syncing
- Implement advanced audio processing for noise reduction and speaker separation

This was done in a weekend, so I don't have any specific plans to implement any of these yet.

## License

This project is licensed under the Apache License 2.0. See the LICENSE file for details.
