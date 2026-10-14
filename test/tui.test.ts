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
      { name: "bash", calls: 2, failed: 1 },
      { name: "edit", calls: 2, failed: 0 },
    ]);
    expect(details.modelSplit.map((model) => [model.id, model.steps, model.tokens])).toEqual([
      ["gpt-5.2", 1, 137],
      ["model", 1, 12],
    ]);
    expect(details.subagentList).toEqual([
      { id: "child", title: "explore repo", tokens: 66, cost: 1 },
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
  expect(plugin.id).toBe("opencode-session-tokens-sidebar");
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
  const context = {
    client,
    data: {
      on(type: string, handler: (event: { data: { sessionID: string } }) => void) {
        handlers.set(type, handler);
        return () => { handlers.delete(type); };
      },
    },
    ui: {
      slot(value: SlotClaim<"sidebar.content">) {
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
    expect(pageRemoved).toBe(true);
  } finally {
    if (!slotRemoved) cleanup?.();
    await view.dispose();
  }
});

test("details page renders the breakdown and closes without extra requests", async () => {
  const root = session("root");
  const turn = assistant("root-turn");
  turn.content = [toolCall("t1", "bash", false), toolCall("t2", "edit", true)];
  turn.snapshot = { files: ["tui.tsx", "usage.ts"] };
  turn.time = { created: 0, completed: 2_000 };
  const requests = { sessionGet: 0, sessionList: 0, messageList: 0 };
  const client = {
    session: {
      get: async () => { requests.sessionGet += 1; return root; },
      list: async () => { requests.sessionList += 1; return { data: [session("child")], cursor: {} }; },
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
      slot(value: SlotClaim<"sidebar.content">) { claim = value; return () => undefined; },
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
    await sidebar.waitForFrame((frame) => frame.includes("2 turns"));
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
  const view = await testRender(() => pages[0]!.render({ data: pageRoute.data }), { width: 90, height: 34 });
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
    expect(page).toContain("bash");
    expect(page).toContain("steps ·");

    const inRow = page.split("\n").find((line) => line.includes("↑ in"))!;
    expect(inRow.indexOf("100")).toBeGreaterThanOrEqual(70);
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
    height: 34,
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
