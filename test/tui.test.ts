import { describe, expect, test } from "bun:test";
import type { Context, SlotClaim } from "@opencode/plugin/tui/context";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import plugin from "../tui";
import type {
  SessionMessageAssistant as AssistantMessage,
  ModelInfo as Model,
  OpenCodeClient,
  SessionInfo as Session,
} from "@opencode/client";
import {
  combineCosts,
  computeDetails,
  computeTotals,
  estimateCacheSavings,
  estimateCost,
  fetchAssistantMessages,
  fetchDescendants,
  sumSessions,
} from "../usage";
import {
  activeDurationMs,
  createTrackerState,
  dropSession,
  estimateStreamTokens,
  formatGap,
  formatRate,
  formatTtft,
  handleStepEnded,
  handleStepFailed,
  handleStepStarted,
  handleTextDelta,
  handleToolCalled,
  lastGap,
  liveTps,
  pruneSamples,
  sessionAverageRate,
  sessionTtft,
  statusTextFor,
} from "../tps";

function assistant(id: string): AssistantMessage {
  return {
    id,
    type: "assistant",
    time: { created: 0 },
    model: { id: "model", providerID: "provider" },
    agent: "build",
    content: [],
    cost: 0.5,
    tokens: {
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 10, write: 2 },
    },
  };
}

function session(id: string): Session {
  return {
    id,
    projectID: "project",
    location: { directory: "/" },
    title: id,
    cost: 1,
    tokens: {
      input: 50,
      output: 10,
      reasoning: 2,
      cache: { read: 3, write: 1 },
    },
    time: { created: 0, updated: 0 },
  };
}

function pricedModel(
  id: string,
  providerID: string,
  cost: Model["cost"][number],
): Model {
  return {
    id,
    modelID: id,
    providerID,
    cost: [cost],
  } as Model;
}

function toolCall(id: string, name: string, failed: boolean): AssistantMessage["content"][number] {
  return failed
    ? {
        type: "tool",
        id,
        name,
        time: { created: 0 },
        state: {
          status: "error",
          input: {},
          error: { type: "tool_error", message: "failed" },
        },
      }
    : {
        type: "tool",
        id,
        name,
        time: { created: 0 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "ok" }],
        },
      };
}

function toolRun(
  id: string,
  name: string,
  time: { created: number; ran?: number; completed?: number },
): AssistantMessage["content"][number] {
  return {
    type: "tool",
    id,
    name,
    time,
    state: {
      status: "completed",
      input: {},
      content: [{ type: "text", text: "ok" }],
    },
  };
}

function clientFor(
  children: Record<string, Session[]>,
  messages: Record<string, AssistantMessage[]>,
): OpenCodeClient {
  return {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => session(sessionID),
      list: async ({ parentID }: { parentID: string }) => ({
        data: children[parentID] ?? [],
        cursor: {},
      }),
    },
    message: {
      list: async ({ sessionID }: { sessionID: string }) => ({
        data: messages[sessionID] ?? [],
        cursor: {},
      }),
    },
  } as unknown as OpenCodeClient;
}

describe("token aggregation", () => {
  test("sums assistant messages and descendant session aggregates", () => {
    const root = computeTotals([assistant("root-1")]);
    const descendants = sumSessions([session("child")], 2);

    expect(root).toMatchObject({ input: 100, output: 20, turns: 1, cost: 0.5 });
    expect(descendants).toMatchObject({ input: 50, output: 10, turns: 2, cost: 1 });
  });
});

