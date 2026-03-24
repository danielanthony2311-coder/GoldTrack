import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Trash2, Download, Pause, Play, Search, X, RefreshCw, Circle } from 'lucide-react';
import { cn } from '../utils/cn';

type LogType = 'backend' | 'frontend';

interface ParsedLine {
  raw: string;
  ts: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'UNKNOWN';
  msg: string;
}

// ── Parse a log line: [ISO_DATE] [LEVEL] message ──────────────────────────────
function parseLine(raw: string): ParsedLine {
  const m = raw.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/);
  if (!m) return { raw, ts: '', level: 'UNKNOWN', msg: raw };
  const level = (['INFO','WARN','ERROR','DEBUG'].includes(m[2].toUpperCase())
    ? m[2].toUpperCase() : 'UNKNOWN') as ParsedLine['level'];
  return { raw, ts: m[1], level, msg: m[3] };
}

const LEVEL_COLORS: Record<ParsedLine['level'], string> = {
  ERROR:   'text-red-400',
  WARN:    'text-yellow-400',
  INFO:    'text-zinc-400',
  DEBUG:   'text-blue-400',
  UNKNOWN: 'text-zinc-500',
};

const LEVEL_BADGE: Record<ParsedLine['level'], string> = {
  ERROR:   'bg-red-900/60 text-red-300 border-red-700/50',
  WARN:    'bg-yellow-900/60 text-yellow-300 border-yellow-700/50',
  INFO:    'bg-zinc-800 text-zinc-400 border-zinc-700/50',
  DEBUG:   'bg-blue-900/60 text-blue-300 border-blue-700/50',
  UNKNOWN: 'bg-zinc-800 text-zinc-500 border-zinc-700/50',
};

