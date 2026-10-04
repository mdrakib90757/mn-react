import WebSocket from "ws";

/**
 * Creates a streaming STT session backed by Deepgram's live transcription API.
 *
 * Requirements verified from Deepgram documentation & live API test:
 * - Bengali language code: "bn"
 * - Supported models for Bengali streaming: "nova-3", "nova-2"
 * - Audio format: Linear PCM 16-bit, 16000 Hz, mono (linear16)
 *
 * @param {Object} options
 * @param {Function} options.onTranscript - Callback invoked with { text, isFinal }
 * @param {Function} options.onError - Callback invoked on STT error
 * @param {Object} [options.config] - Client configuration (e.g. language override)
 * @returns {Object} { sendAudio: (Buffer) => void, close: () => void }
 */
export function createSTTStream({ onTranscript, onError, config = {} }) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey || apiKey === "your_deepgram_api_key_here") {
    const err = new Error("DEEPGRAM_API_KEY is not set or using placeholder in backend/.env");
    console.warn(`[STT/Deepgram] ${err.message}`);
    if (onError) onError(err);
    return {
      sendAudio: () => {},
      close: () => {},
    };
  }

  const model = process.env.DG_MODEL || "nova-3";
  const language = config.language || process.env.DG_LANGUAGE || "bn";
  const sampleRate = process.env.DG_SAMPLE_RATE || "16000";
  const encoding = process.env.DG_ENCODING || "linear16";

  const params = new URLSearchParams({
    model,
    language,
    encoding,
    sample_rate: sampleRate,
    channels: "1",
    smart_format: "true",
    punctuate: "true",
    interim_results: "false",
    endpointing: "300",
  });

  // Only pass pure ASCII keywords if any, because non-ASCII query params return 400 from Deepgram
  if (Array.isArray(config.topics) && config.topics.length > 0) {
    config.topics.forEach((topic) => {
      if (topic && typeof topic === "string" && /^[\x00-\x7F]+$/.test(topic.trim())) {
        params.append("keywords", topic.trim());
      }
    });
  }

  const deepgramUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  let isClosed = false;
  let ws = null;
  const audioQueue = [];

  try {
    ws = new WebSocket(deepgramUrl, {
      headers: {
        Authorization: `Token ${apiKey}`,
      },
    });
  } catch (err) {
    console.error("[STT/Deepgram] WebSocket instantiation error:", err.message);
    if (onError) onError(err);
    return {
      sendAudio: () => {},
      close: () => {},
    };
  }

  ws.on("open", () => {
    console.log(`[STT/Deepgram] Connected (model=${model}, language=${language})`);
    // Flush buffered audio frames
    while (audioQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
      const chunk = audioQueue.shift();
      ws.send(chunk);
    }
  });

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString("utf8"));
      if (data.type === "Results" || data.channel) {
        const alt = data.channel?.alternatives?.[0];
        const transcript = alt?.transcript?.trim();
        const isFinal = data.is_final === true || data.speech_final === true;

        if (isFinal && transcript) {
          if (onTranscript) {
            onTranscript({ text: transcript, isFinal: true });
          }
        }
      }
    } catch (parseErr) {
      console.warn("[STT/Deepgram] Failed to parse message:", parseErr.message);
    }
  });

  ws.on("error", (err) => {
    console.error("[STT/Deepgram] Connection error:", err.message);
    if (onError) onError(err);
  });

  ws.on("close", (code, reason) => {
    console.log(`[STT/Deepgram] Closed (code=${code}, reason=${reason.toString() || "normal"})`);
    isClosed = true;
  });

  return {
    sendAudio: (chunk) => {
      if (isClosed || !ws) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        if (audioQueue.length < 50) {
          audioQueue.push(chunk);
        }
      }
    },
    close: () => {
      isClosed = true;
      audioQueue.length = 0;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close();
        } catch {}
      }
    },
  };
}
