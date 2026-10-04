// Phase 4: Live recording & backend integration
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

/**
 * Start tab and microphone audio recording in offscreen document
 */
export async function startRecording({ topics = [], questionKinds = [] } = {}) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("ক্রোম এক্সটেনশন এনভায়রনমেন্ট পাওয়া যায়নি।");
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "START_RECORDING",
        wsUrl: "ws://localhost:8080",
        topics,
        questionKinds,
      },
      (res) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (res && res.success === false) {
          return reject(new Error(res.error || "রেকর্ডিং শুরু করা যায়নি।"));
        }
        resolve(res);
      }
    );
  });
}

/**
 * Stop audio recording and clean up offscreen document
 */
export async function stopRecording() {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "STOP_RECORDING" }, (res) => {
      resolve(res);
    });
  });
}

/**
 * Request microphone permission via dedicated permission tab
 */
export function requestMicPermission() {
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: "REQUEST_MIC_PERMISSION" });
  }
}

/**
 * Subscribe to incoming live messages from background/offscreen
 */
export function subscribeLive(emit) {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return () => {};
  const handler = (msg) => {
    if (!msg) return;
    if (["transcript", "question", "note", "warning", "error", "TAB_ENDED", "MIC_WARNING", "BACKEND_ERROR"].includes(msg?.type) || msg?.question || msg?.note) {
      emit(stamp(msg));
    }
  };
  chrome.runtime.onMessage.addListener(handler);
  return () => chrome.runtime.onMessage.removeListener(handler);
}

