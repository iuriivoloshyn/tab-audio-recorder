# Tab Audio Recorder

Chrome extension that records audio from browser tabs with optional microphone mixing.

![Chrome](https://img.shields.io/badge/Chrome-116%2B-green) ![Manifest](https://img.shields.io/badge/Manifest-V3-blue)

## Features

- **Tab audio capture** — record any audio playing in a browser tab
- **Real-time visualizer** — frequency bars show tab audio (teal) and mic audio (yellow) separately
- **Microphone mixing** — toggle mic on/off, select input device, adjust volume independently
- **Pause / Resume** — pause recording and resume without losing data
- **Tab audio keeps playing** — the page doesn't know the extension is running
- **WebM/Opus output** — native browser format, no extra libraries

## Install

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the project folder

## Usage

1. Navigate to a tab playing audio (YouTube, Spotify, etc.)
2. Click the extension icon — a recorder window opens
3. The visualizer shows live audio levels immediately
4. Click the **record button** to start recording
5. Toggle **Microphone** to mix in mic audio (browser will ask for permission)
6. Use **Pause** to pause, **Stop** (square button) to finish
7. Click **Download Recording** to save the `.webm` file

## Architecture

```
Extension icon click
  → background.js gets tab stream ID via chrome.tabCapture
  → Opens recorder.html as a popup window
  → recorder.js captures audio directly (visible window = full API access)
```

All audio processing happens in the recorder window using the Web Audio API:

- **Tab audio** → GainNode → AnalyserNode + MediaStreamDestination + speakers
- **Mic audio** → GainNode → AnalyserNode + MediaStreamDestination (no speakers = no feedback)
- **Playback** runs on a separate AudioContext to isolate from Bluetooth codec switching

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Manifest V3 — `tabCapture` + `activeTab` permissions |
| `background.js` | Service worker — manages tab capture and recorder window |
| `recorder.html` | Recorder window markup |
| `recorder.css` | Dark theme UI styles |
| `recorder.js` | Audio capture, mixing, recording, visualizer, all controls |

## Notes

- **Bluetooth headphones as mic**: On macOS, selecting a Bluetooth device as mic input causes the OS to switch from A2DP (high-quality playback) to HFP (low-quality bidirectional). This makes audio sound worse through those headphones while recording. The recorded file is unaffected. Use the built-in laptop mic for best results.
- The extension uses no content scripts — the page cannot detect it is running.
