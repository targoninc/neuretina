import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agents/Agent.ts";
import type { AgentRunResult } from "../src/agents/Agent.ts";
import type { Tool } from "../src/agents/Tool.ts";
import { addAgentCost, collectFinanceUsage, countWebSearches } from "../src/core/cost/agentCosts.ts";
import { CostTracker } from "../src/core/cost/CostTracker.ts";
import { EventBus } from "../src/core/events/EventBus.ts";
import { EventStore } from "../src/core/events/EventStore.ts";
import { StatusHub } from "../src/core/status/StatusHub.ts";
import { WorkflowRegistry } from "../src/core/workflow/Workflow.ts";
import { WorkflowRunner } from "../src/core/workflow/WorkflowRunner.ts";
import { createLogger } from "../src/core/logger.ts";
import { SqliteDatabase } from "../src/infra/db/SqliteDatabase.ts";
import { WorkflowRunRepository } from "../src/domain/runs/WorkflowRunRepository.ts";
import { completion, stubLlm, stubWorkflow } from "./support.ts";

const log = createLogger("test", { level: "error" });

describe("CostTracker", () => {
  test("prices LLM tokens with the provider-reported cost", () => {
    const tracker = new CostTracker();
    tracker.addLlm("Research", { inputTokens: 1000, outputTokens: 2000, costUsd: 0.033 });

    const report = tracker.report();
    expect(report.complete).toBe(true);
    expect(report.totalUsd).toBeCloseTo(0.033, 6);
    expect(report.lines).toEqual([
      {
        step: "Research",
        provider: "llm",
        detail: "1 call · 1,000 in / 2,000 out tokens",
        usd: 0.033,
      },
    ]);
  });

  test("merges usage per step and provider, and marks unreported costs", () => {
    const tracker = new CostTracker();
    tracker.addLlm("Research", { inputTokens: 100, outputTokens: 50 });
    tracker.addLlm("Research", { inputTokens: 20 });
    tracker.addSearch("Research", "perplexity", { requests: 3, unpriced: 3, costUsd: 0 });

    const report = tracker.report();
    expect(report.complete).toBe(false);
    expect(report.totalUsd).toBe(0);

    const llm = report.lines.find((line) => line.provider === "llm");
    expect(llm?.detail).toBe("2 calls · 120 in / 50 out tokens");
    expect(llm?.usd).toBe(0);

    const perplexity = report.lines.find((line) => line.provider === "perplexity");
    expect(perplexity?.detail).toBe("3 searches");
    expect(perplexity?.usd).toBe(0);
  });

  test("uses exact reported cost when the provider gives one", () => {
    const tracker = new CostTracker();
    tracker.addLlm("Research", { inputTokens: 1000, outputTokens: 1000, costUsd: 0.01 });
    tracker.addFinance("Research", "perplexity", {
      lookups: 1,
      unpriced: 0,
      inputTokens: 5000,
      outputTokens: 600,
      costUsd: 0.0042,
    });

    const report = tracker.report();
    expect(report.complete).toBe(true);
    expect(report.totalUsd).toBeCloseTo(0.0142, 6);

    const finance = report.lines.find((line) => line.provider === "perplexity");
    expect(finance?.detail).toBe("1 lookup · 5,000 in / 600 out tokens");
    expect(finance?.usd).toBeCloseTo(0.0042, 6);
  });
});

