// logger.js — in-process log bus.
// Every line is kept in a ring buffer (so a late/reconnecting SSE client still
// sees history) and broadcast live to subscribed UI terminal panels.
import { EventEmitter } from 'node:events';

const MAX_BUFFER = 500;

class LogBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.buffer = [];
  }

  entry(level, msg, extra = {}) {
    const line = {
      ts: new Date().toISOString(),
      level,                       // debug | info | success | warn | error
      msg: String(msg),
      runId: extra.runId ?? null,
      phase: extra.phase ?? null,
    };
    this.buffer.push(line);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    this.emit('entry', line);
    // mirror to stdout so `server.log` / terminal users see the same stream
    process.stdout.write(`[${line.ts}] ${level.toUpperCase().padEnd(7)} ${line.msg}\n`);
    return line;
  }

  history() {
    return [...this.buffer];
  }
}

export const logger = new LogBus();

/** Bound logger that stamps the current run id / phase on every line. */
export function runLogger(runId) {
  const make = (level) => (msg, phase) => logger.entry(level, msg, { runId, phase });
  return {
    debug: make('debug'),
    info: make('info'),
    success: make('success'),
    warn: make('warn'),
    error: make('error'),
  };
}
