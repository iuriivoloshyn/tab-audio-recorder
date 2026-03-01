let recorderWindowId = null;
let pendingStreamId = null;

// Click extension icon → open (or focus) the recorder window
chrome.action.onClicked.addListener(async (tab) => {
  // If recorder window already exists, focus it
  if (recorderWindowId !== null) {
    try {
      // Restore if minimized, then focus — ensures it appears on screen
      await chrome.windows.update(recorderWindowId, {
        focused: true,
        state: "normal",
      });
      return;
    } catch (e) {
      recorderWindowId = null;
    }
  }

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });

    pendingStreamId = streamId;

    const win = await chrome.windows.create({
      url: "recorder.html",
      type: "popup",
      width: 360,
      height: 580,
      focused: true,
    });

    recorderWindowId = win.id;
  } catch (error) {
    console.error("Failed to start capture:", error);
  }
});

// Clean up when recorder window closes
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === recorderWindowId) {
    recorderWindowId = null;
    pendingStreamId = null;
    chrome.action.setBadgeText({ text: "" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "get-stream-id") {
    sendResponse({ streamId: pendingStreamId });
    return false;
  }

  if (message.action === "set-badge") {
    chrome.action.setBadgeText({ text: message.text });
    if (message.color) {
      chrome.action.setBadgeBackgroundColor({ color: message.color });
    }
    return false;
  }
});
