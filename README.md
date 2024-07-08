# Whisper Desktop

Whisper Desktop is an Electron-based application that allows users to transcribe speech to text using OpenAI's Whisper model through the Groq API. It provides a simple interface for recording audio and automatically transcribing it into text, which can then be inserted into any active text input field.

![image](https://github.com/KernAlan/whisper-desktop/assets/63753020/9e041208-4480-4f40-96b3-bc4425956f7e)

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

- `main.js`: The main Electron process
- `renderer.js`: The renderer process handling the UI and recording logic
- `preload.js`: Exposes Electron APIs to the renderer process
- `index.html`: The main application window

To modify the application:

1. Make changes to the relevant files
2. Restart the application to see the changes

## Building

To build the application for distribution:

   ```
   npm run build
   ```

This will create distributable packages for your platform in the `dist` folder.

## Testing

The application includes a microphone testing feature. Click the "Test Microphone" button in the UI to check if your microphone is working correctly.

## Troubleshooting

If you encounter any issues with audio recording or transcription:

1. Ensure your microphone is properly connected and selected as the default input device
2. Check the console logs for any error messages
3. Verify that your Groq API key is correctly set in the `.env` file

## License

This project is licensed under the Apache License 2.0. See the LICENSE file for details.