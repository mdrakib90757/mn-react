/**
 * AudioWorkletProcessor: Converts audio stream into 16 kHz 16-bit Linear PCM
 * Buffers ~100 ms (1600 samples @ 16 kHz = 3200 bytes) and posts binary ArrayBuffer.
 */
class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 1600 samples at 16,000 Hz = 100 ms of audio (3200 bytes per chunk)
    this.chunkSamples = 1600;
    this.buffer = new Int16Array(this.chunkSamples);
    this.offset = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    // First channel (mono)
    const channel = input[0];
    const len = channel.length;

    for (let i = 0; i < len; i++) {
      let sample = channel[i];

      // Soft clamp float to [-1.0, 1.0]
      if (sample > 1.0) sample = 1.0;
      else if (sample < -1.0) sample = -1.0;

      // Convert 32-bit float to 16-bit signed integer Linear PCM
      this.buffer[this.offset++] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);

      // When chunk is full (~100 ms), post the ArrayBuffer to main thread
      if (this.offset >= this.chunkSamples) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(this.chunkSamples);
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-worklet-processor", PCMWorkletProcessor);

