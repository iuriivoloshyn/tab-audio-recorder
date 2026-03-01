// --- DOM ---
const recordBtn = document.getElementById("recordBtn");
const recordIcon = document.getElementById("recordIcon");
const recordLabel = document.getElementById("recordLabel");
const stopBtn = document.getElementById("stopBtn");
const timerEl = document.getElementById("timer");
const statusEl = document.getElementById("status");
const tabVolumeSlider = document.getElementById("tabVolume");
const tabVolumeValue = document.getElementById("tabVolumeValue");
const micToggle = document.getElementById("micToggle");
const micControls = document.getElementById("micControls");
const micSelect = document.getElementById("micSelect");
const micVolumeSlider = document.getElementById("micVolume");
const micVolumeValue = document.getElementById("micVolumeValue");
const downloadBtn = document.getElementById("downloadBtn");
const legendEl = document.getElementById("legend");
const canvas = document.getElementById("visualizer");
const ctx = canvas.getContext("2d");

// --- Audio state ---
let audioContext = null;
let playbackContext = null; // Separate context for tab audio playback (isolates from mic device changes)
let tabStream = null;
let micStream = null;
let micSourceNode = null;
let tabGainNode = null;
let playbackGainNode = null;
let micGainNode = null;
let tabAnalyser = null;
let micAnalyser = null;
let recordingDestination = null;
let mediaRecorder = null;
let recordedChunks = [];

// --- UI state ---
// "idle" | "recording" | "paused"
let recState = "idle";
let timerInterval = null;
let startTime = null;
let pausedElapsed = 0;
let recordingDataUrl = null;
let animationId = null;
let micActive = false;

// --- Visualizer state ---
const BAR_COUNT = 24;
let currentTabLevels = new Array(BAR_COUNT).fill(0);
let targetTabLevels = new Array(BAR_COUNT).fill(0);
let currentMicLevels = new Array(BAR_COUNT).fill(0);
let targetMicLevels = new Array(BAR_COUNT).fill(0);

// =============================================================
// INIT
// =============================================================

async function init() {
  try {
    const { streamId } = await chrome.runtime.sendMessage({
      action: "get-stream-id",
    });

    if (!streamId) {
      statusEl.textContent = "No tab audio stream available";
      statusEl.className = "status error";
      return;
    }

    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

    // Main context: for recording + analysers
    audioContext = new AudioContext();
    // Separate playback context: keeps tab audio on the original output device
    // even when a Bluetooth mic activates and macOS switches BT profile
    playbackContext = new AudioContext();

    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const playbackSource = playbackContext.createMediaStreamSource(tabStream);

    tabGainNode = audioContext.createGain();
    tabGainNode.gain.value = 1;

    playbackGainNode = playbackContext.createGain();
    playbackGainNode.gain.value = 1;

    tabAnalyser = audioContext.createAnalyser();
    tabAnalyser.fftSize = 256;
    tabAnalyser.smoothingTimeConstant = 0.75;

    recordingDestination = audioContext.createMediaStreamDestination();

    // Recording path: tabSource → gain → analyser + recordingDest
    tabSource.connect(tabGainNode);
    tabGainNode.connect(tabAnalyser);
    tabGainNode.connect(recordingDestination);

    // Playback path (isolated): tabStream → playbackGain → speakers
    playbackSource.connect(playbackGainNode);
    playbackGainNode.connect(playbackContext.destination);

    statusEl.textContent = "Listening to tab audio";
    statusEl.className = "status previewing";

    drawVisualizer();
  } catch (error) {
    statusEl.textContent = error.message || "Failed to capture tab audio";
    statusEl.className = "status error";
  }
}

init();

// =============================================================
// MICROPHONE — with device selection
// =============================================================

async function populateMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // Filter: only real audio inputs, skip "default" virtual devices
    const audioInputs = devices.filter(
      (d) =>
        d.kind === "audioinput" &&
        d.deviceId !== "default" &&
        d.deviceId !== "communications" &&
        !d.label.startsWith("Default")
    );

    const currentId = micSelect.value;
    micSelect.innerHTML = "";

    if (audioInputs.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No microphones found";
      micSelect.appendChild(opt);
      return;
    }

    audioInputs.forEach((device, i) => {
      const opt = document.createElement("option");
      opt.value = device.deviceId;
      opt.textContent = device.label || `Microphone ${i + 1}`;
      micSelect.appendChild(opt);
    });

    // Restore previous selection if still available
    if (currentId) {
      for (const opt of micSelect.options) {
        if (opt.value === currentId) {
          micSelect.value = currentId;
          break;
        }
      }
    }
  } catch (e) {
    // Can't enumerate until permission is granted
  }
}

