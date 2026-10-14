import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  ModelCost,
  ModelInfo,
  OpenCodeClient,
  SessionInfo,
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
  modelSplit: ModelSplitEntry[];
  toolSplit: ToolSplitEntry[];
  subagentList: SubagentEntry[];
};

export type ModelSplitEntry = {
  id: string;
  providerID: string;
  steps: number;
  tokens: number;
  cost: number;
};

export type ToolSplitEntry = {
  name: string;
  calls: number;
  failed: number;
};

export type SubagentEntry = {
  id: string;
  title: string;
  tokens: number;
  cost: number;
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
  modelSplit: [],
  toolSplit: [],
  subagentList: [],
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
  const files = new Set<string>();
  const steps: StepInterval[] = [];

  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type !== "tool") continue;
      d.toolCalls += 1;
      const failed = part.state.status === "error";
      if (failed) d.toolFailed += 1;
      const tool = toolSteps.get(part.name) ?? { name: part.name, calls: 0, failed: 0 };
      tool.calls += 1;
      if (failed) tool.failed += 1;
      toolSteps.set(part.name, tool);
    }

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
    if (message.retry) d.retried += 1;

    for (const file of message.snapshot?.files ?? []) files.add(file);

    const started = message.time.created;
    const completed = message.time.completed;
    if (completed !== undefined && completed >= started) steps.push([started, completed]);
  }

  d.files = files.size;
  d.models = modelSteps.size;
  const top = [...modelSteps.entries()].sort((a, b) => b[1].steps - a[1].steps)[0];
  if (top) {
    d.topModel = top[0].slice(top[0].indexOf("/") + 1) || top[0];
    d.topShare = messages.length > 0 ? Math.round((top[1].steps / messages.length) * 100) : 0;
  }

  d.modelSplit = [...modelSteps.values()].sort((a, b) => b.tokens - a.tokens || b.steps - a.steps);
  d.toolSplit = [...toolSteps.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  d.subagents = descendants.length;
  d.subagentTokens = descendants.reduce((sum, session) => sum + tokenSum(session.tokens), 0);
  d.subagentList = descendants
    .map((session) => ({
      id: session.id,
      title: session.title ?? "",
      tokens: tokenSum(session.tokens),
      cost: session.cost,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  d.ageMs = Math.max(0, now - root.time.created);
  d.busyMs = mergedDuration(steps);
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