describe("cost estimation", () => {
  test("uses the same token categories and per-million rates as OpenCode", () => {
    const message = assistant("priced");
    message.cost = 0;
    message.model = { id: "claude-opus-4-6", providerID: "anthropic" };
    const model = pricedModel(message.model.id, message.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(estimateCost([message], [model])).toBeCloseTo(
      0.0006855,
    );
  });

  test("finds API pricing across providers for quota-backed model aliases", () => {
    const message = assistant("quota");
    message.cost = 0;
    message.model = { id: "claude-opus-4.6", providerID: "github-copilot" };
    const quotaModel = pricedModel(message.model.id, message.model.providerID, {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    const apiModel = pricedModel("claude-opus-4-6", "anthropic", {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(
      estimateCost(
        [message],
        [
          quotaModel,
          apiModel,
        ],
      ),
    ).toBeGreaterThan(0);
  });

  test("combines reported and estimated costs into one mixed total", () => {
    const reported = assistant("reported");
    const quota = assistant("quota");
    quota.cost = 0;
    quota.model = { id: "claude-opus-4-6", providerID: "anthropic" };
    const model = pricedModel(quota.model.id, quota.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(
      combineCosts(reported.cost!, [reported, quota], [model]),
    ).toEqual({ cost: 0.5006855, mode: "mixed" });
  });

  test("marks a fully estimated total", () => {
    const quota = assistant("quota");
    quota.cost = 0;
    const model = pricedModel(quota.model.id, quota.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(combineCosts(0, [quota], [model])).toEqual({
      cost: 0.0006855,
      mode: "estimated",
    });
  });

  test("does not estimate messages with an omitted cost", () => {
    const message = assistant("missing");
    delete (message as { cost?: number }).cost;
    const model = pricedModel(message.model.id, message.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(combineCosts(0.25, [message], [model])).toEqual({
      cost: 0.25,
      mode: "reported",
    });
  });

  test("uses context tiers only above their threshold", () => {
    const message = assistant("tiered");
    const model = pricedModel("model", "provider", {
      input: 1, output: 1, cache: { read: 1, write: 1 },
    });
    model.cost.push({
      tier: { type: "context", size: 112 },
      input: 2, output: 2, cache: { read: 2, write: 2 },
    });
    expect(estimateCost([message], [model])).toBeCloseTo(0.000137);
    message.tokens!.input += 1;
    expect(estimateCost([message], [model])).toBeCloseTo(0.000276);
  });

  test("skips unfinished assistant messages without tokens", () => {
    const message = assistant("unfinished");
    delete message.tokens;
    const model = pricedModel("model", "provider", {
      input: 1, output: 1, cache: { read: 1, write: 1 },
    });
    expect(estimateCost([message], [model])).toBe(0);
    expect(computeTotals([message])).toMatchObject({ input: 0, turns: 1 });
  });
});

describe("expanded session details", () => {
  test("derives metrics from already fetched messages", () => {
    const root = session("root");
    root.time = { created: 1_000, updated: 61_000 };
    const message = assistant("root-turn");
    message.content = [toolCall("t1", "bash", false), toolCall("t2", "edit", true)];
    message.finish = "length";
    message.retry = { attempt: 2, at: 1_500, error: { type: "rate_limit", message: "slow down" } };
    message.snapshot = { files: ["tui.tsx", "usage.ts"] };
    message.time = { created: 1_000, completed: 3_000 };

    expect(computeDetails(root, [session("child")], [message], undefined, 61_000)).toMatchObject({
      toolCalls: 2,
      toolFailed: 1,
      files: 2,
      truncated: 1,
      errored: 0,
      retried: 1,
      subagents: 1,
      subagentTokens: 66,
      models: 1,
      topModel: "model",
      topShare: 100,
      ageMs: 60_000,
      busyMs: 2_000,
      avgStepMs: 2_000,
      savings: 0,
    });
  });

  test("session age runs from creation to now, not to last activity", () => {
    const root = session("root");
    root.time = { created: 1_000, updated: 5_000 };

    expect(computeDetails(root, [], [], undefined, 61_000).ageMs).toBe(60_000);
    expect(computeDetails(root, [], [], undefined, 2_000).ageMs).toBe(1_000);
    expect(computeDetails(root, [], [], undefined, 0).ageMs).toBe(0);
  });

  test("counts busy time once when subagent steps overlap", () => {
    const rootStep = assistant("root-step");
    rootStep.time = { created: 0, completed: 1_000 };
    const subagentStep = assistant("subagent-step");
    subagentStep.time = { created: 500, completed: 1_500 };
    const laterStep = assistant("later-step");
    laterStep.time = { created: 2_000, completed: 2_500 };
    const running = assistant("running-step");
    running.time = { created: 3_000 };

    expect(computeDetails(session("root"), [], [rootStep, subagentStep, laterStep, running], undefined, 9_000))
      .toMatchObject({ busyMs: 2_000, avgStepMs: 833 });
  });

  test("splits steps across models and reports the dominant one", () => {
    const first = assistant("first");
    first.model = { id: "claude-opus-4-6", providerID: "anthropic" };
    const second = assistant("second");
    second.model = { id: "claude-opus-4-6", providerID: "anthropic" };
    const third = assistant("third");
    third.model = { id: "gpt-5.2", providerID: "openai" };

    expect(computeDetails(session("root"), [], [first, second, third], undefined, 0)).toMatchObject({
      models: 2,
      topModel: "claude-opus-4-6",
      topShare: 67,
    });
  });

  test("values stay zero when messages carry no extra data", () => {
    expect(computeDetails(session("root"), [], [assistant("bare")], undefined, 0))
      .toMatchObject({
        toolCalls: 0,
        files: 0,
        models: 1,
        ageMs: 0,
        busyMs: 0,
        avgStepMs: 0,
        savings: 0,
        toolSplit: [],
        subagentList: [],
      });
  });

  test("splits the session across agents with each agent's own busy time", () => {
    const build = assistant("build-step");
    build.agent = "build";
    build.time = { created: 0, completed: 2_000 };
    const explore = assistant("explore-step");
    explore.agent = "explore";
    explore.tokens = { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
    explore.time = { created: 1_000, completed: 4_000 };
    const second = assistant("build-step-2");
    second.agent = "build";
    second.time = { created: 3_000, completed: 5_000 };

    const details = computeDetails(session("root"), [], [build, explore, second], undefined, 9_000);

    expect(
      details.agentSplit.map((agent) => ({
        ...agent,
        cacheHit: agent.cacheHit === null ? null : Math.round(agent.cacheHit),
      })),
    ).toEqual([
      { name: "build", steps: 2, tokens: 274, cost: 1, busyMs: 4_000, cacheHit: 9 },
      { name: "explore", steps: 1, tokens: 11, cost: 0.5, busyMs: 3_000, cacheHit: 0 },
    ]);
    // build's steps overlap explore's, so the session total is smaller than the sum of the parts
    expect(details.busyMs).toBe(5_000);
  });

  test("reports the slowest step and the agent that ran it", () => {
    const quick = assistant("quick");
    quick.agent = "explore";
    quick.time = { created: 0, completed: 1_000 };
    const slow = assistant("slow");
    slow.agent = "build";
    slow.time = { created: 1_000, completed: 72_000 };
    const running = assistant("running");
    running.agent = "build";
    running.time = { created: 72_000 };

    expect(computeDetails(session("root"), [], [quick, slow, running], undefined, 90_000)).toMatchObject({
      slowestMs: 71_000,
      slowestAgent: "build",
    });
  });

  test("reports the newest error with its status, even out of order", () => {
    const early = assistant("early");
    early.time = { created: 1_000 };
    early.error = { type: "provider_error", message: "overloaded", status: 529 };
    const late = assistant("late");
    late.time = { created: 9_000 };
    late.error = { type: "rate_limit", message: " too many requests ", status: 429 };

    expect(computeDetails(session("root"), [], [late, early], undefined, 10_000).lastError)
      .toBe("429 too many requests");

    const noMessage = assistant("no-message");
    noMessage.error = { type: "provider_error", message: "" };
    expect(computeDetails(session("root"), [], [noMessage], undefined, 0).lastError)
      .toBe("provider_error");
  });

  test("measures how long each tool ran, merging overlapping runs", () => {
    const message = assistant("tools");
    message.content = [
      toolRun("a", "bash", { created: 1_000, ran: 3_000, completed: 6_000 }),
      toolRun("b", "bash", { created: 4_000, ran: 5_000, completed: 8_000 }),
      toolRun("c", "edit", { created: 0, ran: 10_000, completed: 14_000 }),
      // no `ran`: the tool started when the part was created
      toolRun("d", "edit", { created: 20_000, completed: 21_500 }),
      // the server left the timestamps out entirely
      toolCall("e", "grep", false),
    ];

    const details = computeDetails(session("root"), [], [message], undefined, 0);

    expect(details.toolSplit).toEqual([
      { name: "bash", calls: 2, failed: 0, durationMs: 5_000 },
      { name: "edit", calls: 2, failed: 0, durationMs: 5_500 },
      { name: "grep", calls: 1, failed: 0, durationMs: 0 },
    ]);
    // 3s-8s, 10s-14s and 20s-21.5s never overlap, so the total is their sum
    expect(details.toolBusyMs).toBe(10_500);
  });

  test("carries each subagent's agent, outcome and wall time", () => {
    const child = session("child");
    child.title = "explore the auth module";
    child.agent = "explore";
    child.outcome = "succeeded";
    child.time = { created: 1_000, updated: 61_000 };

    expect(computeDetails(session("root"), [child], [], undefined, 0).subagentList).toEqual([
      {
        id: "child",
        title: "explore the auth module",
        agent: "explore",
        outcome: "succeeded",
        spanMs: 60_000,
        tokens: 66,
        cost: 1,
      },
    ]);
  });

  test("counts how deeply the session family nests", () => {
    const child = session("child");
    child.parentID = "root";
    const other = session("other");
    other.parentID = "root";
    const grandchild = session("grandchild");
    grandchild.parentID = "child";

    expect(computeDetails(session("root"), [], [], undefined, 0).familyDepth).toBe(1);
    expect(computeDetails(session("root"), [child, other], [], undefined, 0).familyDepth).toBe(2);
    expect(
      computeDetails(session("root"), [child, other, grandchild], [], undefined, 0).familyDepth,
    ).toBe(3);
  });

  test("carries the session identity for the page header", () => {
    const root = session("root");
    root.location = { directory: "C:\\repo\\app" };
    root.outcome = "interrupted";
    root.fork = { sessionID: "ses_parent", boundary: { type: "through", messageID: "m1" } };

    expect(computeDetails(root, [], [], undefined, 0)).toMatchObject({
      directory: "C:\\repo\\app",
      rootOutcome: "interrupted",
      forkedFrom: "ses_parent",
    });
  });

  test("reports the highest retry attempt and the newest retry reason", () => {
    const first = assistant("first");
    first.retry = { attempt: 2, at: 1_000, error: { type: "rate_limit", message: "slow down", status: 429 } };
    const second = assistant("second");
    second.retry = { attempt: 4, at: 5_000, error: { type: "server_error", message: "overloaded", status: 529 } };

    expect(computeDetails(session("root"), [], [second, first], undefined, 0)).toMatchObject({
      retried: 2,
      maxRetryAttempt: 4,
      lastRetryError: "529 overloaded",
    });
  });

  test("breaks the session down by tool, model and subagent", () => {
    const heavy = assistant("heavy");
    heavy.model = { id: "gpt-5.2", providerID: "openai" };
    heavy.content = [toolCall("a", "bash", false), toolCall("b", "bash", true), toolCall("c", "edit", false)];
    const light = assistant("light");
    light.tokens = { input: 10, output: 1, reasoning: 0, cache: { read: 1, write: 0 } };
    light.content = [toolCall("d", "edit", false)];

    const child = session("child");
    child.title = "explore repo";

    const details = computeDetails(session("root"), [child], [heavy, light], undefined, 0);

    expect(details.toolSplit).toEqual([
      // the fixture tool parts carry no completion time, so no duration is invented for them
      { name: "bash", calls: 2, failed: 1, durationMs: 0 },
      { name: "edit", calls: 2, failed: 0, durationMs: 0 },
    ]);
    expect(details.modelSplit.map((model) => [model.id, model.steps, model.tokens])).toEqual([
      ["gpt-5.2", 1, 137],
      ["model", 1, 12],
    ]);
    expect(details.subagentList).toEqual([
      {
        id: "child",
        title: "explore repo",
        agent: "",
        outcome: "",
        spanMs: 0,
        tokens: 66,
        cost: 1,
      },
    ]);
  });

  test("estimates what the prompt cache saved from loaded pricing", () => {
    const message = assistant("cached");
    message.cost = 0;
    const model = pricedModel(message.model.id, message.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(estimateCacheSavings([message], [model])).toBeCloseTo(0.000027);
    expect(estimateCacheSavings([message], [])).toBe(0);
  });
});

describe("descendant fetching", () => {
  test("follows message cursors and requests only assistant messages", async () => {
    const client = clientFor({}, {});
    const calls: unknown[] = [];
    client.message.list = async (input) => {
      calls.push(input);
      return input.cursor
        ? { data: [assistant("second")], cursor: {} }
        : { data: [assistant("first")], cursor: { next: "more" } };
    };
    expect(await fetchAssistantMessages(client, "root")).toHaveLength(2);
    expect(calls).toEqual([
      { sessionID: "root", type: "assistant", limit: 100, order: "desc" },
      { sessionID: "root", type: "assistant", limit: 100, cursor: "more" },
    ]);
  });

  test("follows child cursors without including unrelated sessions", async () => {
    const client = clientFor({}, {});
    client.session.list = async (input) => {
      if (input?.parentID !== "root") return { data: [], cursor: {} };
      return input.cursor
        ? { data: [session("second")], cursor: {} }
        : { data: [session("first")], cursor: { next: "more" } };
    };
    expect((await fetchDescendants(client, "root")).sessions.map((s) => s.id))
      .toEqual(["first", "second"]);
  });

  test("collects nested descendants once and counts their assistant turns", async () => {
    const child = session("child");
    const grandchild = session("grandchild");
    const client = clientFor(
      { root: [child], child: [grandchild], grandchild: [child] },
      { child: [assistant("child-1")], grandchild: [assistant("grandchild-1")] },
    );

    await expect(fetchDescendants(client, "root")).resolves.toEqual({
      sessions: [child, grandchild],
      messages: [assistant("child-1"), assistant("grandchild-1")],
      turns: 2,
    });
  });

  test("fails the refresh when any descendant request fails", async () => {
    const client = clientFor({ root: [session("child")] }, {});
    const messageApi = client.message as unknown as {
      list: () => Promise<never>;
    };
    messageApi.list = async () => {
      throw new Error("unavailable");
    };

    await expect(fetchDescendants(client, "root")).rejects.toThrow("unavailable");
  });

  test("limits concurrent descendant requests", async () => {
    let active = 0;
    let peak = 0;
    const children: Record<string, Session[]> = {
      root: Array.from({ length: 8 }, (_, index) => session(`child-${index}`)),
    };
    const client = clientFor(children, {});
    const sessionApi = client.session as unknown as {
      list: ({ parentID }: { parentID: string }) => Promise<{ data: Session[]; cursor: object }>;
    };
    sessionApi.list = async ({ parentID }) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      return { data: children[parentID] ?? [], cursor: {} };
    };

    await fetchDescendants(client, "root");
    expect(peak).toBeLessThanOrEqual(4);
  });
});

test("V2 plugin renders, switches sessions, retains totals on failure, and cleans up", async () => {
  expect(plugin.id).toBe("esuyo-opencode-session");
  expect(typeof plugin.setup).toBe("function");
  const rootTurn = assistant("root-turn");
  rootTurn.content = [toolCall("t1", "bash", false), toolCall("t2", "edit", true)];
  rootTurn.snapshot = { files: ["tui.tsx", "usage.ts"] };
  const client = clientFor({ root: [session("child")] }, {
    root: [rootTurn], child: [assistant("child-turn")],
    other: [assistant("other-turn")],
  });
  const requests = { sessionGet: 0, sessionList: 0, messageList: 0 };
  const sessionApi = client.session as unknown as {
    get: (input: { sessionID: string }) => Promise<Session>;
    list: (input: { parentID: string }) => Promise<{ data: Session[]; cursor: object }>;
  };
  const messageApi = client.message as unknown as {
    list: (input: { sessionID: string }) => Promise<{ data: AssistantMessage[]; cursor: object }>;
  };
  const fetchSession = sessionApi.get, listSessions = sessionApi.list, listMessages = messageApi.list;
  sessionApi.get = async (input) => { requests.sessionGet += 1; return fetchSession(input); };
  sessionApi.list = async (input) => { requests.sessionList += 1; return listSessions(input); };
  messageApi.list = async (input) => { requests.messageList += 1; return listMessages(input); };
  const handlers = new Map<string, (event: { data: { sessionID: string } }) => void>();
  const layers: Array<{ commands: Array<{ id: string; slash?: { name: string }; run?: () => void }> }> = [];
  const pages: Array<{ name: string; render: (input: { data?: Record<string, unknown> }) => unknown }> = [];
  const navigations: unknown[] = [];
  let pageRemoved = false;
  const color = RGBA.fromHex("#c6d0f5");
  const muted = RGBA.fromHex("#949cbb");
  const accent = RGBA.fromHex("#8caaee");
  const border = RGBA.fromHex("#51576d");
  let claim: SlotClaim<"sidebar.content">;
  let cleanup: (() => void) | undefined;
  let select: (id: string) => void;
  let slotRemoved = false;
  let footerRemoved = false;
  const context = {
    client,
    data: {
      on(type: string, handler: (event: { data: { sessionID: string } }) => void) {
        handlers.set(type, handler);
        return () => { handlers.delete(type); };
      },
    },
    ui: {
      slot(value: SlotClaim<"sidebar.content"> & { append?: string }) {
        if ((value as { append?: string }).append === "prompt.footer.status") {
          return () => { footerRemoved = true; };
        }
        claim = value;
        return () => { slotRemoved = true; };
      },
      router: {
        register(page: { name: string; render: (input: { data?: Record<string, unknown> }) => unknown }) {
          pages.push(page);
          return () => { pageRemoved = true; };
        },
        navigate(destination: unknown) {
          navigations.push(destination);
        },
        current() {
          return { type: "session", sessionID: "root" };
        },
      },
    },
    keymap: {
      layer(factory: () => (typeof layers)[number]) {
        layers.push(factory());
      },
      mode: {
        current: () => "base",
        push: () => () => undefined,
      },
    },
    theme: {
      text: {
        base: color, muted,
        feedback: { info: { base: accent }, warning: { base: color }, error: { base: color } },
      },
      border: { base: border },
    },
  } as unknown as Context;
  const view = await testRender(() => {
    const [selected, setSelected] = createSignal("root");
    select = setSelected;
    cleanup = plugin.setup(context) as () => void;
    return claim.render({ get sessionID() { return selected(); } });
  }, { width: 60, height: 20 });
  try {
    await view.waitForFrame((frame) => frame.includes("2 turns"));
    expect(view.captureCharFrame()).toContain("Session Token Summary");
    expect(view.captureCharFrame()).toContain("$2.00");
    const spans = view.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.find((span) => span.text.includes("Session Token Summary"))?.fg.equals(color)).toBe(true);
    expect(spans.find((span) => span.text.includes("2 turns"))?.fg.equals(muted)).toBe(true);
    expect(spans.find((span) => span.text.includes("↑ in"))?.fg.equals(muted)).toBe(true);
    expect(spans.find((span) => span.text.trim() === "100")?.fg.equals(color)).toBe(true);
    expect(spans.find((span) => span.text.includes("─"))?.fg.equals(border)).toBe(true);
    const total = spans.find((span) => span.text.trim() === "132");
    expect(total?.fg.equals(color)).toBe(true);
    expect((total?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    expect(spans.find((span) => span.text.includes("$2.00"))?.fg.equals(accent)).toBe(true);
    expect(view.captureCharFrame()).toContain("▸ Session Summary");
    expect(view.captureCharFrame()).not.toContain("Session Token Summary ▸");
    expect(view.captureCharFrame()).not.toContain("▣ tools");
    expect(view.captureCharFrame()).toContain("⤺ open session details");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.name).toBe("session-usage-details");

    expect(layers).toHaveLength(2);
    const toggle = layers[0]!.commands[0]!;
    expect(toggle.id).toBe("session.usage.details");
    expect(toggle.slash?.name).toBe("usage");

    const requestsBefore = { ...requests };
    toggle.run!();
    await view.waitForFrame((frame) => frame.includes("▣ tools"));
    const expanded = view.captureCharFrame();
    expect(expanded).toContain("▾ Session Summary");
    expect(expanded).toContain("Session Token Summary");
    expect(expanded).toContain("▣ tools");
    expect(expanded).toContain("2 · 1 failed");
    expect(expanded).toContain("≡ files");
    expect(expanded).toContain("└ subagents");
    expect(expanded).toContain("1 · 66");
    expect(requests).toEqual(requestsBefore);

    toggle.run!();
    await view.waitForFrame((frame) => !frame.includes("▣ tools"));
    expect(requests).toEqual(requestsBefore);

    const openPage = layers[0]!.commands[1]!;
    expect(openPage.id).toBe("session.usage.page");
    expect(openPage.slash).toBeUndefined();

    const requestsBeforeOpen = { ...requests };
    openPage.run!();
    expect(navigations).toEqual([
      {
        type: "plugin",
        name: "session-usage-details",
        data: { sessionID: "root", returnRoute: { type: "session", sessionID: "root" } },
      },
    ]);
    expect(requests).toEqual(requestsBeforeOpen);

    const quota = assistant("quota");
    quota.cost = 0;
    client.message.list = async ({ sessionID }) => ({
      data: sessionID === "root" ? [quota] : [assistant("other-turn")], cursor: {},
    });
    const pricing = Promise.withResolvers<{ data: Model[]; location: { directory: string } }>();
    let pricingStarted = false;
    client.model = {
      list: async () => { pricingStarted = true; return pricing.promise; },
    } as OpenCodeClient["model"];
    handlers.get("session.usage.updated")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    expect(pricingStarted).toBe(true);
    select!("other");
    await view.waitForFrame((frame) => frame.includes("1 turn"));
    expect(view.captureCharFrame()).toContain("$1.00");
    pricing.resolve({ data: [], location: { directory: "/" } });
    await view.flush();
    expect(view.captureCharFrame()).toContain("1 turn");
    expect(view.captureCharFrame()).not.toContain("2 turns");

    client.session.get = async () => { throw new Error("unavailable"); };
    handlers.get("session.usage.updated")!({ data: { sessionID: "other" } });
    await Bun.sleep(250);
    await view.flush();
    expect(view.captureCharFrame()).toContain("$1.00");
    expect(view.captureCharFrame()).not.toContain("unavailable");
    handlers.get("session.usage.updated")!({ data: { sessionID: "other" } });
    cleanup!();
    expect(handlers.size).toBe(0);
    expect(slotRemoved).toBe(true);
    expect(footerRemoved).toBe(true);
    expect(pageRemoved).toBe(true);
  } finally {
    if (!slotRemoved) cleanup?.();
    await view.dispose();
  }
});

test("details page renders the breakdown and closes without extra requests", async () => {
  const root = session("root");
  root.location = { directory: "C:\\repo\\app" };
  root.outcome = "interrupted";
  root.fork = { sessionID: "ses_parent", boundary: { type: "through", messageID: "m1" } };
  const turn = assistant("root-turn");
  turn.content = [
    toolRun("t1", "bash", { created: 0, ran: 500, completed: 4_500 }),
    toolCall("t2", "edit", true),
  ];
  turn.snapshot = { files: ["tui.tsx", "usage.ts"] };
  turn.time = { created: 0, completed: 2_000 };
  turn.error = { type: "rate_limit", message: "too many requests", status: 429 };
  turn.retry = { attempt: 3, at: 1_500, error: { type: "server_error", message: "overloaded", status: 529 } };
  const child = session("child");
  child.title = "explore the auth module";
  child.agent = "explore";
  child.outcome = "succeeded";
  child.time = { created: 0, updated: 61_000 };
  const grandchild = session("grandchild");
  grandchild.parentID = "child";
  const requests = { sessionGet: 0, sessionList: 0, messageList: 0 };
  const client = {
    session: {
      get: async () => { requests.sessionGet += 1; return root; },
      list: async () => { requests.sessionList += 1; return { data: [child, grandchild], cursor: {} }; },
    },
    message: {
      list: async () => { requests.messageList += 1; return { data: [turn], cursor: {} }; },
    },
  } as unknown as OpenCodeClient;

  const color = RGBA.fromHex("#c6d0f5");
  const muted = RGBA.fromHex("#949cbb");
  const pages: Array<{ name: string; render: (input: { data?: Record<string, unknown> }) => any }> = [];
  const navigations: unknown[] = [];
  const modes: string[] = [];
  const layers: Array<{
    mode?: string;
    enabled?: () => boolean;
    commands: Array<{ id?: string; bind?: string; enabled?: () => boolean; run: () => void }>;
  }> = [];
  const closeLayer = () =>
    layers.find((layer) => layer.commands.some((command) => command.bind === "escape,ctrl+c"))!;
  const closeCommand = () => closeLayer().commands.find((command) => command.bind === "escape,ctrl+c")!;
  const lastNavigation = () => navigations[navigations.length - 1];
  let route: unknown = { type: "session", sessionID: "root" };
  let claim: SlotClaim<"sidebar.content">;
  const context = {
    client,
    location: { directory: "/" },
    data: { on: () => () => undefined },
    ui: {
      slot(value: SlotClaim<"sidebar.content"> & { append?: string }) {
        if ((value as { append?: string }).append === "prompt.footer.status") return () => undefined;
        claim = value;
        return () => undefined;
      },
      router: {
        register(page: { name: string; render: (input: { data?: Record<string, unknown> }) => unknown }) {
          pages.push(page);
          return () => undefined;
        },
        navigate(destination: unknown) {
          navigations.push(destination);
          route = destination;
        },
        current() { return route; },
      },
    },
    keymap: {
      layer(factory: () => (typeof layers)[number]) { layers.push(factory()); },
      mode: {
        current: () => "base",
        push: (mode: string) => { modes.push(mode); return () => undefined; },
      },
    },
    theme: {
      text: { base: color, muted, feedback: { info: { base: muted }, warning: { base: muted }, error: { base: muted } } },
      border: { base: muted },
    },
  } as unknown as Context;

  const sidebar = await testRender(() => {
    plugin.setup(context);
    return claim.render({ sessionID: "root" });
  }, { width: 72, height: 20 });
  try {
    await sidebar.waitForFrame((frame) => frame.includes("3 turns"));
  } finally {
    await sidebar.dispose();
  }
  expect(pages).toHaveLength(1);
  const requestsAfterLoad = { ...requests };

  const open = layers[0]!.commands[1]!;
  expect(open.id).toBe("session.usage.page");
  const close = closeCommand();
  expect(close.id).toBeUndefined();
  expect(close.bind).toBe("escape,ctrl+c");
  expect(closeLayer().enabled!()).toBe(false);

  open.run!();
  expect(navigations[0]).toEqual({
    type: "plugin",
    name: "session-usage-details",
    data: { sessionID: "root", returnRoute: { type: "session", sessionID: "root" } },
  });
  expect(requests).toEqual(requestsAfterLoad);

  // The sidebar stays on screen while the page is open, so opening it again must keep the original
  // return target instead of capturing the page as the place to go back to.
  open.run!();
  expect((navigations[1] as { data: { returnRoute: unknown } }).data.returnRoute).toEqual({
    type: "session",
    sessionID: "root",
  });
  expect(requests).toEqual(requestsAfterLoad);

  const pageRoute = navigations[1] as { data: Record<string, unknown> };
  const view = await testRender(() => pages[0]!.render({ data: pageRoute.data }), { width: 90, height: 44 });
  try {
    await view.waitForFrame((frame) => frame.includes("Session Details"));
    const page = view.captureCharFrame();
    expect(page).toContain("Tokens");
    expect(page).toContain("Cost");
    expect(page).toContain("Activity");
    expect(page).toContain("Timing");
    expect(page).toContain("esc back");
    expect(page).toContain("↑ in");
    expect(page).toContain("ø cache hit rate");
    expect(page).toContain("▣ tools");
    expect(page).toContain("≡ files");
    expect(page).toContain("└ subagents");
    expect(page).toContain("Models");
    expect(page).toContain("Subagents");
    expect(page).toContain("Agents");
    expect(page).toContain("bash");
    expect(page).toContain("steps ·");
    expect(page).toContain("→ slowest");
    expect(page).toContain("× last error");
    expect(page).toContain("429 too many requests");
    expect(page).toContain("C:\\repo\\app · fork of ses_parent · interrupted");
    expect(page).toContain("↻ retries");
    expect(page).toContain("3× max · 529 overloaded");
    expect(page).toContain("3 levels");
    expect(page).toContain("explore · succeeded · 1m · 66 · $1.00");
    expect(page).toContain("ø 8.9%");
    expect(page).toContain("$1.50");

    const toolsRow = page.split("\n").find((line) => line.includes("▣ tools"))!;
    expect(toolsRow).toContain("4s");

    const inRow = page.split("\n").find((line) => line.includes("↑ in"))!;
    expect(inRow.indexOf("150")).toBeGreaterThanOrEqual(70);
    expect(modes).toEqual([]);
    expect(requests).toEqual(requestsAfterLoad);
    expect(closeLayer().enabled!()).toBe(true);

    close.run!();
    expect(lastNavigation()).toEqual({ type: "session", sessionID: "root" });
    expect(requests).toEqual(requestsAfterLoad);
  } finally {
    await view.dispose();
  }
  expect(closeLayer().enabled!()).toBe(false);

  // Without a captured return route the page must still land on the session it shows, never on a
  // fresh one.
  context.ui.router.navigate({ type: "plugin", name: "session-usage-details", data: { sessionID: "root" } });
  const bare = await testRender(() => pages[0]!.render({ data: { sessionID: "root" } }), {
    width: 90,
    height: 44,
  });
  try {
    await bare.waitForFrame((frame) => frame.includes("Session Details"));
    close.run!();
    expect(lastNavigation()).toEqual({ type: "session", sessionID: "root" });
    expect(requests).toEqual(requestsAfterLoad);
  } finally {
    await bare.dispose();
  }
});

test("details page hides a section heading when none of its rows have a value", async () => {
  const root = session("root");
  root.cost = 0;
  const turn = assistant("root-turn");
  turn.cost = 0;
  const client = {
    session: {
      get: async () => root,
      list: async () => ({ data: [], cursor: {} }),
    },
    message: {
      list: async () => ({ data: [turn], cursor: {} }),
    },
    model: {
      list: async () => ({ data: [], location: { directory: "/" } }),
    },
  } as unknown as OpenCodeClient;

  const color = RGBA.fromHex("#c6d0f5");
  const pages: Array<{ name: string; render: (input: { data?: Record<string, unknown> }) => any }> = [];
  let claim: SlotClaim<"sidebar.content">;
  const context = {
    client,
    location: { directory: "/" },
    data: { on: () => () => undefined },
    ui: {
      slot(value: SlotClaim<"sidebar.content"> & { append?: string }) {
        if ((value as { append?: string }).append === "prompt.footer.status") return () => undefined;
        claim = value;
        return () => undefined;
      },
      router: {
        register(page: { name: string; render: (input: { data?: Record<string, unknown> }) => unknown }) {
          pages.push(page);
          return () => undefined;
        },
        navigate: () => undefined,
        current: () => ({ type: "session", sessionID: "root" }),
      },
    },
    keymap: { layer: () => undefined, mode: { current: () => "base", push: () => () => undefined } },
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: { info: { base: color }, warning: { base: color }, error: { base: color } },
      },
      border: { base: color },
    },
  } as unknown as Context;

  const sidebar = await testRender(() => {
    plugin.setup(context);
    return claim.render({ sessionID: "root" });
  }, { width: 72, height: 20 });
  try {
    await sidebar.waitForFrame((frame) => frame.includes("1 turn"));
    expect(sidebar.captureCharFrame()).not.toContain("$ cost");
  } finally {
    await sidebar.dispose();
  }

  const view = await testRender(() => pages[0]!.render({ data: { sessionID: "root" } }), {
    width: 90,
    height: 30,
  });
  try {
    await view.waitForFrame((frame) => frame.includes("Session Details"));
    const page = view.captureCharFrame();
    expect(page).not.toContain("Cost");
    expect(page).not.toContain("Activity");
    expect(page).toContain("Tokens");
    expect(page).toContain("↺ initiated");
  } finally {
    await view.dispose();
  }
});

test("clicking esc back navigates back without extra requests", async () => {
  const root = session("root");
  const turn = assistant("root-turn");
  const requests = { sessionGet: 0, messageList: 0 };
  const client = {
    session: {
      get: async () => { requests.sessionGet += 1; return root; },
      list: async () => ({ data: [], cursor: {} }),
    },
    message: {
      list: async () => { requests.messageList += 1; return { data: [turn], cursor: {} }; },
    },
  } as unknown as OpenCodeClient;

  const color = RGBA.fromHex("#c6d0f5");
  const pages: Array<{ name: string; render: (input: { data?: Record<string, unknown> }) => unknown }> = [];
  const navigations: unknown[] = [];
  let route: unknown = {
    type: "plugin",
    name: "session-usage-details",
    data: { sessionID: "root", returnRoute: { type: "session", sessionID: "root" } },
  };
  const context = {
    client,
    location: { directory: "/" },
    data: { on: () => () => undefined },
    ui: {
      slot: () => () => undefined,
      router: {
        register(page: { name: string; render: (input: { data?: Record<string, unknown> }) => unknown }) {
          pages.push(page);
          return () => undefined;
        },
        navigate(destination: unknown) {
          navigations.push(destination);
          route = destination;
        },
        current() { return route; },
      },
    },
    keymap: { layer: () => undefined, mode: { current: () => "base", push: () => () => undefined } },
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: { info: { base: color }, warning: { base: color }, error: { base: color } },
      },
      border: { base: color },
    },
  } as unknown as Context;

  const cleanup = plugin.setup(context) as () => void;
  try {
    const view = await testRender(
      () => pages[0]!.render({ data: (route as { data: Record<string, unknown> }).data }) as never,
      { width: 90, height: 30 },
    );
    try {
      await view.waitForFrame((frame) => frame.includes("esc back"));
      const lines = view.captureCharFrame().split("\n");
      let clicked = false;
      for (let y = 0; y < lines.length && !clicked; y++) {
        const x = lines[y]!.indexOf("esc back");
        if (x >= 0) {
          // mockMouse takes 0-based cell coordinates.
          await view.mockMouse.click(x, y);
          clicked = true;
        }
      }
      expect(clicked).toBe(true);
      await view.flush();
      expect(navigations).toEqual([{ type: "session", sessionID: "root" }]);
      expect(requests).toEqual({ sessionGet: 0, messageList: 0 });
    } finally {
      await view.dispose();
    }
  } finally {
    cleanup();
  }
});

describe("throughput tracker", () => {
  test("formats rates, TTFT, and GAP like the footer", () => {
    expect(formatRate(NaN)).toBeUndefined();
    expect(formatRate(0)).toBeUndefined();
    expect(formatRate(9.876)).toBe("9.88");
    expect(formatRate(62.44)).toBe("62.4");
    expect(formatRate(123.4)).toBe("123");
    expect(formatTtft(NaN)).toBeUndefined();
    expect(formatTtft(0.86)).toBe("0.9s");
    expect(formatGap(12_300)).toBe("12s");
    expect(formatGap(1_500)).toBe("1.5s");
    expect(estimateStreamTokens("hello world")).toBeGreaterThan(0);
  });

  test("measures active streaming duration across samples", () => {
    expect(activeDurationMs([])).toBe(0);
    expect(activeDurationMs([{ at: 1_000, tokens: 3 }])).toBe(1_000);
    expect(
      activeDurationMs([{ at: 1_000, tokens: 1 }, { at: 1_500, tokens: 1 }], 2_000),
    ).toBe(1_000);
  });

  test("tracks the pause since the last finished action, tool phases included", () => {
    const tracker = createTrackerState();
    const step = (sessionID: string, id: string, at: number) =>
      handleStepStarted(tracker, sessionID, id, at);
    const end = (
      sessionID: string,
      id: string,
      at: number,
      output: number,
      reasoning: number,
      finish = "stop",
    ) => {
      // Seed first-response timing the way streaming deltas would.
      tracker.timingByMessage[id] = {
        sessionID,
        requestStartAt: at - 1_000,
        firstResponseAt: at - 500,
      };
      return handleStepEnded(tracker, sessionID, id, finish, { output, reasoning }, at);
    };

    step("s1", "m1", 1_000);
    const r1 = end("s1", "m1", 5_000, 100, 20);
    expect(r1?.gapMs).toBeNull();

    step("s1", "m2", 20_000);
    const r2 = end("s1", "m2", 26_000, 80, 10);
    expect(r2?.gapMs).toBe(15_000);

    step("s1", "m3", 27_000);
    handleToolCalled(tracker, "s1", "m3", 29_000);
    const r3 = end("s1", "m3", 30_000, 40, 5, "tool-calls");
    expect(r3?.gapMs).toBe(1_000);

    step("s1", "m4", 35_000);
    const r4 = end("s1", "m4", 40_000, 60, 0);
    // The tool-calls completion reset the baseline, so this is the pause
    // since the tool phase finished, not since the last final completion.
    expect(r4?.gapMs).toBe(5_000);

    step("s2", "m5", 100_000);
    const r5 = end("s2", "m5", 105_000, 50, 0);
    expect(r5?.gapMs).toBeNull();

    // Each step start re-measures against the last finished action, so the
    // second step of one message reports the pause since its tool phase.
    step("s2", "m6", 110_000);
    handleToolCalled(tracker, "s2", "m6", 112_000);
    end("s2", "m6", 113_000, 10, 0, "tool-calls");
    step("s2", "m6", 115_000);
    tracker.timingByMessage["m6"] = {
      sessionID: "s2",
      requestStartAt: 114_000,
      firstResponseAt: 114_500,
    };
    const r6 = end("s2", "m6", 118_000, 20, 0);
    expect(r6?.gapMs).toBe(2_000);

    expect(r1?.v).toBe(1);
    expect(r1?.tokensTotal).toBe(120);
    expect(typeof r1?.avgTps).toBe("number");
    expect(sessionAverageRate(tracker, "s1")).toBeDefined();
    expect(sessionTtft(tracker, "s1")).toBeDefined();
    expect(lastGap(tracker, "s1")).toBe("5.0s");
    expect(statusTextFor(tracker, "s1", true)).toContain("GAP 5.0s");
  });

  test("averages over wall-clock step time, not visible streaming time", () => {
    const tracker = createTrackerState();
    // 9s of thinking/queueing with no deltas, then 1000 tokens stream in 1s.
    // Dividing by streaming time alone would report 1000 tok/s.
    handleStepStarted(tracker, "s1", "m1", 0);
    handleTextDelta(tracker, "s1", "m1", "hello world", 9_000);
    handleStepEnded(tracker, "s1", "m1", "stop", { output: 800, reasoning: 200 }, 10_000);
    expect(sessionAverageRate(tracker, "s1")).toBe("100");
  });

  test("ignores redelivered step events instead of counting them again", () => {
    const tracker = createTrackerState();
    // The bus redelivers durable step events (the log shows the same step.ended
    // up to 12 times); every replay must be a no-op.
    handleStepStarted(tracker, "s1", "m1", 0, "evt-start");
    handleTextDelta(tracker, "s1", "m1", "hello world", 500);
    const first = handleStepEnded(tracker, "s1", "m1", "stop", { output: 80, reasoning: 20 }, 2_000, "evt-end");
    expect(first?.tokensTotal).toBe(100);
    handleStepStarted(tracker, "s1", "m1", 0, "evt-start");
    const replay = handleStepEnded(tracker, "s1", "m1", "stop", { output: 80, reasoning: 20 }, 2_000, "evt-end");
    expect(replay).toBeUndefined();
    expect(sessionAverageRate(tracker, "s1")).toBe("50.0");
    // A distinct step still counts.
    handleStepStarted(tracker, "s1", "m2", 3_000, "evt-start-2");
    handleTextDelta(tracker, "s1", "m2", "hello world", 3_500);
    handleStepEnded(tracker, "s1", "m2", "stop", { output: 80, reasoning: 20 }, 5_000, "evt-end-2");
    expect(sessionAverageRate(tracker, "s1")).toBe("50.0");
  });

  test("drops live samples on tool calls and session interrupts", () => {
    const tracker = createTrackerState();
    handleStepStarted(tracker, "s1", "m1", 1_000);
    handleTextDelta(tracker, "s1", "m1", "hello world", 1_200);
    const fresh = liveTps(tracker, "s1", false, 1_300);
    expect(fresh).toBeDefined();
    // Idle or stale reads keep the last observed rate instead of blanking to "-".
    expect(liveTps(tracker, "s1", true, 1_300)).toBe(fresh);
    expect(liveTps(tracker, "s1", false, 60_000)).toBe(fresh);

    handleToolCalled(tracker, "s1", "m1", 1_400);
    expect(tracker.streamSamplesBySession["s1"]).toBeUndefined();
    expect(tracker.liveSamplesDroppedBySession["s1"]).toBe(true);

    handleStepStarted(tracker, "s1", "m2", 2_000);
    dropSession(tracker, "s1");
    expect(tracker.timingByMessage["m2"]).toBeUndefined();

    handleStepFailed(createTrackerState(), "missing");
    expect(pruneSamples(createTrackerState(), 5_000)).toBe(false);
  });

  test("plugin registers the footer slot and cleans it up", async () => {
    const client = clientFor({}, {});
    const handlers = new Map<string, (event: { data: never }) => void>();
    const slots: Array<{ append?: string }> = [];
    let footerRender: ((input: { sessionID?: string }) => unknown) | undefined;
    let footerRemoved = false;
    let sidebarRemoved = false;
    const color = RGBA.fromHex("#c6d0f5");
    const context = {
      client,
      location: { directory: "/" },
      data: {
        on(type: string, handler: (event: { data: never }) => void) {
          handlers.set(type, handler);
          return () => { handlers.delete(type); };
        },
      },
      ui: {
        slot(value: { append?: string; render: (input: { sessionID?: string }) => unknown }) {
          slots.push(value);
          if (value.append === "prompt.footer.status") {
            footerRender = value.render;
            return () => { footerRemoved = true; };
          }
          return () => { sidebarRemoved = true; };
        },
        router: {
          register: () => () => undefined,
          navigate: () => undefined,
          current: () => ({ type: "session", sessionID: "root" }),
        },
      },
      keymap: { layer: () => undefined, mode: { current: () => "base", push: () => () => undefined } },
      theme: {
        text: {
          base: color,
          muted: color,
          feedback: { info: { base: color }, warning: { base: color }, error: { base: color } },
        },
        border: { base: color },
      },
    } as unknown as Context;

    const cleanup = plugin.setup(context) as () => void;
    try {
      expect(slots.map((slot) => slot.append).sort()).toEqual(
        ["prompt.footer.status", "sidebar.content"].sort(),
      );
      for (const type of [
        "session.text.delta",
        "session.reasoning.delta",
        "session.step.started",
        "session.step.ended",
        "session.step.failed",
        "session.tool.called",
        "session.execution.interrupted",
        "session.execution.failed",
      ]) {
        expect(handlers.has(type)).toBe(true);
      }
      const view = await testRender(() => footerRender!({ sessionID: "root" }) as never, {
        width: 60,
        height: 4,
      });
      try {
        await view.waitForFrame((frame) => frame.includes("TPS"));
        expect(view.captureCharFrame()).toContain("TPS - | AVG - | TTFT - | GAP -");
      } finally {
        await view.dispose();
      }
    } finally {
      cleanup();
    }
    expect(footerRemoved).toBe(true);
    expect(sidebarRemoved).toBe(true);
    expect(handlers.size).toBe(0);
  });
});

describe("footer throughput end to end", () => {
  test("GAP populates once a second message starts", async () => {
    const client = clientFor({}, {});
    const handlers = new Map<string, (event: never) => void>();
    let footerRender: ((input: { sessionID?: string }) => unknown) | undefined;
    const color = RGBA.fromHex("#c6d0f5");
    const context = {
      client,
      location: { directory: "/" },
      data: {
        on(type: string, handler: (event: never) => void) {
          handlers.set(type, handler);
          return () => { handlers.delete(type); };
        },
        session: { status: () => "idle" as const },
      },
      ui: {
        slot(value: { append?: string; render: (input: { sessionID?: string }) => unknown }) {
          if (value.append === "prompt.footer.status") footerRender = value.render;
          return () => undefined;
        },
        router: {
          register: () => () => undefined,
          navigate: () => undefined,
          current: () => ({ type: "session", sessionID: "s1" }),
        },
      },
      keymap: { layer: () => undefined, mode: { current: () => "base", push: () => () => undefined } },
      theme: {
        text: {
          base: color,
          muted: color,
          feedback: { info: { base: color }, warning: { base: color }, error: { base: color } },
        },
        border: { base: color },
      },
    } as unknown as Context;

    const cleanup = plugin.setup(context) as () => void;
    try {
      const view = await testRender(() => footerRender!({ sessionID: "s1" }) as never, {
        width: 60,
        height: 4,
      });
      try {
        await view.waitForFrame((frame) => frame.includes("TPS"));
        expect(view.captureCharFrame()).toContain("GAP -");

        const t0 = Date.now() - 20_000;
        const fire = (type: string, created: number, data: Record<string, unknown>) =>
          handlers.get(type)!({ created, data } as never);
        fire("session.step.started", t0, { sessionID: "s1", assistantMessageID: "m1" });
        fire("session.text.delta", t0 + 400, { sessionID: "s1", assistantMessageID: "m1", delta: "hello world" });
        fire("session.step.ended", t0 + 5000, {
          sessionID: "s1",
          assistantMessageID: "m1",
          finish: "stop",
          tokens: { input: 0, output: 100, reasoning: 20, cache: { read: 0, write: 0 } },
        });
        fire("session.step.started", t0 + 20000, { sessionID: "s1", assistantMessageID: "m2" });
        await view.flush();
        // The single stream sample is 20s old, so live TPS is stale by design;
        // AVG/TTFT/GAP derive purely from the event stamps and must be exact.
        // AVG runs on wall-clock step time (request start to finish): 120 tokens
        // over 5s, not over the 4.6s of visible streaming.
        expect(view.captureCharFrame()).toContain("TPS - | AVG 24.0 | TTFT 0.4s | GAP 15s");
      } finally {
        await view.dispose();
      }
    } finally {
      cleanup();
    }
    expect(handlers.size).toBe(0);
  });
});

test("sidebar remounts fresh nodes instead of reusing destroyed ones", async () => {
  // The host destroys detached nodes, so every Show toggle must mount brand-new
  // elements. Reusing the previous instances crashes the slot in the host with
  // "TextBuffer is destroyed" (in tests it only warns on re-add).
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const rootTurn = assistant("root-turn");
    rootTurn.content = [toolCall("t1", "bash", false)];
    const client = clientFor({ root: [session("child")] }, {
      root: [rootTurn],
      child: [assistant("child-turn")],
      other: [assistant("other-turn")],
    });
    const layers: Array<{ commands: Array<{ id: string; run?: () => void }> }> = [];
    const color = RGBA.fromHex("#c6d0f5");
    let claim: SlotClaim<"sidebar.content">;
    let cleanup: (() => void) | undefined;
    let select: (id: string) => void = () => undefined;
    const context = {
      client,
      data: { on: () => () => undefined },
      ui: {
        slot(value: SlotClaim<"sidebar.content"> & { append?: string }) {
          if ((value as { append?: string }).append === "prompt.footer.status") return () => undefined;
          claim = value;
          return () => undefined;
        },
        router: {
          register: () => () => undefined,
          navigate: () => undefined,
          current: () => ({ type: "session", sessionID: "root" }),
        },
      },
      keymap: {
        layer(factory: () => (typeof layers)[number]) {
          layers.push(factory());
        },
        mode: { current: () => "base", push: () => () => undefined },
      },
      theme: {
        text: {
          base: color,
          muted: color,
          feedback: { info: { base: color }, warning: { base: color }, error: { base: color } },
        },
        border: { base: color },
      },
    } as unknown as Context;
    const view = await testRender(() => {
      const [selected, setSelected] = createSignal("root");
      select = setSelected;
      cleanup = plugin.setup(context) as () => void;
      return claim.render({ get sessionID() { return selected(); } });
    }, { width: 60, height: 20 });
    try {
      await view.waitForFrame((frame) => frame.includes("2 turns"));
      const toggle = layers[0]!.commands[0]!;
      expect(toggle.id).toBe("session.usage.details");
      // Expand and collapse so the details subtree mounts, unmounts, and remounts.
      toggle.run!();
      await view.waitForFrame((frame) => frame.includes("▣ tools"));
      toggle.run!();
      await view.waitForFrame((frame) => !frame.includes("▣ tools"));
      toggle.run!();
      await view.waitForFrame((frame) => frame.includes("▣ tools"));
      // Switch sessions with time for detached nodes to be destroyed and the
      // async refresh to land afterwards, the sequence that crashed the host.
      select("other");
      await view.waitForFrame((frame) => frame.includes("1 turn"));
      await Bun.sleep(50);
      await view.flush();
      select("root");
      await view.waitForFrame((frame) => frame.includes("2 turns"));
      await Bun.sleep(50);
      await view.flush();
      expect(view.captureCharFrame()).toContain("Session Token Summary");
      expect(
        warnings.filter((warning) => /already destroyed|skipping (add|remove)|is destroyed/.test(warning)),
      ).toEqual([]);
    } finally {
      cleanup?.();
      await view.dispose();
    }
  } finally {
    console.warn = originalWarn;
  }
});
