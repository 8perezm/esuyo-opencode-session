import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type StreamSample = {
  at: number;
  tokens: number;
};

export const STREAM_WINDOW_MS = 5_000;
export const LIVE_STALE_MS = 1_500;
export const SINGLE_SAMPLE_MS = 1_000;

/** Timing of one model step. Keyed by the assistant message that owns it. */
export type StepTiming = {
  sessionID: string;
  requestStartAt: number;
  firstResponseAt?: number;
  lastTokenAt?: number;
  lastToolCallAt?: number;
};

export type SessionAverage = {
  totalTokens: number;
  totalDurationMs: number;
  totalTtftMs: number;
  stepCount: number;
};

export type TrackerState = {
  streamSamplesBySession: Record<string, StreamSample[]>;
  timingByMessage: Record<string, StepTiming>;
  openMessages: Record<string, boolean>;
  sessionAverageByID: Record<string, SessionAverage>;
  lastCompletedAtBySession: Record<string, number>;
  lastGapMsBySession: Record<string, number>;
  liveSamplesDroppedBySession: Record<string, boolean>;
};

export type TpsLogRecord = {
  v: 1;
  at: string;
  sessionID: string;
  messageID: string;
  finish: string;
  tokensOutput: number;
  tokensReasoning: number;
  tokensTotal: number;
  durationMs: number;
  ttftMs: number;
  gapMs: number | null;
  avgTps: number;
  liveSamplesDropped: boolean;
};

export const LOG_PATH =
  process.env.ESUYO_TPS_LOG ?? join(homedir(), ".local/share/opencode", "esuyo-opencode-tks.log");

export async function ensureLogDir(): Promise<void> {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
  } catch {
    // Best-effort: logging must never break the TUI.
  }
}

export async function logLine(obj: unknown): Promise<void> {
  try {
    await appendFile(LOG_PATH, JSON.stringify(obj) + "\n", "utf8");
  } catch {
    // Best-effort: I/O errors are swallowed so the TUI never crashes.
  }
}

export function estimateStreamTokens(delta: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5));
}

export function formatRate(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (value >= 100) return `${Math.round(value)}`;
  if (value >= 10) return `${value.toFixed(1)}`;
  return `${value.toFixed(2)}`;
}

export function formatTtft(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return `${value.toFixed(1)}s`;
}

