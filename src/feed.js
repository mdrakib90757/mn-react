// Live recording & backend integration (Robust In-Sidepanel & Offscreen Engine)
export const USE_MOCK = false;

const MOCK = [
  { text: "আজকের মিটিংয়ে আমরা নতুন প্রজেক্টের ডেডলাইন নিয়ে কথা বলব।" },
  {
    text: "ক্লায়েন্ট চাচ্ছেন আগামী মাসের শেষে প্রথম ভার্সন হাতে পেতে।",
    q: { kind: "স্পষ্টীকরণ", question: "আগামী মাসের শেষ বলতে কোন তারিখ ধরা হচ্ছে?", quote: "আগামী মাসের শেষে প্রথম ভার্সন" },
  },
  {
    text: "বাজেট এখনো চূড়ান্ত হয়নি, তবে আমরা ৫ লাখের মধ্যে থাকার চেষ্টা করছি।",
    n: "বাজেট এখনো চূড়ান্ত নয়; লক্ষ্য ৫ লাখের মধ্যে।",
  },
  {
    text: "ডিজাইন টিম দুই সপ্তাহে কাজ শেষ করবে বলে আশা করছে।",
    q: { kind: "ঝুঁকি", question: "দুই সপ্তাহে না হলে বিকল্প পরিকল্পনা কী?", quote: "দুই সপ্তাহে কাজ শেষ করবে বলে আশা" },
  },
  {
    text: "টেস্টিংয়ের দায়িত্ব এখনো কাউকে দেওয়া হয়নি।",
    q: { kind: "অ্যাকশন", question: "টেস্টিংয়ের দায়িত্ব কে নেবে এবং কবে?", quote: "টেস্টিংয়ের দায়িত্ব এখনো কাউকে দেওয়া হয়নি" },
  },
];

const uuid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
export const stamp = (e) => ({ id: uuid(), ts: Date.now(), ...e });

export function startMockFeed(emit) {
  let i = 0;
  const run = () => {
    const m = MOCK[i++ % MOCK.length];
    emit(stamp({ type: "transcript", speaker: "বক্তা", text: m.text }));
    if (m.q) emit(stamp({ type: "question", kind: m.q.kind, question: m.q.question, quote: m.q.quote }));
    if (m.n) emit(stamp({ type: "note", note: m.n }));
  };
  run();
  const t = setInterval(run, 3500);
  return () => clearInterval(t);
}

/**
 * Fail-fast check to test if backend WebSocket server is listening.
 */
export async function checkBackendHealth(wsUrl = "ws://localhost:8080", timeoutMs = 1500) {
  return new Promise((resolve) => {
    let resolved = false;
    let ws = null;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws?.close(); } catch {}
        resolve(false);
      }
    }, timeoutMs);

    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(true);
        }
      };
      ws.onerror = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(false);
        }
      };
    } catch {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

// Global active audio session references
let activeAudioContext = null;
let activeTabStream = null;
let activeMicStream = null;
let activeWorkletNode = null;
let activeSocket = null;
let liveListeners = new Set();

/**
 * Subscribe to incoming live messages
 */
export function subscribeLive(listener) {
  liveListeners.add(listener);

  // Also listen to any chrome.runtime messages if present
  let chromeHandler = null;
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chromeHandler = (msg) => {
      if (!msg) return;
      if (
        ["transcript", "question", "note", "warning", "error", "TAB_ENDED", "MIC_WARNING", "BACKEND_ERROR"].includes(msg?.type) ||
        msg?.question ||
        msg?.note
      ) {
        listener(stamp(msg));
      }
    };
    chrome.runtime.onMessage.addListener(chromeHandler);
  }

  return () => {
    liveListeners.delete(listener);
    if (chromeHandler && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(chromeHandler);
    }
  };
}

function broadcastLive(data) {
  const stamped = stamp(data);
  for (const listener of liveListeners) {
    try {
      listener(stamped);
    } catch (e) {
      console.error("Error in live listener:", e);
    }
  }
}

/**
 * Direct & Reliable Tab + Mic Audio Capture and Streaming
 */
