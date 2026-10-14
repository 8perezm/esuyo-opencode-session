import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  ModelCost,
  ModelInfo,
  OpenCodeClient,
  SessionInfo,
  SessionStructuredError,
  TokenUsageInfo,
} from "@opencode/client";

export type TokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  cost: number;
};

export type DescendantData = {
  sessions: ReadonlyArray<SessionInfo>;
  messages: ReadonlyArray<SessionMessageAssistant>;
  turns: number;
};

export type CostMode = "reported" | "estimated" | "mixed";

export type SessionDetails = {
  toolCalls: number;
  toolFailed: number;
  subagents: number;
  subagentTokens: number;
  models: number;
  topModel: string;
  topShare: number;
  savings: number;
  truncated: number;
  errored: number;
  retried: number;
  files: number;
  ageMs: number;
  busyMs: number;
  avgStepMs: number;
  slowestMs: number;
  slowestAgent: string;
  toolBusyMs: number;
  lastError: string;
  maxRetryAttempt: number;
  lastRetryError: string;
  familyDepth: number;
  directory: string;
  forkedFrom: string;
  rootOutcome: string;
  modelSplit: ModelSplitEntry[];
  toolSplit: ToolSplitEntry[];
  subagentList: SubagentEntry[];
  agentSplit: AgentSplitEntry[];
};

export type ModelSplitEntry = {
  id: string;
  providerID: string;
  steps: number;
  tokens: number;
  cost: number;
};

/** `durationMs` is that tool's own merged run time, so the per-tool figures can exceed the
 *  session total when tools ran at the same time. Zero when the server left the timestamps out. */
export type ToolSplitEntry = {
  name: string;
  calls: number;
  failed: number;
  durationMs: number;
};

/** `spanMs` is the child session's created-to-updated span, not merged busy time: the panel
 *  holds the child's messages but cannot tell which of them belong to which child. */
export type SubagentEntry = {
  id: string;
  title: string;
  agent: string;
  outcome: string;
  spanMs: number;
  tokens: number;
  cost: number;
};

/** One agent's share of the session. `busyMs` is that agent's own merged step time, so the
 *  per-agent figures can add up to more than the session total when agents ran at the same time.
 *  `cacheHit` is null when the agent has no prompt tokens to divide by. */
export type AgentSplitEntry = {
  name: string;
  steps: number;
  tokens: number;
  cost: number;
  busyMs: number;
  cacheHit: number | null;
};

/** AgentSplitEntry plus the prompt-token tallies its cache hit rate is worked out from. */
type AgentTally = AgentSplitEntry & {
  input: number;
  cacheRead: number;
  cacheWrite: number;
};

type CostMessage = Pick<
  SessionMessageAssistant,
  "model" | "tokens"
> & { cost?: number };

export const EMPTY: TokenTotals = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
  cost: 0,
};

export const EMPTY_DETAILS: SessionDetails = {
  toolCalls: 0,
  toolFailed: 0,
  subagents: 0,
  subagentTokens: 0,
  models: 0,
  topModel: "",
  topShare: 0,
  savings: 0,
  truncated: 0,
  errored: 0,
  retried: 0,
  files: 0,
  ageMs: 0,
  busyMs: 0,
  avgStepMs: 0,
  slowestMs: 0,
  slowestAgent: "",
  toolBusyMs: 0,
  lastError: "",
  maxRetryAttempt: 0,
  lastRetryError: "",
  familyDepth: 1,
  directory: "",
  forkedFrom: "",
  rootOutcome: "",
  modelSplit: [],
  toolSplit: [],
  subagentList: [],
  agentSplit: [],
};

const FETCH_CONCURRENCY = 4;

function hasPrice(model: ModelInfo): boolean {
  return model.cost.some((cost) =>
    cost.input > 0 || cost.output > 0 || cost.cache.read > 0 || cost.cache.write > 0
  );
}