async function enableMic(deviceId) {
  // If mic is already active, tear it down first (switching device)
  disconnectMic();

  try {
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };

    if (deviceId) {
      constraints.audio.deviceId = { exact: deviceId };
    }

    micStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Now that we have permission, refresh the device list (labels become available)
    await populateMicDevices();

    micSourceNode = audioContext.createMediaStreamSource(micStream);

    micGainNode = audioContext.createGain();
    micGainNode.gain.value = micVolumeSlider.value / 100;

    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 256;
    micAnalyser.smoothingTimeConstant = 0.75;

    micSourceNode.connect(micGainNode);
    micGainNode.connect(micAnalyser);
    micGainNode.connect(recordingDestination);

    micActive = true;
    updateLegend();
    return true;
  } catch (error) {
    statusEl.textContent = "Microphone access denied";
    statusEl.className = "status error";
    setTimeout(() => {
      if (recState === "idle") {
        statusEl.textContent = "Listening to tab audio";
        statusEl.className = "status previewing";
      }
    }, 2500);
    return false;
  }
}

function disconnectMic() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (micGainNode) {
    micGainNode.disconnect();
    micGainNode = null;
  }
  if (micSourceNode) {
    micSourceNode.disconnect();
    micSourceNode = null;
  }
  micAnalyser = null;
  micActive = false;
  targetMicLevels = new Array(BAR_COUNT).fill(0);
  updateLegend();
}

function updateLegend() {
  if (micActive) {
    legendEl.innerHTML =
      '<span class="legend-item"><span class="dot tab-dot"></span> Tab</span>' +
      '<span class="legend-item"><span class="dot mic-dot"></span> Mic</span>';
  } else {
    legendEl.innerHTML =
      '<span class="legend-item"><span class="dot tab-dot"></span> Tab</span>';
  }
}

// --- Mic toggle ---

micToggle.addEventListener("change", async () => {
  const enabled = micToggle.checked;
  micControls.classList.toggle("visible", enabled);

  if (enabled) {
    const ok = await enableMic(micSelect.value || undefined);
    if (!ok) {
      micToggle.checked = false;
      micControls.classList.remove("visible");
    }
  } else {
    disconnectMic();
  }
});

// --- Mic source change ---

micSelect.addEventListener("change", async () => {
  if (!micToggle.checked) return;
  await enableMic(micSelect.value || undefined);
});

// =============================================================
// VISUALIZER
// =============================================================

function readLevels(analyser) {
  const buffer = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(buffer);

  const binsPerBar = Math.floor(buffer.length / BAR_COUNT);
  const levels = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    let sum = 0;
    for (let j = 0; j < binsPerBar; j++) {
      sum += buffer[i * binsPerBar + j];
    }
    levels.push(sum / binsPerBar);
  }
  return levels;
}

function drawRoundedBar(x, y, w, h, r) {
  if (h < 1) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.fill();
}

function drawVisualizer() {
  const w = canvas.width;
  const h = canvas.height;
  const gap = 2;
  const barW = Math.floor(w / BAR_COUNT) - gap;
  const r = Math.min(barW / 2, 3);

  if (tabAnalyser) targetTabLevels = readLevels(tabAnalyser);
  if (micAnalyser) targetMicLevels = readLevels(micAnalyser);

  ctx.clearRect(0, 0, w, h);

  for (let i = 0; i < BAR_COUNT; i++) {
    currentTabLevels[i] += (targetTabLevels[i] - currentTabLevels[i]) * 0.28;
    currentMicLevels[i] += (targetMicLevels[i] - currentMicLevels[i]) * 0.28;

    const x = i * (barW + gap) + gap;

    // Tab bar — teal
    const tabH = Math.max(2, (currentTabLevels[i] / 255) * h);
    const ti = currentTabLevels[i] / 255;
    ctx.fillStyle = `rgba(${Math.round(30 + 70 * ti)}, ${Math.round(200 + 55 * ti)}, ${Math.round(170 + 48 * ti)}, 0.9)`;
    drawRoundedBar(x, h - tabH, barW, tabH, r);

    // Mic bar — yellow/gold, stacked on top
    if (micActive && currentMicLevels[i] > 1) {
      const micH = Math.max(1, (currentMicLevels[i] / 255) * h * 0.75);
      const mi = currentMicLevels[i] / 255;
      ctx.fillStyle = `rgba(255, ${Math.round(180 + 40 * mi)}, ${Math.round(30 + 31 * mi)}, 0.85)`;
      drawRoundedBar(x, h - tabH - micH - 1, barW, micH, r);
    }
  }

  animationId = requestAnimationFrame(drawVisualizer);
}

