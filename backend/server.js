import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import { createSTTStream } from "./stt/deepgram.js";
import { analyzeTranscript, translateOrCleanTranscript } from "./llm.js";

const PORT = parseInt(process.env.PORT, 10) || 8080;

// Periodic analysis cadence (~25 seconds) and pause trigger (~3 seconds)
const ANALYSIS_INTERVAL_MS = 25000;
const PAUSE_THRESHOLD_MS = 3000;
const MIN_NEW_TEXT_CHARS = 40;
const WINDOW_DURATION_MS = 120000; // Last 2 minutes

const wss = new WebSocketServer({ port: PORT });

console.log(`[Backend] Meeting Notes AI Server listening on ws://localhost:${PORT}`);

wss.on("connection", (clientWs, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[Backend] Client connected from ${clientIp}`);

  let config = {
    language: "bn",
    topics: ["ডেডলাইন", "বাজেট"],
    questionKinds: ["স্পষ্টীকরণ", "গভীরে", "ঝুঁকি", "অ্যাকশন"],
  };

  let sttStream = null;
  const transcriptHistory = []; // { ts: number, text: string }
  const generatedQuestions = []; // string[]
  let lastAnalyzedTextLength = 0;
  let isAnalyzing = false;
  let pauseTimer = null;

  // Lazily initialize STT stream only when real audio arrives (avoids timeout on health checks)
  function getOrCreateSTTStream() {
    if (sttStream) return sttStream;
    console.log(`[Backend STT] Opening Deepgram stream (${config.language || "bn"}) for client ${clientIp}...`);
    sttStream = createSTTStream({
      config,
      onTranscript: async ({ text, isFinal }) => {
        if (!text || clientWs.readyState !== WebSocket.OPEN) return;

        // Clean any Hindi/Devanagari script artifacts and handle cross-translation
        const targetLang = config.language || "bn";
        const processedText = await translateOrCleanTranscript({ text, targetLanguage: targetLang });

        console.log(`[Backend STT] Final transcript (${targetLang}): "${processedText}"`);

        // Record transcript entry
        transcriptHistory.push({ ts: Date.now(), text: processedText });

        // Relay to client
        clientWs.send(
          JSON.stringify({
            type: "transcript",
            text: processedText,
          })
        );

        // Reset speech pause timer to trigger analysis when speaker pauses
        if (pauseTimer) clearTimeout(pauseTimer);
        pauseTimer = setTimeout(() => {
          runAnalysis();
        }, PAUSE_THRESHOLD_MS);
      },
      onError: (err) => {
        console.warn(`[Backend STT Error] ${err.message}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(
            JSON.stringify({
              type: "stt-error",
              message: err.message,
            })
          );
        }
      },
    });
    return sttStream;
  }

  // Run LLM analysis on the current 2-minute transcript window
  async function runAnalysis() {
    if (isAnalyzing || clientWs.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    // Keep last 2 minutes of transcript
    const recentItems = transcriptHistory.filter((item) => now - item.ts <= WINDOW_DURATION_MS);
    const transcriptWindow = recentItems.map((item) => item.text).join(" ");
    const currentTotalLen = transcriptHistory.map((item) => item.text).join(" ").length;

    // Skip if not enough new content since last analysis
    if (currentTotalLen - lastAnalyzedTextLength < MIN_NEW_TEXT_CHARS) {
      return;
    }

    isAnalyzing = true;
    console.log(`[Backend LLM] Triggering analysis (${transcriptWindow.length} chars, topics=[${config.topics.join(", ")}])`);

    try {
      const result = await analyzeTranscript({
        transcriptWindow,
        language: config.language || "bn",
        topics: config.topics,
        existingQuestions: generatedQuestions,
        questionKinds: config.questionKinds,
      });

      lastAnalyzedTextLength = currentTotalLen;

      if (clientWs.readyState !== WebSocket.OPEN) return;

      // Broadcast generated questions
      if (Array.isArray(result.questions) && result.questions.length > 0) {
        for (const q of result.questions) {
          generatedQuestions.push(q.question);
          console.log(`[Backend LLM] Question [${q.kind}]: "${q.question}"`);
          clientWs.send(
            JSON.stringify({
              type: "question",
              kind: q.kind,
              question: q.question,
              quote: q.quote,
            })
          );
        }
      }

      // Broadcast generated notes
      if (Array.isArray(result.notes) && result.notes.length > 0) {
        for (const note of result.notes) {
          console.log(`[Backend LLM] Note: "${note}"`);
          clientWs.send(
            JSON.stringify({
              type: "note",
              note,
            })
          );
        }
      }
    } catch (err) {
      console.error("[Backend LLM] Analysis error:", err.message);
    } finally {
      isAnalyzing = false;
    }
  }

  // Periodic interval trigger
  const intervalTimer = setInterval(() => {
    runAnalysis();
  }, ANALYSIS_INTERVAL_MS);

  clientWs.on("message", (data, isBinary) => {
    try {
      if (isBinary) {
        // Forward binary 16kHz linear16 PCM to STT
        const stream = getOrCreateSTTStream();
        if (stream) {
          stream.sendAudio(data);
        }
      } else {
        const text = data.toString("utf8");
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          return;
        }

        if (payload?.type === "config") {
          const oldLang = config.language;
          const newLang = payload.language || config.language || process.env.DG_LANGUAGE || "bn";

          config.language = newLang;
          config.topics = Array.isArray(payload.topics) ? payload.topics : config.topics;
          config.questionKinds = Array.isArray(payload.questionKinds) ? payload.questionKinds : config.questionKinds;

          console.log("[Backend] Updated live config:", {
            language: config.language,
            topics: config.topics,
            questionKinds: config.questionKinds,
          });

          // Hot-restart STT stream if language was dynamically changed during an active session
          if (sttStream && oldLang !== newLang) {
            console.log(`[Backend STT] Language switched from "${oldLang}" to "${newLang}". Hot-restarting Deepgram STT stream...`);
            try {
              sttStream.close();
            } catch {}
            sttStream = null;
            getOrCreateSTTStream();
          }
        } else if (payload?.type === "ping") {
          clientWs.send(JSON.stringify({ type: "pong" }));
        }
      }
    } catch (err) {
      console.error("[Backend] Error processing message:", err.message);
    }
  });

  clientWs.on("error", (err) => {
    console.error(`[Backend] Client error (${clientIp}):`, err.message);
  });

  clientWs.on("close", (code) => {
    console.log(`[Backend] Client disconnected (${clientIp}, code=${code})`);
    if (intervalTimer) clearInterval(intervalTimer);
    if (pauseTimer) clearTimeout(pauseTimer);
    if (sttStream) {
      sttStream.close();
      sttStream = null;
    }
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[Backend] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[Backend] Uncaught Exception:", err);
});
