type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

async function send(level: LogLevel, message: string, data?: unknown) {
  try {
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message, data }),
    });
  } catch {
    // never throw from a logger
  }
}

export const logger = {
  info:  (msg: string, data?: unknown) => { console.info(msg, data);  send('INFO',  msg, data); },
  warn:  (msg: string, data?: unknown) => { console.warn(msg, data);  send('WARN',  msg, data); },
  error: (msg: string, data?: unknown) => { console.error(msg, data); send('ERROR', msg, data); },
  debug: (msg: string, data?: unknown) => { console.debug(msg, data); send('DEBUG', msg, data); },
};