// =============================================================
// RECORDING — with pause/resume
// =============================================================

recordBtn.addEventListener("click", () => {
  if (recState === "idle") {
    startRecording();
  } else if (recState === "recording") {
    pauseRecording();
  } else if (recState === "paused") {
    resumeRecording();
  }
});

stopBtn.addEventListener("click", () => {
  stopRecording();
});

function startRecording() {
  if (!audioContext || !recordingDestination) {
    statusEl.textContent = "No audio source available";
    statusEl.className = "status error";
    return;
  }

  downloadBtn.classList.add("hidden");
  recordingDataUrl = null;
  recordedChunks = [];
  pausedElapsed = 0;

  mediaRecorder = new MediaRecorder(recordingDestination.stream, {
    mimeType: "audio/webm;codecs=opus",
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: "audio/webm" });
    recordingDataUrl = URL.createObjectURL(blob);
    recordedChunks = [];

    recState = "idle";
    stopTimer();
    updateUI();
    statusEl.textContent = "Recording saved";
    statusEl.className = "status previewing";
    downloadBtn.classList.remove("hidden");

    chrome.runtime.sendMessage({ action: "set-badge", text: "" });
  };

  mediaRecorder.start(1000);

  recState = "recording";
  startTime = Date.now();
  startTimer();
  updateUI();

  chrome.runtime.sendMessage({
    action: "set-badge",
    text: "REC",
    color: "#e74c3c",
  });
}

function pauseRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.pause();
  }

  // Accumulate elapsed time, stop the timer
  pausedElapsed += Date.now() - startTime;
  startTime = null;
  stopTimer();

  recState = "paused";
  updateUI();

  chrome.runtime.sendMessage({
    action: "set-badge",
    text: "||",
    color: "#ffd93d",
  });
}

function resumeRecording() {
  if (mediaRecorder && mediaRecorder.state === "paused") {
    mediaRecorder.resume();
  }

  startTime = Date.now();
  startTimer();

  recState = "recording";
  updateUI();

  chrome.runtime.sendMessage({
    action: "set-badge",
    text: "REC",
    color: "#e74c3c",
  });
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

// =============================================================
// TIMER
// =============================================================

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const running = startTime ? Date.now() - startTime : 0;
    const total = Math.floor((pausedElapsed + running) / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    timerEl.textContent = `${m}:${s}`;
  }, 250);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// =============================================================
// UI STATE
// =============================================================

function updateUI() {
  switch (recState) {
    case "idle":
      recordIcon.className = "record-icon";
      recordLabel.textContent = "Start Recording";
      stopBtn.classList.add("hidden");
      if (!recordingDataUrl) {
        statusEl.textContent = "Listening to tab audio";
        statusEl.className = "status previewing";
      }
      break;

    case "recording":
      recordIcon.className = "record-icon paused"; // shows pause bars
      recordLabel.textContent = "Pause";
      stopBtn.classList.remove("hidden");
      statusEl.textContent = "Recording...";
      statusEl.className = "status recording";
      break;

    case "paused":
      recordIcon.className = "record-icon"; // shows red circle = resume
      recordLabel.textContent = "Resume";
      stopBtn.classList.remove("hidden");
      statusEl.textContent = "Paused";
      statusEl.className = "status paused";
      break;
  }
}

// =============================================================
// VOLUME CONTROLS
// =============================================================

tabVolumeSlider.addEventListener("input", () => {
  const val = tabVolumeSlider.value;
  tabVolumeValue.textContent = `${val}%`;
  if (tabGainNode) tabGainNode.gain.value = val / 100;
  if (playbackGainNode) playbackGainNode.gain.value = val / 100;
});

micVolumeSlider.addEventListener("input", () => {
  const val = micVolumeSlider.value;
  micVolumeValue.textContent = `${val}%`;
  if (micGainNode) micGainNode.gain.value = val / 100;
});

// =============================================================
// DOWNLOAD
// =============================================================

downloadBtn.addEventListener("click", () => {
  if (!recordingDataUrl) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const a = document.createElement("a");
  a.href = recordingDataUrl;
  a.download = `tab-recording-${ts}.webm`;
  a.click();
});

// =============================================================
// CLEANUP
// =============================================================

window.addEventListener("beforeunload", () => {
  if (animationId) cancelAnimationFrame(animationId);

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

  if (tabStream) tabStream.getTracks().forEach((t) => t.stop());
  disconnectMic();

  if (audioContext) audioContext.close().catch(() => {});
  if (playbackContext) playbackContext.close().catch(() => {});

  chrome.runtime.sendMessage({ action: "set-badge", text: "" });
});
