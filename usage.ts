import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  ModelInfo,
  OpenCodeClient,
  SessionInfo,
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

export function estimateCost(
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
): number {
  let total = 0;
  for (const message of messages) {
    const model = pricingFor(models, message.model.providerID, message.model.id);
    if (!model || !message.tokens) continue;

    const tokens = message.tokens;
    const contextTokens = tokens.input + tokens.cache.read + tokens.cache.write;
    const cost =
      model.cost
        .filter(
          (entry) => entry.tier?.type === "context" && contextTokens > entry.tier.size,
        )
        .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ??
      model.cost.find((entry) => !entry.tier);
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
