/**
 * Service Worker: background.js
 * Manages side panel behavior, offscreen document lifecycle,
 * and media stream ID acquisition for tab audio capture.
 */

if (typeof chrome !== "undefined" && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.warn("sidePanel behavior could not be set:", err);
  });
}

const OFFSCREEN_PATH = "offscreen.html";
let currentCapturedTabId = null;

async function hasOffscreenDocument() {
  if (chrome.offscreen?.hasDocument) {
    return await chrome.offscreen.hasDocument();
  }
  if (chrome.runtime?.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts && contexts.length > 0;
  }
  return false;
}

async function ensureOffscreenDocument() {
  const exists = await hasOffscreenDocument();
  if (exists) return;

  const reasons = [
    chrome.offscreen?.Reason?.USER_MEDIA || "USER_MEDIA",
    chrome.offscreen?.Reason?.AUDIO_PLAYBACK || "AUDIO_PLAYBACK",
  ];

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: reasons,
    justification: "Recording meeting tab audio and microphone for real-time transcription.",
  });
}

async function closeOffscreenDocument() {
  const exists = await hasOffscreenDocument();
  if (exists) {
    await chrome.offscreen.closeDocument();
  }
}

// Watch for captured tab closure
chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentCapturedTabId && tabId === currentCapturedTabId) {
    console.log("[Background] Captured tab was closed by user.");
    currentCapturedTabId = null;
    chrome.runtime.sendMessage({
      type: "TAB_ENDED",
      warning: "মিটিং ট্যাবটি বন্ধ হয়েছে। ট্রান্সক্রিপশন সম্পন্ন হয়েছে।",
    }).catch(() => {});

    chrome.runtime.sendMessage({
      target: "offscreen",
      type: "STOP_AUDIO_CAPTURE",
    }).catch(() => {});

    setTimeout(closeOffscreenDocument, 400);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "offscreen") return;

  if (message.type === "START_RECORDING") {
    (async () => {
      try {
        // 1. Get current active tab
        let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!activeTab) {
          [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        }
        if (!activeTab || !activeTab.id) {
          throw new Error("কোনো সক্রিয় ট্যাব পাওয়া যায়নি। মিটিং ট্যাবে গিয়ে শুরু করুন।");
        }

        // Prevent capturing internal chrome:// pages
        if (activeTab.url?.startsWith("chrome://") || activeTab.url?.startsWith("edge://")) {
          throw new Error("ব্রাউজারের ইন্টারনাল পেজের অডিও ক্যাপচার করা সম্ভব নয়। গুগল মিট বা ওয়েব ট্যাবে যান।");
        }

        currentCapturedTabId = activeTab.id;

        // 2. Request stream ID for tabCapture
        const streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: activeTab.id,
        });

        // 3. Ensure offscreen document is created
        await ensureOffscreenDocument();

        // 4. Send command to offscreen document
        chrome.runtime.sendMessage(
          {
            target: "offscreen",
            type: "START_AUDIO_CAPTURE",
            streamId: streamId,
            wsUrl: message.wsUrl || "ws://localhost:8080",
            topics: message.topics || [],
            questionKinds: message.questionKinds || [],
          },
          (res) => {
            if (chrome.runtime.lastError) {
              console.warn("Message to offscreen had error:", chrome.runtime.lastError);
            }
          }
        );

        sendResponse({ success: true, tabTitle: activeTab.title });
      } catch (err) {
        console.error("[Background] START_RECORDING error:", err);
        currentCapturedTabId = null;
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "STOP_RECORDING") {
    (async () => {
      try {
        currentCapturedTabId = null;
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "STOP_AUDIO_CAPTURE",
        }).catch(() => {});

        setTimeout(async () => {
          try {
            await closeOffscreenDocument();
          } catch {}
        }, 500);

        sendResponse({ success: true });
      } catch (err) {
        console.error("[Background] STOP_RECORDING error:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "REQUEST_MIC_PERMISSION") {
    chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
    sendResponse({ success: true });
    return false;
  }
});