function LogLine({ line, search }: { line: ParsedLine; search: string }) {
  const highlight = (text: string) => {
    if (!search) return <span>{text}</span>;
    const parts = text.split(new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return (
      <>
        {parts.map((p, i) =>
          p.toLowerCase() === search.toLowerCase()
            ? <mark key={i} className="bg-yellow-400/30 text-yellow-200 rounded-sm">{p}</mark>
            : <span key={i}>{p}</span>
        )}
      </>
    );
  };

  return (
    <div className={cn('flex items-start gap-2 px-3 py-0.5 hover:bg-zinc-800/40 font-mono text-xs leading-5 group',
      line.level === 'ERROR' && 'bg-red-950/20',
      line.level === 'WARN'  && 'bg-yellow-950/10',
    )}>
      {line.ts && (
        <span className="text-zinc-600 shrink-0 select-none mt-px">{line.ts.replace('T', ' ').replace(/\.\d{3}Z$/, '')}</span>
      )}
      <span className={cn('shrink-0 text-[10px] px-1 py-0.5 rounded border font-semibold mt-px', LEVEL_BADGE[line.level])}>
        {line.level.slice(0, 4)}
      </span>
      <span className={cn('break-all', LEVEL_COLORS[line.level])}>{highlight(line.msg)}</span>
    </div>
  );
}

export default function LogViewer() {
  const [activeTab, setActiveTab] = useState<LogType>('backend');
  const [lines, setLines]         = useState<ParsedLine[]>([]);
  const [search, setSearch]       = useState('');
  const [paused, setPaused]       = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [clearing, setClearing]   = useState(false);
  const [filter, setFilter]       = useState<'ALL' | 'ERROR' | 'WARN' | 'INFO'>('ALL');

  const bottomRef  = useRef<HTMLDivElement>(null);
  const esRef      = useRef<EventSource | null>(null);
  const pausedRef  = useRef(false);
  const bufRef     = useRef<ParsedLine[]>([]);  // buffer new lines while paused

  pausedRef.current = paused;

  // ── SSE connection ──────────────────────────────────────────────────────────
  const connect = useCallback((tab: LogType) => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setLines([]);
    bufRef.current = [];
    setLiveCount(0);

    const es = new EventSource(`/api/logs/${tab}/stream`);
    esRef.current = es;

    es.onmessage = (e) => {
      const parsed = parseLine(JSON.parse(e.data));
      if (pausedRef.current) {
        bufRef.current.push(parsed);
      } else {
        setLines(prev => [...prev.slice(-1999), parsed]);
        setLiveCount(c => c + 1);
      }
    };

    es.onerror = () => {
      // SSE will auto-reconnect; don't log noise
    };
  }, []);

  useEffect(() => {
    connect(activeTab);
    return () => { esRef.current?.close(); };
  }, [activeTab, connect]);

  // Auto-scroll to bottom when new lines arrive (unless paused)
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, paused]);

  // Flush buffer when unpaused
  const togglePause = () => {
    if (paused) {
      setLines(prev => [...prev, ...bufRef.current].slice(-2000));
      setLiveCount(c => c + bufRef.current.length);
      bufRef.current = [];
    }
    setPaused(p => !p);
  };

  const clearLog = async () => {
    setClearing(true);
    await fetch(`/api/logs/${activeTab}`, { method: 'DELETE' });
    setLines([]);
    bufRef.current = [];
    setLiveCount(0);
    setClearing(false);
  };

  const downloadLog = async () => {
    const res = await fetch(`/api/logs/${activeTab}?lines=2000`);
    const data: string[] = await res.json();
    const blob = new Blob([data.join('\n')], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${activeTab}.log`;
    a.click(); URL.revokeObjectURL(url);
  };

  // ── Filtered lines ──────────────────────────────────────────────────────────
  const visible = lines.filter(l => {
    if (filter !== 'ALL' && l.level !== filter) return false;
    if (search && !l.raw.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const counts = {
    ERROR: lines.filter(l => l.level === 'ERROR').length,
    WARN:  lines.filter(l => l.level === 'WARN').length,
    INFO:  lines.filter(l => l.level === 'INFO').length,
  };

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Application Logs</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Real-time log stream from server</p>
        </div>

        {/* Tab switcher */}
        <div className="flex rounded-lg overflow-hidden border border-zinc-700">
          {(['backend', 'frontend'] as LogType[]).map(t => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={cn('px-4 py-2 text-xs font-medium capitalize transition-colors',
                activeTab === t ? 'bg-gold-600/20 text-gold-300' : 'text-zinc-500 hover:text-zinc-300'
              )}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Toolbar */}
      <div className="glass-card p-3 flex flex-wrap items-center gap-2">
        {/* Level filters */}
        <div className="flex rounded overflow-hidden border border-zinc-700">
          {(['ALL', 'ERROR', 'WARN', 'INFO'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn('px-3 py-1.5 text-xs transition-colors',
                filter === f ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300',
                f === 'ERROR' && filter === f && 'bg-red-900/60 text-red-300',
                f === 'WARN'  && filter === f && 'bg-yellow-900/60 text-yellow-300',
              )}>
              {f}
              {f !== 'ALL' && counts[f] > 0 && (
                <span className={cn('ml-1.5 px-1 rounded text-[10px] font-bold',
                  f === 'ERROR' ? 'bg-red-800 text-red-200' :
                  f === 'WARN'  ? 'bg-yellow-800 text-yellow-200' : 'bg-zinc-700 text-zinc-300'
                )}>{counts[f]}</span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-40">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter logs…"
            className="w-full bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs rounded pl-7 pr-6 py-1.5 focus:outline-none focus:border-gold-600"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
              <X size={11} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 ml-auto">
          {/* Live indicator */}
          <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-500">
            <Circle size={7} className={cn('fill-current', paused ? 'text-zinc-600' : 'text-emerald-500 animate-pulse')} />
            {paused ? <span className="text-zinc-500">Paused {bufRef.current.length > 0 && `(+${bufRef.current.length})`}</span>
                    : <span className="text-emerald-500">{liveCount} lines</span>}
          </div>

          <button onClick={togglePause}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors">
            {paused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
          </button>

          <button onClick={() => connect(activeTab)}
            className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors" title="Reconnect">
            <RefreshCw size={13} />
          </button>

          <button onClick={downloadLog}
            className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors" title="Download log">
            <Download size={13} />
          </button>

          <button onClick={clearLog} disabled={clearing}
            className="p-1.5 rounded bg-zinc-800 hover:bg-red-900/60 text-zinc-400 hover:text-red-300 transition-colors" title="Clear log file">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Log output */}
      <div className="glass-card flex-1 overflow-hidden flex flex-col min-h-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
          <span className="text-xs text-zinc-500 font-mono">
            logs/{activeTab}.log
            {search && <> · <span className="text-gold-400">{visible.length} matches</span></>}
          </span>
          {counts.ERROR > 0 && (
            <span className="text-xs text-red-400 font-medium">{counts.ERROR} error{counts.ERROR > 1 ? 's' : ''} detected</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto bg-zinc-950/80 py-1">
          {visible.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-zinc-600 gap-2">
              <Circle size={28} className="opacity-20" />
              <span className="text-sm">{search ? 'No matching lines' : 'No log entries yet'}</span>
            </div>
          )}
          {(visible as ParsedLine[]).map((line: ParsedLine, i: number) => (
            <React.Fragment key={i}>
              <LogLine line={line} search={search} />
            </React.Fragment>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
