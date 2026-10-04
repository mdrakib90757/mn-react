/**
 * Offscreen Document Audio Engine (Resilient & Production-Ready)
 * - Captures tab audio via chromeMediaSourceId + user microphone via getUserMedia
 * - Routes tab audio to audioContext.destination (so user can still hear the meeting)
 * - Mixes tab + mic audio and converts to 16 kHz 16-bit PCM via AudioWorklet
 * - Streams over WebSocket to ws://localhost:8080 with auto-reconnect backoff
 * - Cleanly handles tab closure, speaker mute, and graceful teardown
 */

let audioContext = null;
let tabStream = null;
let micStream = null;
let tabSource = null;
let micSource = null;
let mixerNode = null;
let pcmWorkletNode = null;
let socket = null;

let isCapturing = false;
let shouldReconnect = true;
let reconnectTimer = null;
let reconnectAttempts = 0;
let currentConfig = { wsUrl: "ws://localhost:8080", topics: [], questionKinds: [] };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return;

  if (message.type === "START_AUDIO_CAPTURE") {
    startCapture(message)
      .then(() => sendResponse({ status: "started" }))
      .catch((err) => {
        console.error("[Offscreen] Failed to start capture:", err);
        sendResponse({ status: "error", error: err.message });
      });
    return true;
  }

  if (message.type === "STOP_AUDIO_CAPTURE") {
    stopCapture()
      .then(() => sendResponse({ status: "stopped" }))
      .catch((err) => {
        console.error("[Offscreen] Error during stopCapture:", err);
        sendResponse({ status: "error", error: err.message });
      });
    return true;
  }
});

function connectWebSocket() {
  if (!isCapturing || !shouldReconnect) return;

  console.log(`[Offscreen] Connecting WebSocket to ${currentConfig.wsUrl} (attempt: ${reconnectAttempts + 1})...`);
  socket = new WebSocket(currentConfig.wsUrl);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    console.log("[Offscreen] WebSocket connected successfully!");
    reconnectAttempts = 0;
    // Send configuration payload
    socket.send(
      JSON.stringify({
        type: "config",
        topics: currentConfig.topics,
        questionKinds: currentConfig.questionKinds,
      })
    );
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      // Forward STT / LLM results to the Chrome extension side panel
      chrome.runtime.sendMessage(data).catch(() => {});
    } catch (e) {
      console.warn("[Offscreen] Received non-JSON WebSocket message:", event.data);
    }
  };

  socket.onerror = (err) => {
    console.warn("[Offscreen] WebSocket encountered an error:", err);
  };

  socket.onclose = () => {
    console.log("[Offscreen] WebSocket connection closed.");
    socket = null;

    // Auto-reconnect with exponential backoff if capture is still active
    if (isCapturing && shouldReconnect) {
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 8000);
      console.log(`[Offscreen] Reconnecting WebSocket in ${Math.round(delay)}ms...`);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWebSocket, delay);
    }
  };
}

async function startCapture({ streamId, wsUrl, topics, questionKinds }) {
  await stopCapture(); // Clean up any lingering session

  isCapturing = true;
  shouldReconnect = true;
  reconnectAttempts = 0;
  currentConfig = {
    wsUrl: wsUrl || "ws://localhost:8080",
    topics: topics || [],
    questionKinds: questionKinds || ["স্পষ্টীকরণ", "গভীরে", "ঝুঁকি", "অ্যাকশন"],
  };

  console.log("[Offscreen] Starting audio capture with streamId:", streamId);

  // 1. Connect WebSocket
  connectWebSocket();

  // 2. Capture Meeting Tab Audio via streamId
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Handle Tab Close / Navigation cleanly
  tabStream.getAudioTracks().forEach((track) => {
    track.onended = () => {
      console.warn("[Offscreen] Tab audio track ended (meeting tab was closed or changed).");
      chrome.runtime.sendMessage({
        type: "TAB_ENDED",
        warning: "মিটিং ট্যাবটি বন্ধ হয়েছে। ট্রান্সক্রিপশন সম্পন্ন হয়েছে।",
      }).catch(() => {});
      stopCapture();
    };
  });

  // 3. Capture User Microphone (graceful fallback if denied or unavailable)
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    console.log("[Offscreen] Microphone captured successfully.");

    micStream.getAudioTracks().forEach((track) => {
      track.onmute = () => console.log("[Offscreen] Mic hardware muted.");
      track.onunmute = () => console.log("[Offscreen] Mic unmuted.");
    });
  } catch (err) {
    console.warn("[Offscreen] Microphone capture unavailable/denied:", err.message);
    chrome.runtime.sendMessage({
      type: "MIC_WARNING",
      message: "মাইক্রোফোন চালু নেই। শুধুমাত্র মিটিং ট্যাবের অডিও রেকর্ড হচ্ছে।",
    }).catch(() => {});
  }

  // 4. Create Web Audio Context (resampled at 16,000 Hz)
  audioContext = new AudioContext({ sampleRate: 16000 });
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  // CRITICAL: Route tab audio to audioContext.destination so the user can still hear the meeting!
  tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(audioContext.destination);

  // 5. Mix Tab + Microphone audio together into mono GainNode
  mixerNode = audioContext.createGain();
  mixerNode.gain.value = 1.0;
  tabSource.connect(mixerNode);

  if (micStream) {
    micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(mixerNode);
  }

  // 6. Connect to AudioWorklet for 16 kHz 16-bit Linear PCM extraction
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  pcmWorkletNode = new AudioWorkletNode(audioContext, "pcm-worklet-processor");
  mixerNode.connect(pcmWorkletNode);

  pcmWorkletNode.port.onmessage = (event) => {
    const pcmChunk = event.data; // ArrayBuffer (16-bit PCM, 3200 bytes)
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(pcmChunk);
    }
  };

  console.log("[Offscreen] Audio capture & streaming pipeline is active.");
}

async function stopCapture() {
  console.log("[Offscreen] Stopping audio capture...");
  isCapturing = false;
  shouldReconnect = false;
  clearTimeout(reconnectTimer);

  // Disconnect Worklet & Audio Nodes
  try {
    if (pcmWorkletNode) {
      pcmWorkletNode.disconnect();
      pcmWorkletNode = null;
    }
    if (mixerNode) {
      mixerNode.disconnect();
      mixerNode = null;
    }
    if (tabSource) {
      tabSource.disconnect();
      tabSource = null;
    }
    if (micSource) {
      micSource.disconnect();
      micSource = null;
    }
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
      audioContext = null;
    }
  } catch (err) {
    console.warn("[Offscreen] Error cleaning audio nodes:", err);
  }

  // Stop MediaStream tracks
  if (tabStream) {
    tabStream.getTracks().forEach((track) => track.stop());
    tabStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }

  // Close WebSocket
  if (socket) {
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch {}
    socket = null;
  }

  console.log("[Offscreen] Audio capture stopped and cleaned up.");
}