export async function startRecording({ wsUrl = "ws://localhost:8080", language = "bn", topics = [], questionKinds = [] } = {}) {
  await stopRecording();

  // 1. Connect WebSocket to backend
  activeSocket = new WebSocket(wsUrl);
  activeSocket.binaryType = "arraybuffer";

  await new Promise((resolve, reject) => {
    const connTimeout = setTimeout(() => {
      reject(new Error("সার্ভারে সংযোগ হতে সময় লাগছে। `node server.js` চালু আছে কি না দেখুন।"));
    }, 4000);

    activeSocket.onopen = () => {
      clearTimeout(connTimeout);
      console.log("[SidePanel] WebSocket connected to backend.");
      activeSocket.send(
        JSON.stringify({
          type: "config",
          language,
          topics,
          questionKinds,
        })
      );
      resolve();
    };

    activeSocket.onerror = (err) => {
      clearTimeout(connTimeout);
      reject(new Error("সার্ভারের সাথে সংযোগ স্থাপন করা যায়নি।"));
    };

    activeSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        broadcastLive(data);
      } catch (e) {
        console.warn("[SidePanel] Non-JSON message from server:", event.data);
      }
    };

    activeSocket.onclose = () => {
      console.log("[SidePanel] WebSocket connection closed.");
    };
  });

  // 2. Request Tab Audio via standard getDisplayMedia (allows selecting any Chrome Tab cleanly)
  try {
    activeTabStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: 1,
        height: 1,
        frameRate: 1,
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      systemAudio: "include",
    });
  } catch (err) {
    await stopRecording();
    if (err.name === "NotAllowedError") {
      throw new Error("ট্যাব নির্বাচন বাতিল করা হয়েছে।");
    }
    throw new Error("ট্যাব অডিও ক্যাপচার শুরু করা যায়নি: " + err.message);
  }

  const audioTracks = activeTabStream.getAudioTracks();
  if (!audioTracks || audioTracks.length === 0) {
    await stopRecording();
    throw new Error("ট্যাবের অডিও নির্বাচন করা হয়নি। ট্যাব শেয়ার করার সময় 'Also share tab audio' টিক মার্ক অন রাখুন।");
  }

  // Stop video track since we only need audio to save resources
  activeTabStream.getVideoTracks().forEach((track) => track.stop());

  // Handle user stopping share or closing tab
  audioTracks[0].onended = () => {
    console.log("[SidePanel] Tab audio track ended.");
    broadcastLive({
      type: "TAB_ENDED",
      warning: "ট্যাব অডিও শেয়ার বন্ধ হয়েছে। রেকর্ডিং সমাপ্ত।",
    });
    stopRecording();
  };

  // 3. Optional: Capture User Microphone
  try {
    activeMicStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    console.warn("[SidePanel] Mic unavailable:", err);
    broadcastLive({
      type: "MIC_WARNING",
      message: "মাইক্রোফোন পাওয়া যায়নি। শুধুমাত্র ট্যাবের অডিও রেকর্ড হচ্ছে।",
    });
  }

  // 4. Setup AudioContext at 16,000 Hz
  activeAudioContext = new AudioContext({ sampleRate: 16000 });
  if (activeAudioContext.state === "suspended") {
    await activeAudioContext.resume();
  }

  const mixer = activeAudioContext.createGain();
  mixer.gain.value = 1.0;

  const tabSource = activeAudioContext.createMediaStreamSource(activeTabStream);
  tabSource.connect(mixer);

  if (activeMicStream) {
    const micSource = activeAudioContext.createMediaStreamSource(activeMicStream);
    micSource.connect(mixer);
  }

  // 5. Load AudioWorklet for Linear PCM 16-bit
  const workletUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL("pcm-worklet.js") : "/pcm-worklet.js";
  await activeAudioContext.audioWorklet.addModule(workletUrl);

  activeWorkletNode = new AudioWorkletNode(activeAudioContext, "pcm-worklet-processor");
  mixer.connect(activeWorkletNode);

  activeWorkletNode.port.onmessage = (event) => {
    const pcmChunk = event.data;
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(pcmChunk);
    }
  };

  console.log("[SidePanel] Audio streaming pipeline active.");
  return { success: true };
}

/**
 * Stop all active recordings and audio pipelines
 */
export async function stopRecording() {
  if (activeWorkletNode) {
    try { activeWorkletNode.disconnect(); } catch {}
    activeWorkletNode = null;
  }

  if (activeAudioContext && activeAudioContext.state !== "closed") {
    try { await activeAudioContext.close(); } catch {}
    activeAudioContext = null;
  }

  if (activeTabStream) {
    activeTabStream.getTracks().forEach((track) => track.stop());
    activeTabStream = null;
  }

  if (activeMicStream) {
    activeMicStream.getTracks().forEach((track) => track.stop());
    activeMicStream = null;
  }

  if (activeSocket) {
    try {
      if (activeSocket.readyState === WebSocket.OPEN || activeSocket.readyState === WebSocket.CONNECTING) {
        activeSocket.close();
      }
    } catch {}
    activeSocket = null;
  }

  // Tell background/offscreen to stop if running
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: "STOP_RECORDING" }).catch(() => {});
  }
}

/**
 * Request microphone permission
 */
export function requestMicPermission() {
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: "REQUEST_MIC_PERMISSION" }).catch(() => {});
  }
}

/**
 * Send real-time configuration update (language, topics) over active WebSocket
 */
export function updateLiveConfig({ language, topics, questionKinds }) {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    try {
      activeSocket.send(
        JSON.stringify({
          type: "config",
          language,
          topics,
          questionKinds,
        })
      );
      console.log("[SidePanel] Dispatched live config update:", { language, topics });
    } catch (e) {
      console.warn("[SidePanel] Failed to send live config:", e);
    }
  }
}

