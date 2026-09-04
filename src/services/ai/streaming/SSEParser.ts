/**
 * Minimal SSE framing parser (Stage 4A.2.2).
 *
 * Handles SSE framing ONLY: UTF-8 incremental decoding, CRLF/LF line
 * splitting, `data:` accumulation (including multiple data lines per event),
 * `event:` typing, `:` comment/keep-alive skipping, blank-line dispatch, and
 * EOF flushing. Provider-specific JSON/event interpretation stays in each
 * provider adapter.
 */
export interface SSEParserEvent {
  event?: string;
  data: string;
}

export class SSEParser {
  private readonly decoder = new TextDecoder('utf-8');
  private textBuffer = '';
  private dataLines: string[] = [];
  private eventType: string | undefined;

  /** Feed one network chunk; returns fully-framed events. */
  push(chunk: Uint8Array): SSEParserEvent[] {
    this.textBuffer += this.decoder.decode(chunk, { stream: true });
    return this.extract(false);
  }

  /** Signal end of stream; flushes decoder + any completed trailing event. */
  flush(): SSEParserEvent[] {
    this.textBuffer += this.decoder.decode();
    return this.extract(true);
  }

  private extract(atEof: boolean): SSEParserEvent[] {
    const out: SSEParserEvent[] = [];
    const parts = this.textBuffer.split('\n');
    // Keep the final (possibly incomplete) line buffered unless at EOF.
    this.textBuffer = atEof ? '' : (parts.pop() ?? '');
    for (let line of parts) {
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (line === '') {
        if (this.dataLines.length > 0 || this.eventType !== undefined) {
          out.push({ event: this.eventType, data: this.dataLines.join('\n') });
        }
        this.dataLines = [];
        this.eventType = undefined;
      } else if (line.startsWith(':')) {
        continue; // comment / keep-alive
      } else if (line.startsWith('data:')) {
        let value = line.slice(5);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
        this.dataLines.push(value);
      } else if (line.startsWith('event:')) {
        let value = line.slice(6);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
        this.eventType = value;
      }
      // Other fields (id:, retry:) are intentionally ignored.
    }
    return out;
  }
}

/**
 * Frame a fetch response body as SSE events. Abort propagates naturally as
 * the stream errors; callers map AbortError via signal.reason.
 */
export async function* readSSEEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SSEParserEvent, void, void> {
  const parser = new SSEParser();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        const events = parser.push(value);
        for (const ev of events) {
          yield ev;
        }
      }
    }
    const trailing = parser.flush();
    for (const ev of trailing) {
      yield ev;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream already closed/errored; nothing to do.
    }
    try {
      reader.releaseLock();
    } catch {
      // Already released; nothing to do.
    }
  }
}
