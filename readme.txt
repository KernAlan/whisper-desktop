# Whisper Desktop

Whisper Desktop is an Electron-based application that allows users to transcribe speech to text using OpenAI's Whisper model through the Groq API. It provides a simple interface for recording audio and automatically transcribing it into text, which can then be inserted into any active text input field.

## Features

- Global hotkey (Ctrl+Shift+Space) to start/stop recording
- Real-time audio recording using the system microphone
- Transcription of recorded audio using the Whisper large-v3 model
- Automatic insertion of transcribed text into the active text input field
- System tray integration for easy access

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/whisper-desktop.git
   cd whisper-desktop
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file in the root directory and add your Groq API key:
   ```
   GROQ_API_KEY=your_api_key_here
   ```

## Usage

1. Start the application:
   ```
   npm start
   ```

2. Press `Ctrl+Shift+Space` to start recording
3. Speak into your microphone
4. Press `Ctrl+Shift+Space` again to stop recording and initiate transcription
5. The transcribed text will be automatically inserted into the active text input field

## Development

The main components of the application are:

- `main.js`: The main Electron process
- `renderer.js`: The renderer process handling the UI and recording logic
- `preload.js`: Exposes Electron APIs to the renderer process
- `index.html`: The main application window

To modify the application:

1. Make changes to the relevant files
2. Restart the application to see the changes

## Building

To build the application for distribution:
