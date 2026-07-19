const BATCH_SIZE = 2400;

class CodexCorpMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BATCH_SIZE);
    this.writePosition = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let index = 0; index < channel.length; index += 1) {
      this.buffer[this.writePosition] = channel[index];
      this.writePosition += 1;
      if (this.writePosition === BATCH_SIZE) {
        this.port.postMessage(this.buffer.slice());
        this.writePosition = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic-processor", CodexCorpMicProcessor);