describe("agent cost collection", () => {
  function agentResult(partial: {
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
    invocations?: Array<{ tool: string; result?: unknown }>;
  }): AgentRunResult {
    return {
      agent: "test",
      text: "",
      durationMs: 0,
      usage: partial.usage ?? {},
      steps: [
        {
          index: 0,
          text: "",
          finishReason: "stop",
          invocations: (partial.invocations ?? []).map((invocation) => ({
            tool: invocation.tool,
            args: {},
            durationMs: 0,
            ...(invocation.result !== undefined ? { result: invocation.result } : {}),
          })),
        },
      ],
    };
  }

  test("counts every paid web search and skips social", () => {
    const result = agentResult({
      invocations: [
        {
          tool: "run_code",
          result: {
            toolCallsByTool: {
              "search.perplexity": 2,
              "search.exa": 2,
              "search.wikipedia": 1,
              "search.news": 3,
              "search.bluesky": 4,
            },
          },
        },
        { tool: "search.perplexity" },
        { tool: "search.news" },
        { tool: "search.bluesky" },
      ],
    });

    expect(countWebSearches(result)).toBe(6);
  });

  test("collects finance usage per provider, including unpriced lookups", () => {
    const result = agentResult({
      invocations: [
        {
          tool: "run_code",
          result: {
            toolCallsByTool: {
              "finance.perplexity": 1,
              "finance.yahoo": 2,
              "search.perplexity": 1,
            },
            toolUsages: [
              { tool: "finance.perplexity", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } },
              { tool: "search.perplexity", usage: { costUsd: 0.005 } },
            ],
          },
        },
        { tool: "finance.perplexity", result: { usage: { costUsd: 0.002 } } },
        { tool: "search.perplexity", result: { usage: { costUsd: 0.005 } } },
      ],
    });

    expect(collectFinanceUsage(result)).toEqual([
      {
        provider: "perplexity",
        lookups: 2,
        unpriced: 0,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.003,
      },
      { provider: "yahoo", lookups: 2, unpriced: 2, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ]);
  });

  test("tracks each web provider on its own line and skips social", () => {
    const tracker = new CostTracker();
    const result = agentResult({
      usage: { costUsd: 0.01 },
      invocations: [
        {
          tool: "run_code",
          result: {
            toolCallsByTool: {
              "search.perplexity": 1,
              "search.exa": 2,
              "search.news": 3,
              "search.bluesky": 3,
            },
            toolUsages: [{ tool: "search.perplexity", usage: { costUsd: 0.005 } }],
          },
        },
      ],
    });

    addAgentCost(tracker, "Research", result);
    const report = tracker.report();
    const perplexity = report.lines.find((line) => line.provider === "perplexity");
    expect(perplexity?.detail).toBe("1 search");
    expect(perplexity?.usd).toBeCloseTo(0.005, 6);

    const exa = report.lines.find((line) => line.provider === "exa");
    expect(exa?.detail).toBe("2 searches");
    expect(exa?.usd).toBe(0);

    expect(report.lines.some((line) => line.provider === "bluesky")).toBe(false);
    expect(report.lines.some((line) => line.provider === "news")).toBe(false);
    // Exa reports no cost, so the report cannot be complete.
    expect(report.complete).toBe(false);
  });

  test("prefers the response provider when a direct call reports one", () => {
    const tracker = new CostTracker();
    const result = agentResult({
      usage: { costUsd: 0.01 },
      invocations: [
        {
          tool: "search.wikipedia",
          result: { provider: "perplexity", usage: { costUsd: 0.004 } },
        },
      ],
    });

    addAgentCost(tracker, "Research", result);
    const line = tracker.report().lines.find((entry) => entry.provider === "perplexity");
    expect(line?.detail).toBe("1 search");
    expect(line?.usd).toBeCloseTo(0.004, 6);
  });

  test("prices searches when the provider reports a cost", () => {
    const tracker = new CostTracker();
    const result = agentResult({
      usage: { costUsd: 0.01 },
      invocations: [
        {
          tool: "run_code",
          result: {
            toolCallsByTool: { "search.perplexity": 2 },
            toolUsages: [{ tool: "search.perplexity", usage: { costUsd: 0.005 } }],
          },
        },
      ],
    });

    addAgentCost(tracker, "Research", result);
    const report = tracker.report();
    const search = report.lines.find((line) => line.provider === "perplexity");
    expect(search?.detail).toBe("2 searches");
    expect(search?.usd).toBeCloseTo(0.005, 6);
    // The second search came back without a reported cost.
    expect(report.complete).toBe(false);
  });

  test("records an agent run into the tracker", () => {
    const tracker = new CostTracker();
    const result = agentResult({
      usage: { inputTokens: 2_000, outputTokens: 100 },
      invocations: [
        { tool: "run_code", result: { toolCallsByTool: { "search.perplexity": 2 } } },
      ],
    });

    addAgentCost(tracker, "Research", result);
    const report = tracker.report();
    const llm = report.lines.find((line) => line.provider === "llm");
    expect(llm?.usd).toBe(0);
    expect(report.totalUsd).toBe(0);
    // The provider did not report a cost, so the report is incomplete.
    expect(report.complete).toBe(false);
  });

  test("WorkflowRunner stores the cost report on the run", async () => {
    const db = new SqliteDatabase(":memory:");
    const bus = new EventBus(new EventStore(db), log);
    const statuses = new StatusHub();
    const workflows = new WorkflowRegistry({ bus, logger: log, statuses });
    workflows.register(
      stubWorkflow({
        id: "metered",
        description: "test workflow",
        run: async (_input, context) => {
          context.cost?.addLlm("Step one", { inputTokens: 100, outputTokens: 50 });
          return { ok: true };
        },
      }),
    );

    const runs = new WorkflowRunRepository(db);
    const runner = new WorkflowRunner({
      workflows,
      runs,
      bus,
      logger: log,
      statuses,
    });

    const finished = await runner.start({ workflow: "metered", trigger: "manual" });
    expect(finished.cost).toEqual({
      totalUsd: 0,
      complete: false,
      lines: [
        {
          step: "Step one",
          provider: "llm",
          detail: "1 call · 100 in / 50 out tokens",
          usd: 0,
        },
      ],
    });
    expect(runs.get(finished.id).cost).toEqual(finished.cost);
  });

  test("Agent sums usage across its completions", async () => {
    const bus = new EventBus(new EventStore(new SqliteDatabase(":memory:")), log);
    const echo: Tool = {
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    };
    let calls = 0;
    const agent = new Agent({
      name: "metered",
      systemPrompt: "test",
      llm: stubLlm(() => {
        calls += 1;
        return calls === 1
          ? completion("", [{ id: "t1", name: "echo", arguments: {} }], {
              inputTokens: 100,
              outputTokens: 10,
            })
          : completion("done", [], { inputTokens: 200, outputTokens: 20, costUsd: 0.003 });
      }),
      tools: [echo],
      maxSteps: 3,
    });

    const result = await agent.run("hi", { correlationId: "c1", bus, logger: log });
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 30, costUsd: 0.003 });
  });
});
