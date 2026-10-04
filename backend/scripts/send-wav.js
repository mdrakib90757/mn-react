import fs from "fs";
import path from "path";
import WebSocket from "ws";
import "dotenv/config";

const PORT = parseInt(process.env.PORT, 10) || 8080;
const SERVER_URL = `ws://localhost:${PORT}`;

// 16 kHz 16-bit mono PCM = 32,000 bytes per second.
// A 100 ms chunk is 3,200 bytes (1,600 samples).
const CHUNK_SIZE = 3200;
const CHUNK_INTERVAL_MS = 100;

const filePath = process.argv[2];

let pcmData;

if (filePath && fs.existsSync(filePath)) {
  console.log(`[Test] Reading WAV file from: ${filePath}`);
  const fileBuffer = fs.readFileSync(filePath);

  // Check RIFF header
  if (fileBuffer.toString("utf8", 0, 4) === "RIFF" && fileBuffer.toString("utf8", 8, 12) === "WAVE") {
    // Locate the 'data' subchunk
    let offset = 12;
    let dataOffset = 44; // Default fallback for standard PCM wav
    let dataSize = fileBuffer.length - 44;

    while (offset < fileBuffer.length - 8) {
      const subchunkId = fileBuffer.toString("utf8", offset, offset + 4);
      const subchunkSize = fileBuffer.readUInt32LE(offset + 4);
      if (subchunkId === "data") {
        dataOffset = offset + 8;
        dataSize = subchunkSize;
        break;
      }
      offset += 8 + subchunkSize;
    }

    pcmData = fileBuffer.subarray(dataOffset, dataOffset + dataSize);
    console.log(`[Test] Extracted ${pcmData.length} bytes of PCM audio from WAV.`);
  } else {
    pcmData = fileBuffer;
    console.log(`[Test] Loaded raw audio file (${pcmData.length} bytes).`);
  }
} else {
  console.log("[Test] No input WAV provided. Generating 5 seconds of synthetic 16kHz test tone...");
  // Generate 5 seconds of 440 Hz sine wave in 16-bit PCM at 16000 Hz
  const sampleRate = 16000;
  const durationSec = 5;
  const totalSamples = sampleRate * durationSec;
  pcmData = Buffer.alloc(totalSamples * 2);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * 0.25 * 32767;
    pcmData.writeInt16LE(Math.round(sample), i * 2);
  }
}

console.log(`[Test] Connecting to backend at ${SERVER_URL}...`);
const ws = new WebSocket(SERVER_URL);

ws.on("open", () => {
  console.log("[Test] Connected to server.");

  // Send initial config
  const configMsg = {
    type: "config",
    topics: ["ডেডলাইন", "বাজেট", "প্রজেক্ট"],
    questionKinds: ["স্পষ্টীকরণ", "ঝুঁকি", "অ্যাকশন"],
  };
  ws.send(JSON.stringify(configMsg));
  console.log("[Test] Sent config message:", configMsg);

  // Stream PCM chunks every 100 ms
  let offset = 0;
  const totalChunks = Math.ceil(pcmData.length / CHUNK_SIZE);
  let chunkIndex = 0;

  const timer = setInterval(() => {
    if (offset >= pcmData.length || ws.readyState !== WebSocket.OPEN) {
      clearInterval(timer);
      console.log("[Test] Finished streaming audio. Waiting 3s for final server transcripts...");
      setTimeout(() => {
        console.log("[Test] Closing connection.");
        ws.close();
        process.exit(0);
      }, 3000);
      return;
    }

    const chunk = pcmData.subarray(offset, Math.min(offset + CHUNK_SIZE, pcmData.length));
    ws.send(chunk);
    offset += CHUNK_SIZE;
    chunkIndex++;
    process.stdout.write(`\r[Test] Sent chunk ${chunkIndex}/${totalChunks} (${offset}/${pcmData.length} bytes)`);
  }, CHUNK_INTERVAL_MS);
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString("utf8"));
    console.log("\n[Test] Server response received:", msg);
  } catch {
    console.log("\n[Test] Server message (raw):", data.toString("utf8"));
  }
});

ws.on("error", (err) => {
  console.error("\n[Test] WebSocket error:", err.message);
});

ws.on("close", () => {
  console.log("\n[Test] Connection closed.");
});

