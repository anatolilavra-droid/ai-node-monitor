export interface SseFrame {
  eventName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export async function* parseSse(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex = buffer.indexOf('\n\n');
      while (sepIndex !== -1) {
        const frame = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        sepIndex = buffer.indexOf('\n\n');

        let eventName = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
          else if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
        }
        if (data) yield { eventName, data: JSON.parse(data) };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function collectSse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of parseSse(reader)) frames.push(frame);
  return frames;
}
