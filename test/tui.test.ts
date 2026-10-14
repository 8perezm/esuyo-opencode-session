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
  computeTotals,
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
  const client = clientFor({ root: [session("child")] }, {
    root: [assistant("root-turn")], child: [assistant("child-turn")],
    other: [assistant("other-turn")],
  });
  const handlers = new Map<string, (event: { data: { sessionID: string } }) => void>();
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
  } finally {
    if (!slotRemoved) cleanup?.();
    await view.dispose();
  }
});
