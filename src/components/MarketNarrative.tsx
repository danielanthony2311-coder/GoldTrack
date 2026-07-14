import { useState, useEffect, type ReactNode } from 'react';
import {
  Sparkles, Loader2, RefreshCw, Eye, Lightbulb, GitCompareArrows,
  Radar, Link as LinkIcon, KeyRound,
} from 'lucide-react';
import { cn } from '../utils/cn';

interface NarrativeSource { title: string; url: string }

interface Narrative {
  date: string;
  metal: string;
  headline: string;
  narrative: string;
  theory: string;
  what_changed: string | null;
  confidence: string | null;
  watch_next: string | null;
  sources: NarrativeSource[];
}

const CONFIDENCE_STYLE: Record<string, string> = {
  HIGH: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  MEDIUM: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  LOW: 'bg-zinc-500/10 text-zinc-400 border-zinc-600/40',
};

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-2">
        {icon}
        {title}
      </p>
      <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-line">{children}</div>
    </div>
  );
}

export default function MarketNarrative({ metal, refreshKey }: { metal: 'GOLD' | 'SILVER'; refreshKey?: number }) {
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [narrative, setNarrative] = useState<Narrative | null>(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLatest = async (signal?: AbortSignal) => {
    const res = await fetch(`/api/analysis/latest?metal=${metal}`, { signal });
    if (!res.ok) throw new Error(`status: ${res.status}`);
    const json = await res.json();
    setNarrative(json.narrative ?? null);
    setAiEnabled(Boolean(json.aiEnabled));
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchLatest(controller.signal)
      .catch((e) => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [metal, refreshKey]);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/analysis/run?metal=${metal}&force=1`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `status: ${res.status}`);
      setNarrative(json.narrative ?? null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="glass-card p-6 md:p-8">
      <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-gold-500" />
          <h2 className="text-lg font-bold tracking-tight">What's happening in {metal === 'GOLD' ? 'gold' : 'silver'}?</h2>
          {narrative?.confidence && (
            <span className={cn(
              'text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border',
              CONFIDENCE_STYLE[narrative.confidence] ?? CONFIDENCE_STYLE.LOW
            )}>
              {narrative.confidence} confidence
            </span>
          )}
        </div>
        {aiEnabled && (
          <button
            onClick={handleGenerate}
            disabled={generating}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-100',
              generating && 'opacity-50 cursor-not-allowed'
            )}
          >
            {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {generating ? 'Analyzing…' : 'Update analysis'}
          </button>
        )}
      </div>

      {generating && (
        <p className="text-xs text-zinc-500 mb-4">
          Reading today's warehouse and delivery data, searching the news, and writing the analysis — takes about a minute.
        </p>
      )}

      {error && (
        <p className="text-xs text-rose-400 mb-4">{error}</p>
      )}

      {loading ? (
        <div className="flex items-center gap-3 text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : !aiEnabled && !narrative ? (
        <div className="flex items-start gap-3 text-zinc-400">
          <KeyRound className="w-4 h-4 mt-0.5 shrink-0 text-zinc-500" />
          <p className="text-sm leading-relaxed">
            AI analysis is off because no Anthropic API key is configured. Add{' '}
            <code className="text-zinc-300 font-mono text-xs">ANTHROPIC_API_KEY=…</code> to{' '}
            <code className="text-zinc-300 font-mono text-xs">.env.local</code> (get one at console.anthropic.com)
            and restart the server. Once it's set, this panel explains the day's data in plain English and keeps a
            running theory of what's happening — updated automatically every evening.
          </p>
        </div>
      ) : !narrative ? (
        <p className="text-sm text-zinc-400 leading-relaxed">
          No analysis yet for {metal === 'GOLD' ? 'gold' : 'silver'}. Press <span className="text-zinc-200 font-semibold">Update analysis</span>{' '}
          to generate the first one, or wait for tonight's automatic run.
        </p>
      ) : (
        <div className="space-y-6">
          <p className="text-base md:text-lg font-semibold text-zinc-100 leading-snug">
            {narrative.headline}
          </p>

          <Section icon={<Eye className="w-3 h-3" />} title="What you're looking at">
            {narrative.narrative}
          </Section>

          <div className="rounded-xl border border-gold-500/20 bg-gold-500/[0.04] p-4 md:p-5">
            <Section icon={<Lightbulb className="w-3 h-3 text-gold-500" />} title="Current theory">
              {narrative.theory}
            </Section>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {narrative.what_changed && (
              <Section icon={<GitCompareArrows className="w-3 h-3" />} title="What changed">
                {narrative.what_changed}
              </Section>
            )}
            {narrative.watch_next && (
              <Section icon={<Radar className="w-3 h-3" />} title="What to watch">
                {narrative.watch_next}
              </Section>
            )}
          </div>

          {narrative.sources.length > 0 && (
            <div>
              <p className="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-2">
                <LinkIcon className="w-3 h-3" />
                News used
              </p>
              <ul className="space-y-1">
                {narrative.sources.map((s) => (
                  <li key={s.url}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-zinc-400 hover:text-gold-500 transition-colors underline underline-offset-2 decoration-zinc-700"
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[10px] text-zinc-600 border-t border-zinc-800/40 pt-3">
            AI interpretation of real COMEX data as of {narrative.date} · every figure comes from this app's database ·
            not financial advice
          </p>
        </div>
      )}
    </div>
  );
}
