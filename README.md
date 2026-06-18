# Whisper Desktop

Whisper Desktop is an Electron-based application that allows users to transcribe speech to text using OpenAI's Whisper model through the Groq API. It provides a simple interface for recording audio and automatically transcribing it into text, which can then be inserted into any active text input field.

![ezgif com-video-to-gif-converter](https://github.com/KernAlan/whisper-desktop/assets/63753020/b8232278-ece9-4f53-a34a-3354be0bcc01)

Tl;dr With the magic that is Whisper and the speed of the Groq servers, I thought I'd spend a weekend to make a tool to help me speak globally into my computer. 

## Features

- Global hotkey (Ctrl+Shift+Space) to start/stop recording
- Command hotkey (Ctrl+Shift+E) to rewrite selected text by voice
- Real-time audio recording using the system microphone
- Rolling live transcript preview while recording
- Automatic microphone selection with device change detection
- Transcription using Groq Whisper models (fast default with fallback)
- Local custom dictionary to bias transcription toward your names and jargon
- Automatic insertion of transcribed text into the active text input field
- Audio recovery — failed recordings are saved instead of deleted
- Chunked transcription — large recordings (>20MB) are auto-split to stay under the API size limit
- Terminal CLI for runtime configuration and diagnostics
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

3. Create a `.env` file in the root directory and add your Groq API key:
   ```
   GROQ_API_KEY=your_api_key_here
   # Optional (defaults shown)
   APP_HOTKEY=CommandOrControl+Shift+Space
   APP_COMMAND_HOTKEY=CommandOrControl+Shift+E
   APP_HIDE_WINDOW_MS=5000
   APP_DONE_HIDE_WINDOW_MS=900
   APP_MEDIARECORDER_TIMESLICE_MS=150
   APP_PREVIEW_INTERVAL_MS=2500
   APP_CLIPBOARD_RESTORE_MODE=deferred
   APP_CLIPBOARD_RESTORE_DELAY_MS=120
   APP_LOG_FILE=logs/app.log
   APP_LOG_MAX_FILES=3
   GROQ_TRANSCRIPTION_MODEL=whisper-large-v3-turbo
   GROQ_FALLBACK_TRANSCRIPTION_MODEL=whisper-large-v3
   GROQ_TRANSCRIPTION_TIMEOUT_MS=25000
   GROQ_TRANSCRIPTION_MAX_QUEUE=2
   GROQ_TEXT_MODEL=llama-3.1-8b-instant
   GROQ_TEXT_TIMEOUT_MS=20000
   ```

   To obtain your Groq API key, visit [https://console.groq.com/keys](https://console.groq.com/keys).

## Usage

1. Start the application:

   ```
   npm start
   ```

2. Press `Ctrl+Shift+Space` (or `Cmd+Shift+Space` on macOS) to start recording
3. Speak into your microphone
4. Press `Ctrl+Shift+Space` again to stop recording and initiate transcription
5. The transcribed text will be automatically inserted into the active text input field

### Trying It Locally

Once the app is running, you can check that the hotkeys and models loaded:

```
node cli.js status
```

Then put your cursor in any text field and try:

- `Ctrl+Shift+Space` to dictate
- `Ctrl+Shift+E` to edit selected text by voice

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
  set text-model <name>      Change command-mode text model
  set hotkey <combo>         Change global shortcut
  set command-hotkey <combo> Change command-mode shortcut
  set injection <mode>       deferred | blocking | off
  set profile <name>         fast | balanced
  set timeslice <ms>         Recorder timeslice (min 50)
  set preview <ms>           Live preview interval (min 1000)
  set restore-delay <ms>     Clipboard restore delay
  refresh mic                Refresh microphone
  test mic                   Test microphone levels
  devices                    List audio inputs
  perf                       Performance stats
  last [n]                   Show last N transcriptions (default 1)
  history                    List recent transcriptions
  dict                       List dictionary terms
  dict add <term>            Add a dictionary term
  dict remove <term>         Remove a dictionary term
  recovery                   List saved recordings
  retry <filename>           Re-transcribe a recovery file
  quit                       Exit
```

You can also send one-shot commands to a running instance:

```
node cli.js status
node cli.js set model whisper-large-v3
node cli.js set hotkey Ctrl+Shift+Z
node cli.js dict add KernAlan
node cli.js perf
node cli.js refresh mic
```

This works from scripts, Stream Deck buttons, or any automation tool.

### Audio Recovery

If a transcription fails (network error, timeout, API limit), the audio is saved to a recovery folder instead of being deleted. Recordings over 20MB are automatically split into chunks before sending to the API.

To list and retry saved recordings:

```
whisper> recovery
  recording-2026-02-16T15-30-00.webm  4.2MB  2026-02-16 15:30:00

whisper> retry recording-2026-02-16T15-30-00.webm
  Transcription (342 chars):
  ...
```

The recovery folder is capped at 10 files. Oldest files are pruned automatically.

### Terminal Diagnostics

On startup, the terminal shows the current configuration. During usage it logs:

- Selected microphone device and refresh events
- Pipeline latency per transcription (`preprocess`, `transcribe`, `paste`, `restore`)
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

- If you encounter issues with global shortcuts, you may need to install `libxtst-dev`:

   ```
   sudo apt-get install libxtst-dev
   ```

## Development

The main components of the application are:

- `cli.js`: Terminal wrapper — interactive REPL and one-shot CLI
- `src/main/main.js`: Main process orchestration + IPC wiring
- `src/main/services/console-service.js`: Named pipe server for CLI commands
- `src/main/services/transcription-service.js`: queue/timeout/fallback transcription pipeline
- `src/main/services/text-processing-service.js`: command-mode rewrite pipeline
- `src/main/services/dictionary-service.js`: persistent custom dictionary
- `src/main/services/typing-service.js`: paste injection with clipboard restore
- `src/main/services/diagnostics-service.js`: startup and runtime terminal diagnostics
- `src/main/ui/window-manager.js`: app window/menu management
- `src/renderer/renderer.js`: renderer bootstrap + UX orchestration
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