function normalizedModelID(id: string): string {
  return (id.split("/").pop() || id).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pricingFor(
  models: ReadonlyArray<ModelInfo>,
  providerID: string,
  modelID: string,
): ModelInfo | undefined {
  const exact = models.find((model) =>
    model.providerID === providerID && (model.id === modelID || model.modelID === modelID)
  );
  if (exact && hasPrice(exact)) return exact;

  const normalized = normalizedModelID(modelID);
  return models.find(
    (model) =>
      hasPrice(model) &&
      (normalizedModelID(model.id) === normalized || normalizedModelID(model.modelID) === normalized),
  );
}

function pricedEntry(model: ModelInfo, tokens: TokenUsageInfo): ModelCost | undefined {
  const contextTokens = tokens.input + tokens.cache.read + tokens.cache.write;
  return (
    model.cost
      .filter(
        (entry) => entry.tier?.type === "context" && contextTokens > entry.tier.size,
      )
      .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ??
    model.cost.find((entry) => !entry.tier)
  );
}

export function estimateCost(
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
): number {
  let total = 0;
  for (const message of messages) {
    const model = pricingFor(models, message.model.providerID, message.model.id);
    if (!model || !message.tokens) continue;

    const tokens = message.tokens;
    const cost = pricedEntry(model, tokens);
    if (!cost) continue;

    total +=
      (tokens.input * cost.input +
        (tokens.output + tokens.reasoning) * cost.output +
        tokens.cache.read * cost.cache.read +
        tokens.cache.write * cost.cache.write) /
      1_000_000;
  }
  return total;
}

/**
 * What the cached prompt tokens would have cost at the uncached input rate,
 * i.e. the amount the prompt cache saved. Reuses pricing that was already
 * loaded for cost estimation, so it adds no requests.
 */
export function estimateCacheSavings(
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
): number {
  let total = 0;
  for (const message of messages) {
    if (!message.tokens) continue;
    const model = pricingFor(models, message.model.providerID, message.model.id);
    if (!model) continue;

    const cost = pricedEntry(model, message.tokens);
    if (!cost) continue;

    const delta = cost.input - cost.cache.read;
    if (delta > 0) total += (delta * message.tokens.cache.read) / 1_000_000;
  }
  return total;
}

export function combineCosts(
  reportedCost: number,
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
): { cost: number; mode: CostMode } {
  const estimatedCost = estimateCost(
    messages.filter((message) => message.cost === 0),
    models,
  );
  return {
    cost: reportedCost + estimatedCost,
    mode:
      estimatedCost > 0
        ? reportedCost > 0
          ? "mixed"
          : "estimated"
        : "reported",
  };
}

export function isAssistant(m: SessionMessageInfo): m is SessionMessageAssistant {
  return m.type === "assistant";
}

export function computeTotals(messages: ReadonlyArray<SessionMessageInfo>): TokenTotals {
  const t: TokenTotals = { ...EMPTY };
  for (const m of messages) {
    if (!isAssistant(m)) continue;
    t.input += m.tokens?.input ?? 0;
    t.output += m.tokens?.output ?? 0;
    t.reasoning += m.tokens?.reasoning ?? 0;
    t.cacheRead += m.tokens?.cache.read ?? 0;
    t.cacheWrite += m.tokens?.cache.write ?? 0;
    t.cost += m.cost ?? 0;
    t.turns += 1;
  }
  return t;
}

export function sumSessions(
  sessions: ReadonlyArray<SessionInfo>,
  turns: number,
): TokenTotals {
  const t: TokenTotals = { ...EMPTY };
  for (const s of sessions) {
    const tk = s.tokens;
    if (!tk) continue;
    t.input += tk.input;
    t.output += tk.output;
    t.reasoning += tk.reasoning;
    t.cacheRead += tk.cache.read;
    t.cacheWrite += tk.cache.write;
    t.cost += s.cost ?? 0;
  }
  t.turns = turns;
  return t;
}

function tokenSum(tokens: TokenUsageInfo | undefined): number {
  if (!tokens) return 0;
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}

type StepInterval = readonly [start: number, end: number];

/**
 * Wall-clock time the agents were actually working: the union of every
 * completed step interval. Merging matters because subagents run concurrently,
 * so summing step durations directly would double-count overlapping work.
 */
function mergedDuration(intervals: ReadonlyArray<StepInterval>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = sorted[0]!;

  for (let index = 1; index < sorted.length; index += 1) {
    const [nextStart, nextEnd] = sorted[index]!;
    if (nextStart <= end) {
      if (nextEnd > end) end = nextEnd;
      continue;
    }
    total += end - start;
    start = nextStart;
    end = nextEnd;
  }

  return total + (end - start);
}

/** Provider errors carry a message and usually a status; the status is what identifies the failure. */
function describeError(error: SessionStructuredError): string {
  const text = error.message?.trim() || error.type || "Provider error";
  return error.status === undefined ? text : `${error.status} ${text}`;
}

/** Cache hit rate for one set of prompt tokens; null when there is nothing to divide by. */
function cacheRate(input: number, cacheRead: number, cacheWrite: number): number | null {
  const prompt = input + cacheRead + cacheWrite;
  return prompt > 0 ? (cacheRead / prompt) * 100 : null;
}

/**
 * How deeply the session family nests: 1 is the root alone, 2 is the root and its children.
 * Walks each child's parent chain, so it costs nothing beyond the sessions already fetched.
 */
function familyDepth(root: SessionInfo, descendants: ReadonlyArray<SessionInfo>): number {
  const byID = new Map(descendants.map((session) => [session.id, session]));
  let depth = 1;

  for (const session of descendants) {
    let levels = 2;
    let parent = session.parentID;
    const seen = new Set<string>([session.id]);
    while (parent !== undefined && parent !== root.id && !seen.has(parent)) {
      seen.add(parent);
      levels += 1;
      parent = byID.get(parent)?.parentID;
    }
    depth = Math.max(depth, levels);
  }

  return depth;
}

/**
 * Everything the expanded panel shows. Derived in one pass over data the
 * refresh already fetched, so expanding costs no requests and no extra work
 * beyond a signal flip.
 */
export function computeDetails(
  root: SessionInfo,
  descendants: ReadonlyArray<SessionInfo>,
  messages: ReadonlyArray<SessionMessageAssistant>,
  models: ReadonlyArray<ModelInfo> | undefined,
  now: number = Date.now(),
): SessionDetails {
  const d: SessionDetails = { ...EMPTY_DETAILS };
  const modelSteps = new Map<string, ModelSplitEntry>();
  const toolSteps = new Map<string, ToolSplitEntry>();
  const toolIntervals = new Map<string, StepInterval[]>();
  const agentSteps = new Map<string, AgentTally>();
  const agentIntervals = new Map<string, StepInterval[]>();
  const files = new Set<string>();
  const steps: StepInterval[] = [];
  const toolTime: StepInterval[] = [];
  let slowestMs = 0;
  let slowestAgent = "";
  let lastErrorAt = -1;
  let lastRetryAt = -1;

  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type !== "tool") continue;
      d.toolCalls += 1;
      const failed = part.state.status === "error";
      if (failed) d.toolFailed += 1;
      const tool = toolSteps.get(part.name) ?? { name: part.name, calls: 0, failed: 0, durationMs: 0 };
      tool.calls += 1;
      if (failed) tool.failed += 1;
      toolSteps.set(part.name, tool);

      // `ran` is when the tool started executing; before that the step is only streaming input.
      const toolStart = part.time.ran ?? part.time.created;
      const toolEnd = part.time.completed;
      if (toolEnd !== undefined && toolEnd >= toolStart) {
        const runs = toolIntervals.get(part.name) ?? [];
        runs.push([toolStart, toolEnd]);
        toolIntervals.set(part.name, runs);
        toolTime.push([toolStart, toolEnd]);
      }
    }

    const agent = message.agent || "unknown";
    const agentEntry =
      agentSteps.get(agent) ?? {
        name: agent,
        steps: 0,
        tokens: 0,
        cost: 0,
        busyMs: 0,
        cacheHit: null,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    agentEntry.steps += 1;
    agentEntry.tokens += tokenSum(message.tokens);
    agentEntry.cost += message.cost ?? 0;
    agentEntry.input += message.tokens?.input ?? 0;
    agentEntry.cacheRead += message.tokens?.cache?.read ?? 0;
    agentEntry.cacheWrite += message.tokens?.cache?.write ?? 0;
    agentSteps.set(agent, agentEntry);

    const modelID = `${message.model.providerID}/${message.model.id}`;
    const model =
      modelSteps.get(modelID) ?? {
        id: message.model.id,
        providerID: message.model.providerID,
        steps: 0,
        tokens: 0,
        cost: 0,
      };
    model.steps += 1;
    model.tokens += tokenSum(message.tokens);
    model.cost += message.cost ?? 0;
    modelSteps.set(modelID, model);

    if (message.finish === "length") d.truncated += 1;
    if (message.finish === "error" || message.error) d.errored += 1;
    // Messages arrive per session and newest-first, so the newest error is found by timestamp
    // rather than by position in the array.
    if (message.error && message.time.created >= lastErrorAt) {
      lastErrorAt = message.time.created;
      d.lastError = describeError(message.error);
    }
    if (message.retry) {
      d.retried += 1;
      d.maxRetryAttempt = Math.max(d.maxRetryAttempt, message.retry.attempt);
      if (message.retry.at >= lastRetryAt) {
        lastRetryAt = message.retry.at;
        d.lastRetryError = describeError(message.retry.error);
      }
    }

    for (const file of message.snapshot?.files ?? []) files.add(file);

    const started = message.time.created;
    const completed = message.time.completed;
    if (completed !== undefined && completed >= started) {
      steps.push([started, completed]);
      const agentStep = agentIntervals.get(agent) ?? [];
      agentStep.push([started, completed]);
      agentIntervals.set(agent, agentStep);
      if (completed - started > slowestMs) {
        slowestMs = completed - started;
        slowestAgent = agent;
      }
    }
  }

  d.files = files.size;
  d.models = modelSteps.size;
  const top = [...modelSteps.entries()].sort((a, b) => b[1].steps - a[1].steps)[0];
  if (top) {
    d.topModel = top[0].slice(top[0].indexOf("/") + 1) || top[0];
    d.topShare = messages.length > 0 ? Math.round((top[1].steps / messages.length) * 100) : 0;
  }

  d.modelSplit = [...modelSteps.values()].sort((a, b) => b.tokens - a.tokens || b.steps - a.steps);
  d.toolSplit = [...toolSteps.values()]
    .map((tool) => ({ ...tool, durationMs: mergedDuration(toolIntervals.get(tool.name) ?? []) }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  d.toolBusyMs = mergedDuration(toolTime);

  d.subagents = descendants.length;
  d.subagentTokens = descendants.reduce((sum, session) => sum + tokenSum(session.tokens), 0);
  d.subagentList = descendants
    .map((session) => ({
      id: session.id,
      title: session.title ?? "",
      agent: session.agent ?? "",
      outcome: session.outcome ?? "",
      spanMs: Math.max(0, session.time.updated - session.time.created),
      tokens: tokenSum(session.tokens),
      cost: session.cost,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  d.agentSplit = [...agentSteps.values()]
    .map((entry) => ({
      name: entry.name,
      steps: entry.steps,
      tokens: entry.tokens,
      cost: entry.cost,
      busyMs: mergedDuration(agentIntervals.get(entry.name) ?? []),
      cacheHit: cacheRate(entry.input, entry.cacheRead, entry.cacheWrite),
    }))
    .sort((a, b) => b.tokens - a.tokens || b.steps - a.steps);

  d.familyDepth = familyDepth(root, descendants);
  d.directory = root.location?.directory ?? "";
  d.forkedFrom = root.fork?.sessionID ?? "";
  d.rootOutcome = root.outcome ?? "";

  d.ageMs = Math.max(0, now - root.time.created);
  d.busyMs = mergedDuration(steps);
  d.slowestMs = slowestMs;
  d.slowestAgent = slowestAgent;
  d.avgStepMs =
    steps.length > 0
      ? Math.round(steps.reduce((sum, [start, end]) => sum + (end - start), 0) / steps.length)
      : 0;

  d.savings = models && models.length > 0 ? estimateCacheSavings(messages, models) : 0;
  return d;
}

export async function mapWithConcurrency<Input, Output>(
  items: ReadonlyArray<Input>,
  worker: (item: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let next = 0;
  const count = Math.min(FETCH_CONCURRENCY, items.length);

  await Promise.all(
    Array.from({ length: count }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]!);
      }
    }),
  );

  return results;
}

export async function fetchAssistantMessages(
  client: OpenCodeClient,
  sessionID: string,
): Promise<SessionMessageAssistant[]> {
  const messages: SessionMessageAssistant[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.message.list({
      sessionID,
      type: "assistant",
      limit: 100,
      ...(cursor ? { cursor } : { order: "desc" }),
    });
    messages.push(...page.data.filter(isAssistant));
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return messages;
}

export async function fetchDescendants(
  client: OpenCodeClient,
  rootID: string,
): Promise<DescendantData> {
  const out: SessionInfo[] = [];
  const visited = new Set([rootID]);
  let level = [rootID];

  while (level.length > 0) {
    const childLists = await mapWithConcurrency(level, async (sessionID) => {
      const children: SessionInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.session.list({
          parentID: sessionID,
          limit: 100,
          ...(cursor ? { cursor } : { order: "desc" }),
        });
        children.push(...page.data);
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
      return children;
    });
    const nextLevel: string[] = [];

    for (const children of childLists) {
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        out.push(child);
        nextLevel.push(child.id);
      }
    }
    level = nextLevel;
  }

  const messages = (await mapWithConcurrency(out, (session) =>
    fetchAssistantMessages(client, session.id)
  )).flat();
  const turns = messages.length;

  return { sessions: out, messages, turns };
}