export function formatGap(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`;
}

export function activeDurationMs(samples: StreamSample[], tailAt?: number): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) {
    const tailDuration = tailAt ? Math.max(0, tailAt - samples[0]!.at) : SINGLE_SAMPLE_MS;
    return Math.min(Math.max(tailDuration, 250), SINGLE_SAMPLE_MS);
  }

  let duration = 0;
  for (let i = 1; i < samples.length; i++) {
    duration += Math.max(0, samples[i]!.at - samples[i - 1]!.at);
  }

  if (tailAt) {
    duration += Math.max(0, tailAt - samples[samples.length - 1]!.at);
  }

  return Math.max(duration, SINGLE_SAMPLE_MS);
}

export function createTrackerState(): TrackerState {
  return {
    streamSamplesBySession: {},
    timingByMessage: {},
    openMessages: {},
    sessionAverageByID: {},
    lastCompletedAtBySession: {},
    lastGapMsBySession: {},
    liveSamplesDroppedBySession: {},
  };
}

/** Drop samples outside the streaming window. Returns true when anything changed. */
export function pruneSamples(tracker: TrackerState, now: number = Date.now()): boolean {
  let changed = false;

  for (const [sessionID, samples] of Object.entries(tracker.streamSamplesBySession)) {
    const next = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS);
    if (next.length !== samples.length) {
      changed = true;
      if (next.length > 0) tracker.streamSamplesBySession[sessionID] = next;
      else delete tracker.streamSamplesBySession[sessionID];
    }
  }

  return changed;
}

export function clearLiveSamples(tracker: TrackerState, sessionID: string): void {
  if (!tracker.streamSamplesBySession[sessionID]?.length) return;
  delete tracker.streamSamplesBySession[sessionID];
  tracker.liveSamplesDroppedBySession[sessionID] = true;
}

export function appendSample(
  tracker: TrackerState,
  sessionID: string,
  messageID: string,
  sample: StreamSample,
): void {
  const now = sample.at;
  tracker.streamSamplesBySession[sessionID] = [
    ...(tracker.streamSamplesBySession[sessionID] ?? []).filter(
      (item) => now - item.at <= STREAM_WINDOW_MS,
    ),
    sample,
  ];
  const timing = tracker.timingByMessage[messageID];
  if (timing) {
    tracker.timingByMessage[messageID] = timing.firstResponseAt
      ? { ...timing, lastTokenAt: now }
      : {
          ...timing,
          firstResponseAt: now,
          lastTokenAt: now,
        };
  }
}

export function dropSession(tracker: TrackerState, sessionID: string): void {
  clearLiveSamples(tracker, sessionID);
  for (const [messageID, timing] of Object.entries(tracker.timingByMessage)) {
    if (timing.sessionID !== sessionID) continue;
    delete tracker.timingByMessage[messageID];
    delete tracker.openMessages[messageID];
  }
}

export function handleStepStarted(
  tracker: TrackerState,
  sessionID: string,
  assistantMessageID: string,
  now: number,
): void {
  // The gap is measured at every step start against whatever finished last —
  // a model step or a tool phase — so pauses anywhere in the loop stay visible.
  // Only the first step of a message re-opens it (resets live-sample tracking).
  const previous = tracker.lastCompletedAtBySession[sessionID];
  if (typeof previous === "number") {
    tracker.lastGapMsBySession[sessionID] = Math.max(now - previous, 0);
  }
  if (!tracker.openMessages[assistantMessageID]) {
    tracker.openMessages[assistantMessageID] = true;
    tracker.liveSamplesDroppedBySession[sessionID] = false;
  }

  tracker.timingByMessage[assistantMessageID] = { sessionID, requestStartAt: now };
}

export function handleStepEnded(
  tracker: TrackerState,
  sessionID: string,
  assistantMessageID: string,
  finish: string,
  tokens: { output: number; reasoning: number },
  now: number,
): TpsLogRecord | undefined {
  const timing = tracker.timingByMessage[assistantMessageID];
  delete tracker.timingByMessage[assistantMessageID];

  if (!timing) return undefined;

  let record: TpsLogRecord | undefined;
  const totalTokens = tokens.output + tokens.reasoning;
  if (typeof timing.firstResponseAt === "number" && totalTokens > 0) {
    const endAt = finish === "tool-calls" ? (timing.lastToolCallAt ?? now) : now;
    const durationMs = Math.max(endAt - timing.firstResponseAt, 1);
    const ttftMs = Math.max(timing.firstResponseAt - timing.requestStartAt, 0);
    // The session average runs on wall-clock time per step (request start to finish),
    // not on visible streaming time: thinking, queueing and tool phases produce no
    // deltas, so dividing their tokens by streaming time alone inflates the average
    // into the hundreds on reasoning-heavy sessions.
    const wallDurationMs = Math.max(endAt - timing.requestStartAt, 1);
    const totals = tracker.sessionAverageByID[sessionID] ?? {
      totalTokens: 0,
      totalDurationMs: 0,
      totalTtftMs: 0,
      stepCount: 0,
    };
    tracker.sessionAverageByID[sessionID] = {
      totalTokens: totals.totalTokens + totalTokens,
      totalDurationMs: totals.totalDurationMs + wallDurationMs,
      totalTtftMs: totals.totalTtftMs + ttftMs,
      stepCount: totals.stepCount + 1,
    };
    record = {
      v: 1,
      at: new Date(now).toISOString(),
      sessionID,
      messageID: assistantMessageID,
      finish,
      tokensOutput: tokens.output,
      tokensReasoning: tokens.reasoning,
      tokensTotal: totalTokens,
      durationMs,
      ttftMs,
      gapMs: tracker.lastGapMsBySession[sessionID] ?? null,
      avgTps: Number((totalTokens / (durationMs / 1000)).toFixed(2)),
      liveSamplesDropped: tracker.liveSamplesDroppedBySession[sessionID] ?? false,
    };
  }

  // Every completed step resets the GAP baseline — including intermediate
  // tool-call steps — so the next start measures the pause since the last
  // action finished, tool phases included.
  tracker.lastCompletedAtBySession[sessionID] = now;
  if (finish !== "tool-calls") {
    delete tracker.openMessages[assistantMessageID];
  }
  delete tracker.liveSamplesDroppedBySession[sessionID];
  pruneSamples(tracker, now);
  return record;
}

export function handleStepFailed(tracker: TrackerState, assistantMessageID: string): void {
  delete tracker.timingByMessage[assistantMessageID];
  delete tracker.openMessages[assistantMessageID];
}

export function handleToolCalled(
  tracker: TrackerState,
  sessionID: string,
  assistantMessageID: string,
  now: number,
): void {
  clearLiveSamples(tracker, sessionID);
  const timing = tracker.timingByMessage[assistantMessageID];
  if (!timing) return;
  timing.firstResponseAt = timing.firstResponseAt ?? now;
  timing.lastToolCallAt = now;
}

export function handleTextDelta(
  tracker: TrackerState,
  sessionID: string,
  assistantMessageID: string,
  delta: string,
  now: number = Date.now(),
): void {
  appendSample(tracker, sessionID, assistantMessageID, {
    at: now,
    tokens: estimateStreamTokens(delta),
  });
}

export function sessionAverageRate(tracker: TrackerState, sessionID: string): string | undefined {
  const totals = tracker.sessionAverageByID[sessionID];
  if (!totals || totals.totalTokens <= 0 || totals.totalDurationMs <= 0) return undefined;
  return formatRate(totals.totalTokens / (totals.totalDurationMs / 1000));
}

export function sessionTtft(tracker: TrackerState, sessionID: string): string | undefined {
  const totals = tracker.sessionAverageByID[sessionID];
  if (!totals || totals.stepCount <= 0 || totals.totalTtftMs < 0) return undefined;
  return formatTtft(totals.totalTtftMs / totals.stepCount / 1000);
}

export function liveTps(
  tracker: TrackerState,
  sessionID: string,
  isIdle: boolean,
  now: number = Date.now(),
): string | undefined {
  if (isIdle) return undefined;
  const samples = tracker.streamSamplesBySession[sessionID] ?? [];
  if (samples.length === 0) return undefined;
  const relevant = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS);
  if (relevant.length === 0) return undefined;
  const lastSample = relevant[relevant.length - 1];
  if (!lastSample || now - lastSample.at > LIVE_STALE_MS) return undefined;
  const total = relevant.reduce((sum, sample) => sum + sample.tokens, 0);
  const durationSeconds = activeDurationMs(relevant, now) / 1000;
  if (durationSeconds <= 0) return undefined;
  return formatRate(total / durationSeconds);
}

export function lastGap(tracker: TrackerState, sessionID: string): string | undefined {
  const ms = tracker.lastGapMsBySession[sessionID];
  if (typeof ms !== "number" || ms < 0) return undefined;
  return formatGap(ms);
}

export function statusTextFor(
  tracker: TrackerState,
  sessionID: string,
  isIdle: boolean,
  now: number = Date.now(),
): string {
  const live = liveTps(tracker, sessionID, isIdle, now) ?? "-";
  const avg = sessionAverageRate(tracker, sessionID) ?? "-";
  const ttft = sessionTtft(tracker, sessionID) ?? "-";
  const gap = lastGap(tracker, sessionID) ?? "-";
  return `TPS ${live} | AVG ${avg} | TTFT ${ttft} | GAP ${gap}`;
}
