import { describe, expect, test } from "bun:test";
import { BriefingWorkflow, type BriefingProgress } from "../src/workflows/BriefingWorkflow.ts";
import { createWorkflowInputs } from "../src/workflows/inputKinds.ts";
import { ArtifactRepository } from "../src/domain/artifacts/ArtifactRepository.ts";
import { ReportRepository } from "../src/domain/reports/ReportRepository.ts";
import { TopicRepository } from "../src/domain/topics/TopicRepository.ts";
import { DeliveryRepository } from "../src/domain/delivery/DeliveryRepository.ts";
import { EventRepository } from "../src/domain/events/EventRepository.ts";
import { DeliveryService } from "../src/delivery/DeliveryService.ts";
import { SqliteDatabase } from "../src/infra/db/SqliteDatabase.ts";
import { EventBus } from "../src/core/events/EventBus.ts";
import { EventStore } from "../src/core/events/EventStore.ts";
import { CostTracker } from "../src/core/cost/CostTracker.ts";
import { StatusHub } from "../src/core/status/StatusHub.ts";
import { createLogger } from "../src/core/logger.ts";
import type { DomainEvent } from "../src/core/events/types.ts";
import type { WorkflowRun } from "../src/domain/runs/WorkflowRunRepository.ts";
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
} from "../src/capabilities/llm/LlmProvider.ts";
import {
  StubChannelSender,
  StubTts,
  completion,
  sampleResults,
  stubFinance,
  stubLlm,
  stubSearch,
  waitUntil,
} from "./support.ts";

const log = createLogger("test", { level: "error" });

interface SetupOptions {
  webResults?: typeof sampleResults;
  socialResults?: typeof sampleResults;
  financeResults?: typeof sampleResults;
  /** Verdict the research agent reports for its final JSON answer. */
  researchVerdict?: boolean;
  /** The stub researcher reports found=true with empty notes. */
  emptyNotes?: boolean;
  /** Makes the first compiler call return a draft far over the word budget. */
  longCompilerOutput?: boolean;
  /** The stub compiler returns an empty markdown document. */
  emptyCompilerOutput?: boolean;
  /** The stub researcher's program calls only the finance lookup. */
  financeOnly?: boolean;
  /** Enable the follow-up planner/subagents. */
  followups?: boolean;
  /** The stub planner reports nothing worth digging into. */
  noFollowupTasks?: boolean;
  /** The primary-source pass returns these upgrades (and optionally a revision). */
  sourceUpgrades?: {
    markdown?: string;
    upgrades: Array<{ for: number; title: string; url: string }>;
  };
  /** Every stub completion reports this usage (for cost tracking tests). */
  llmUsage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** Enable event extraction and the timeline step. */
  events?: boolean;
  /** The event suggestion call waits until speech generation has started. */
  eventsWaitForTts?: boolean;
}

function setup(options: SetupOptions = {}) {
  const db = new SqliteDatabase(":memory:");
  const bus = new EventBus(new EventStore(db), log);
  const topics = new TopicRepository(db);
  const artifacts = new ArtifactRepository(db);
  const reports = new ReportRepository(artifacts);
  const events = new EventRepository(db);
  const compilerInputs: string[] = [];
  const dispatcherInputs: string[] = [];
  const llmRequests: LlmCompletionRequest[] = [];
  let compilerCalls = 0;

  const respond = async (request: LlmCompletionRequest): Promise<LlmCompletionResult> => {
    const system = request.messages[0]?.content ?? "";

    if (system.includes("extract dated events")) {
      if (options.eventsWaitForTts) {
        // Fails when event extraction does not overlap speech generation.
        await waitUntil(() => tts.requests.length > 0, 2000);
      }
      return completion(
        JSON.stringify({
          events: [
            {
              date: "2026-09-30",
              title: "Rust 1.90 released",
              description: "The Rust team shipped 1.90 with faster builds.",
              entities: ["Rust", "Rust Foundation"],
            },
          ],
        }),
      );
    }

    if (system.includes("strict categorizer")) {
      return completion(
        JSON.stringify({ tags: [{ tag: "other", confidence: 0.9 }] }),
      );
    }

    if (system.includes("Invent ONE short")) {
      return completion(JSON.stringify({ tag: "developer-tools" }));
    }

    if (system.includes("source upgrades")) {
      return completion(
        JSON.stringify(options.sourceUpgrades ?? { markdown: "", upgrades: [] }),
      );
    }

    if (system.includes("editor")) {
      compilerCalls += 1;
      compilerInputs.push(request.messages[1]?.content ?? "");
      if (options.emptyCompilerOutput) {
        return completion(JSON.stringify({ markdown: "" }));
      }
      if (options.longCompilerOutput && compilerCalls === 1) {
        const filler = Array.from({ length: 200 }, (_, index) => `longfact${index}`).join(" ");
        return completion(JSON.stringify({ markdown: `# Morning report\n\n${filler}` }));
      }
      return completion(
        JSON.stringify({
          markdown: "# Morning report\n\n## Rust\nAll quiet.\n\n## AI regulation\nHeated debate.",
        }),
      );
    }

    if (system.includes("follow-up investigations")) {
      dispatcherInputs.push(request.messages[1]?.content ?? "");
      return completion(
        JSON.stringify({
          tasks:
            options.followups && !options.noFollowupTasks
              ? [{ question: "What are the implications for Rust?" }]
              : [],
        }),
      );
    }

    if (system.includes("one specific follow-up question")) {
      const toolMessages = request.messages.filter((message) => message.role === "tool").length;
      if (toolMessages === 0) {
        return completion("", [
          {
            id: "followup-1",
            name: "run_code",
            arguments: {
              code: `async () => {
                const [wiki, web] = await Promise.all([
                  search.wikipedia({ query: "Rust" }),
                  search.perplexity({ query: "Rust implications" }),
                ]);
                return { wiki: wiki.results.length, web: web.results.length };
              }`,
            },
          },
        ]);
      }
      return completion(
        JSON.stringify({
          found: true,
          notes: "Implications: Rust adoption is accelerating https://example.com/article",
        }),
      );
    }

    if (system.includes("Implications")) {
      return completion(
        JSON.stringify({ markdown: "Rust adoption keeps accelerating [1]." }),
      );
    }

    const toolMessages = request.messages.filter((message) => message.role === "tool").length;
    if (toolMessages === 0) {
      const code = options.financeOnly
        ? `async () => {
            const quote = await finance.perplexity({ question: "NVDA quote" });
            return { finance: quote.answer };
          }`
        : `async () => {
            const [web, social] = await Promise.all([
              search.perplexity({ query: "t" }),
              search.bluesky({ query: "t" }),
            ]);
            return { web: web.results.length, social: social.results.length };
          }`;
      return completion("", [{ id: "call-1", name: "run_code", arguments: { code } }]);
    }
    return completion(
      JSON.stringify({
        found: options.researchVerdict ?? true,
        notes: options.emptyNotes
          ? ""
          : "Notes: something happened https://example.com/article",
      }),
    );
  };

  const llm = stubLlm(async (request) => {
    llmRequests.push(request);
    const result = await respond(request);
    if (!options.llmUsage) return result;
    return { ...result, usage: { ...result.usage, ...options.llmUsage } };
  });

  const statuses = new StatusHub();
  const tts = new StubTts();
  const deliveryStore = new DeliveryRepository(db);
  const sender = new StubChannelSender();
  const delivery = new DeliveryService({
    store: deliveryStore,
    bus,
    logger: log,
    createSender: () => sender,
  });
  // One enabled matrix channel assigned to the briefing's deliverable outputs.
  const briefingChannel = deliveryStore.createChannel({
    type: "matrix",
    name: "Matrix",
    config: {},
  });
  deliveryStore.attach(
    { workflow: "briefing", step: "report", output: "report" },
    briefingChannel.id,
  );
  deliveryStore.attach(
    { workflow: "briefing", step: "audio", output: "tts" },
    briefingChannel.id,
  );

  const workflow = new BriefingWorkflow({
    topics,
    inputKinds: createWorkflowInputs(),
    reports,
    artifacts,
    events,
    llm,
    webSearch: stubSearch("perplexity", "web", options.webResults ?? sampleResults),
    socialSearch: stubSearch("bluesky", "social", options.socialResults ?? [sampleResults[1]!]),
    finance: stubFinance(options.financeResults ?? []),
    tts,
    delivery,
    statuses,
    defaults: {
      recency: "day",
      resultsPerProvider: 5,
      searchDomains: [],
        language: "en",
      },
  });

  return {
    workflow,
    topics,
    reports,
    artifacts,
    events,
    bus,
    tts,
    sender,
    deliveryStore,
    statuses,
    compilerInputs,
    dispatcherInputs,
    llmRequests,
  };
}

describe("BriefingWorkflow", () => {
  test("skips cleanly when no topics are configured", async () => {
    const { workflow, bus, statuses } = setup();
    const events: DomainEvent[] = [];
    bus.subscribe("*", (event) => events.push(event));

    const output = await workflow.run({}, { correlationId: "c1", bus, logger: log, statuses });

    expect(output.skipped).toBe(true);
    expect(events.some((event) => event.topic === "report.skipped")).toBe(true);
  });

  test("researches topics, compiles a report, synthesizes audio and delivers it", async () => {
    const { workflow, topics, reports, bus, tts, sender, deliveryStore, statuses } = setup();
    topics.add({ name: "Rust" });
    topics.add({ name: "AI regulation" });

    const events: DomainEvent[] = [];
    bus.subscribe("*", (event) => events.push(event));

    const output = await workflow.run(
      { deliver: true, generateAudio: true },
      { correlationId: "c2", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(false);
    expect(output.topics).toEqual(["AI regulation", "Rust"]);

    const stored = reports.get(output.reportId!, true);
    expect(stored.markdown).toContain("Morning report");
    expect(stored.sources.length).toBe(2);
    expect(stored.hasAudio).toBe(true);
    expect(stored.audio).toEqual(new Uint8Array([1, 2, 3, 4]));

    // Narration is derived from the summary, so it matches the written report.
    expect(stored.narration).toContain("All quiet");
    expect(stored.narration).not.toContain("http");
    expect(stored.narration).not.toContain("Sources");

    expect(tts.requests).toHaveLength(1);
    expect(tts.requests[0]).toContain("All quiet");
    expect(tts.requests[0]).not.toContain("http");
    expect(tts.requests[0]).not.toContain("Sources");

    // Summary as formatted text (with clickable sources) first, then voice.
    expect(sender.sent).toHaveLength(2);
    const summary = sender.sent[0]!;
    expect(summary.kind).toBe("text");
    expect(summary.text).toContain("# Morning report");
    expect(summary.text).toContain("**Sources**");
    expect(summary.text).toContain("](https://");
    // The spoken narration must not contain the links.
    expect(tts.requests[0]).not.toContain("example.com");
    expect(summary.html).toContain("<h2>Morning report</h2>");
    expect(summary.html).toContain("<h3>Rust</h3>");
    expect(summary.html).toContain('href="https://example.com/article"');
    expect(sender.sent[1]?.kind).toBe("voice");
    expect(sender.sent[1]?.audio).toEqual(new Uint8Array([1, 2, 3, 4]));

    // One recorded delivery row per channel and pass, all settled.
    const rows = deliveryStore.deliveries({ reportId: output.reportId });
    expect(rows.map((row) => `${row.kind}:${row.status}`)).toEqual(["text:sent", "voice:sent"]);

    const topicsEmitted = events.map((event) => event.topic);
    expect(topicsEmitted).toContain("report.research.started");
    expect(topicsEmitted).toContain("report.generated");
    expect(topicsEmitted).toContain("tts.synthesized");
    expect(topicsEmitted).toContain("delivery.status");
    expect(topicsEmitted).toContain("agent.tool.succeeded");

    const deliveryEvents = events.filter((event) => event.topic === "delivery.status");
    const statusesEmitted = deliveryEvents.map(
      (event) =>
        `${(event.payload as { kind: string }).kind}:${(event.payload as { status: string }).status}`,
    );
    expect(statusesEmitted).toContain("text:pending");
    expect(statusesEmitted).toContain("voice:sent");
  });

  test("can generate a report without audio or delivery", async () => {
    const { workflow, topics, reports, tts, sender, statuses } = setup();
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c3", bus: new EventBus(new EventStore(new SqliteDatabase(":memory:")), log), logger: log, statuses },
    );

    expect(output.reportId).toBeTruthy();
    expect(reports.get(output.reportId!).hasAudio).toBe(false);
    expect(tts.requests).toHaveLength(0);
    expect(sender.sent).toHaveLength(0);
  });

  test("falls back to text delivery when speech generation fails", async () => {
    const { workflow, topics, reports, bus, tts, sender, statuses } = setup();
    topics.add({ name: "Rust" });
    tts.failWith = "local TTS returned HTTP 500";

    const output = await workflow.run(
      { deliver: true, generateAudio: true },
      { correlationId: "c6", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(false);
    expect(output.reportId).toBeTruthy();
    expect(output.audioBytes).toBeUndefined();
    expect(reports.get(output.reportId!).hasAudio).toBe(false);

    expect(tts.requests).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.kind).toBe("text");
    expect(sender.sent[0]?.text).toContain("# Morning report");
    expect(sender.sent[0]?.html).toContain("<h2>Morning report</h2>");
  });

  test("sends a text notice instead of a report when nothing was found", async () => {
    const { workflow, topics, reports, bus, tts, sender, statuses } = setup({
      webResults: [],
      socialResults: [],
      researchVerdict: false,
    });
    topics.add({ name: "very obscure topic" });

    const events: DomainEvent[] = [];
    bus.subscribe("*", (event) => events.push(event));

    const output = await workflow.run(
      { deliver: true, generateAudio: true },
      { correlationId: "c4", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(true);
    expect(output.reason).toContain("No material");
    expect(reports.list()).toHaveLength(0);
    expect(tts.requests).toHaveLength(0);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.kind).toBe("text");
    expect(sender.sent[0]?.text).toContain("No report today");
    expect(sender.sent[0]?.text).toContain("very obscure topic");
    expect(sender.sent[0]?.text).toContain('Queries tried: "t"');
    expect(sender.sent[0]?.text).toContain("No summary or audio was generated.");

    const skipEvent = events.find((event) => event.topic === "report.skipped");
    expect(skipEvent?.payload).toMatchObject({ topics: ["very obscure topic"] });
    expect(events.map((event) => event.topic)).not.toContain("report.generated");
    expect(events.map((event) => event.topic)).not.toContain("tts.synthesized");
  });

  test("delivers text only when voice is disabled", async () => {
    const { workflow, topics, reports, bus, tts, sender, statuses } = setup();
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { deliver: true, generateAudio: false },
      { correlationId: "c11", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(false);
    expect(output.audioBytes).toBeUndefined();
    expect(reports.get(output.reportId!).hasAudio).toBe(false);
    expect(tts.requests).toHaveLength(0);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.kind).toBe("text");
  });

  test("compresses an over-long draft before delivering", async () => {
    const { workflow, topics, reports, bus, statuses } = setup({ longCompilerOutput: true });
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c10", bus, logger: log, statuses },
    );

    const stored = reports.get(output.reportId!);
    expect(stored.markdown).toContain("All quiet");
    expect(stored.markdown.split(/\s+/).filter(Boolean).length).toBeLessThan(40);
    expect(stored.narration).toContain("All quiet");
  });

  test("excludes muted topics from briefings", async () => {
    const { workflow, topics, bus, reports, statuses } = setup();
    const active = topics.add({ name: "Rust" });
    const muted = topics.add({ name: "Crypto" });
    topics.update(muted.id, { muted: true });

    const events: DomainEvent[] = [];
    bus.subscribe("*", (event) => events.push(event));

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c7", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(false);
    expect(output.topics).toEqual(["Rust"]);
    expect(reports.latest()?.topics).toEqual(["Rust"]);
    const researchStarted = events.find((event) => event.topic === "report.research.started");
    expect(researchStarted?.payload).toMatchObject({ topics: ["Rust"] });

    // Explicitly requesting a muted topic does not bring it back.
    const explicit = await workflow.run(
      { topics: ["Crypto"], deliver: false, generateAudio: false },
      { correlationId: "c8", bus, logger: log, statuses },
    );
    expect(explicit.skipped).toBe(true);

    // Muting everything produces a clear reason.
    topics.update(active.id, { muted: true });
    const allMuted = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c9", bus, logger: log, statuses },
    );
    expect(allMuted.skipped).toBe(true);
    expect(allMuted.reason).toBe("All topics are muted");
  });

  test("ignores irrelevant search results when the researcher reports found=false", async () => {
    // Perplexity returns *something* even for nonsense queries, so the source
    // count alone cannot detect "nothing meaningful" — the agent's verdict must.
    const { workflow, topics, reports, bus, tts, sender, statuses } = setup({
      researchVerdict: false,
    });
    topics.add({ name: "zzzuq flurble" });

    const events: DomainEvent[] = [];
    bus.subscribe("*", (event) => events.push(event));

    const output = await workflow.run(
      { deliver: true, generateAudio: true },
      { correlationId: "c5", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(true);
    expect(reports.list()).toHaveLength(0);
    expect(tts.requests).toHaveLength(0);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.kind).toBe("text");
    expect(events.map((event) => event.topic)).not.toContain("report.generated");
    expect(events.filter((event) => event.topic === "delivery.status").every(
      (event) => (event.payload as { kind: string }).kind === "text",
    )).toBe(true);

    const researched = events.find((event) => event.topic === "report.research.completed");
    expect(researched?.payload).toMatchObject({ found: false });
  });

  test("keeps bluesky post text and media on the stored sources", async () => {
    const social = [
      {
        title: "Alice (@alice.bsky.social)",
        url: "https://bsky.app/profile/alice.bsky.social/post/rkey1",
        snippet: "Local-first is the future",
        source: "bsky.app",
        media: [
          {
            type: "image" as const,
            thumbUrl: "https://cdn.bsky.app/thumb.jpg",
            fullUrl: "https://cdn.bsky.app/full.jpg",
            alt: "a chart",
            width: 1200,
            height: 675,
          },
        ],
      },
    ];
    const { workflow, topics, reports, bus, statuses } = setup({ socialResults: social });
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c13", bus, logger: log, statuses },
    );

    const stored = reports.get(output.reportId!);
    const source = stored.sources.find((item) => item.url === social[0]!.url);
    expect(source?.snippet).toBe("Local-first is the future");
    expect(source?.media?.[0]).toMatchObject({
      type: "image",
      thumbUrl: "https://cdn.bsky.app/thumb.jpg",
      alt: "a chart",
    });
  });

  test("does not store a report when the researcher returns empty notes", async () => {
    const { workflow, topics, reports, bus, statuses } = setup({ emptyNotes: true });
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c14", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(true);
    expect(reports.list()).toHaveLength(0);
  });

  test("fails instead of storing an empty report when the compiler returns nothing", async () => {
    const { workflow, topics, reports, bus, statuses } = setup({ emptyCompilerOutput: true });
    topics.add({ name: "Rust" });

    await expect(
      workflow.run(
        { deliver: false, generateAudio: false },
        { correlationId: "c15", bus, logger: log, statuses },
      ),
    ).rejects.toThrow(/empty report/);
    expect(reports.list()).toHaveLength(0);
  });

    test("passes the collected sources to the compiler for inline citations", async () => {    const { workflow, topics, bus, statuses, compilerInputs } = setup();
    topics.add({ name: "Rust" });

    await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c16", bus, logger: log, statuses },
    );

    expect(compilerInputs[0]).toContain('"sources"');
    expect(compilerInputs[0]).toContain('"n":1');
    expect(compilerInputs[0]).toContain("Example article");
    expect(compilerInputs[0]).toContain("Another source");
  });

  test("passes the workflow's earlier briefings to the compiler for deduping", async () => {
    const { workflow, topics, bus, statuses, compilerInputs } = setup();
    topics.add({ name: "Rust" });

    await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c-prev-1", bus, logger: log, statuses },
    );
    await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c-prev-2", bus, logger: log, statuses },
    );

    expect(compilerInputs).toHaveLength(2);
    expect(compilerInputs[0]).not.toContain("previousBriefings");
    expect(compilerInputs[1]).toContain("previousBriefings");
    // The first report's markdown is what the second compile dedupes against.
    expect(compilerInputs[1]).toContain("All quiet");
  });

  test("appends the follow-up findings as an Implications section that is also spoken", async () => {
    const { workflow, topics, reports, bus, statuses, compilerInputs, dispatcherInputs } = setup({
      followups: true,
    });
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c17", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(false);
    // The planner saw the first draft...
    expect(dispatcherInputs[0]).toContain("All quiet");
    // ...the main report was not recompiled...
    expect(compilerInputs).toHaveLength(1);
    // ...and the findings were appended and read aloud.
    const stored = reports.get(output.reportId!);
    expect(stored.markdown).toContain("## Implications");
    expect(stored.markdown).toContain("Rust adoption keeps accelerating");
    expect(stored.narration).toContain("Rust adoption keeps accelerating");
    expect(stored.narration).not.toContain("[1]");
  });

  test("skips the second compile when the planner finds nothing worth digging into", async () => {
    const { workflow, topics, bus, statuses, compilerInputs, dispatcherInputs } = setup({
      followups: true,
      noFollowupTasks: true,
    });
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c18", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(false);
    expect(dispatcherInputs).toHaveLength(1);
    expect(compilerInputs).toHaveLength(1);
  });

  test("upgrades secondary coverage to a primary source after the implications pass", async () => {
    const primary = {
      for: 1,
      title: "Rust 1.90 released",
      url: "https://blog.rust-lang.org/2026/09/01/Rust-1.90.html",
    };
    const { workflow, topics, reports, bus, statuses } = setup({
      followups: true,
      sourceUpgrades: {
        markdown:
          "# Morning report\n\n## Rust\nRust 1.90 is out [1].\n\n## Implications\nRust adoption keeps accelerating [1].",
        upgrades: [primary],
      },
    });
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c19", bus, logger: log, statuses },
    );

    const stored = reports.get(output.reportId!);
    expect(stored.sources[0]?.url).toBe(primary.url);
    expect(stored.sources[0]?.title).toBe(primary.title);
    expect(stored.markdown).toContain("Rust 1.90 is out");
    expect(stored.narration).toContain("Rust 1.90 is out");
    expect(stored.narration).not.toContain("[1]");
  });

  test("keeps the draft when the primary-source revision is not acceptable", async () => {
    const { workflow, topics, reports, bus, statuses } = setup({
      followups: true,
      sourceUpgrades: {
        markdown: "# Rewritten\n\nNope.",
        upgrades: [{ for: 1, title: "Official", url: "https://origin.example.com/a" }],
      },
    });
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c20", bus, logger: log, statuses },
    );

    const stored = reports.get(output.reportId!);
    // The upgrade still lands, but the mangled rewrite is rejected.
    expect(stored.sources[0]?.url).toBe("https://origin.example.com/a");
    expect(stored.markdown).toContain("All quiet");
    expect(stored.markdown).not.toContain("Completely different");
  });

  test("meters LLM and Perplexity usage per workflow step", async () => {
    const { workflow, topics, bus, statuses } = setup({
      llmUsage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.01 },
    });
    topics.add({ name: "Rust" });

    const cost = new CostTracker();
    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c21", bus, logger: log, statuses, cost },
    );

    expect(output.skipped).toBe(false);
    const report = cost.report();

    const search = report.lines.find(
      (line) => line.step === "Research" && line.provider === "perplexity",
    );
    expect(search?.detail).toBe("1 search");
    expect(search?.usd).toBe(0);

    const researchLlm = report.lines.find(
      (line) => line.step === "Research" && line.provider === "llm",
    );
    expect(researchLlm?.detail).toBe("2 calls · 2,000 in / 1,000 out tokens");

    const compilation = report.lines.find((line) => line.step === "Compilation");
    expect(compilation?.usd).toBeCloseTo(0.01, 6);

    // Search requests carry no provider-reported price, so the report is
    // marked incomplete even though every LLM call reported its cost.
    expect(report.complete).toBe(false);
    expect(report.totalUsd).toBeGreaterThan(0);
  });

  test("collects finance lookup sources alongside search results", async () => {
    const financeResults = [
      {
        title: "NVDA quote",
        url: "https://www.perplexity.ai/finance/NVDA",
        snippet: "NVDA quote",
        source: "www.perplexity.ai",
      },
    ];
    const { workflow, topics, reports, bus, statuses } = setup({
      financeOnly: true,
      financeResults,
    });
    topics.add({ name: "Nvidia" });

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c12", bus, logger: log, statuses },
    );

    const stored = reports.get(output.reportId!);
    const source = stored.sources.find(
      (item) => item.url === "https://www.perplexity.ai/finance/NVDA",
    );
    expect(source).toBeDefined();
    expect(source?.provider).toBe("perplexity");
  });

  test("resumes from checkpointed progress without re-running research or the compiler", async () => {
    const { workflow, topics, reports, bus, tts, sender, statuses, llmRequests } = setup();
    topics.add({ name: "Rust" });

    const events: DomainEvent[] = [];
    bus.subscribe("*", (event) => events.push(event));

    const checkpoints: BriefingProgress[] = [];
    const progress: BriefingProgress = {
      research: {
        notes: "Notes: something happened https://example.com/article",
        sources: [
          { title: "Example article", url: "https://example.com/article", provider: "perplexity" },
          { title: "Another source", url: "https://news.example.org/story", provider: "perplexity" },
        ],
        queries: ["t"],
        missingTopics: [],
      },
      compiled: {
        markdown: "# Morning report\n\n## Rust\nAll quiet.",
        narration: "Morning report. Rust. All quiet.",
      },
    };

    const output = await workflow.run(
      { deliver: true, generateAudio: true },
      {
        correlationId: "c22",
        bus,
        logger: log,
        statuses,
        resume: progress,
        checkpoint: (data) => checkpoints.push(data as BriefingProgress),
      },
    );

    expect(output.skipped).toBe(false);
    // Neither the research agent nor the compiler ran again; only the steps
    // that had not checkpointed yet (follow-ups, event extraction) did.
    const systems = llmRequests.map((request) => request.messages[0]?.content ?? "");
    expect(systems.some((system) => system.includes("editor"))).toBe(false);
    expect(
      systems.some((system) => system.includes("calls the search and finance functions")),
    ).toBe(false);
    expect(events.map((event) => event.topic)).not.toContain("report.research.started");
    expect(events.map((event) => event.topic)).not.toContain("report.research.completed");

    // The report is still stored, narrated and delivered.
    const stored = reports.get(output.reportId!, true);
    expect(stored.markdown).toContain("All quiet");
    expect(stored.sources).toHaveLength(2);
    expect(stored.hasAudio).toBe(true);
    expect(stored.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(tts.requests).toHaveLength(1);
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1]?.kind).toBe("voice");

    expect(checkpoints.at(-1)).toMatchObject({
      steps: { report: { report: { reference: output.reportId } } },
      delivered: { "report:report": true, "audio:tts": true },
    });
  });

  test("reuses stored audio when resuming a run whose report already has it", async () => {
    const { workflow, topics, reports, bus, tts, sender, statuses } = setup();
    topics.add({ name: "Rust" });

    const research = {
      notes: "Notes: something happened https://example.com/article",
      sources: [
        { title: "Example article", url: "https://example.com/article", provider: "perplexity" },
      ],
      queries: ["t"],
      missingTopics: [],
    };
    const compiled = {
      markdown: "# Morning report\n\n## Rust\nAll quiet.",
      narration: "Morning report. Rust. All quiet.",
    };

    // The first attempt stores the report and its audio before being
    // interrupted ahead of delivery.
    const first = await workflow.run(
      { deliver: false, generateAudio: true },
      { correlationId: "c23", bus, logger: log, statuses, resume: { research, compiled } },
    );
    expect(reports.get(first.reportId!, true).hasAudio).toBe(true);
    expect(tts.requests).toHaveLength(1);

    const second = await workflow.run(
      { deliver: true, generateAudio: true },
      {
        correlationId: "c23",
        bus,
        logger: log,
        statuses,
        resume: { research, compiled, reportId: first.reportId },
      },
    );

    expect(second.reportId).toBe(first.reportId);
    // No second synthesis; the stored audio was reused for the voice message.
    expect(tts.requests).toHaveLength(1);
    expect(sender.sent).toHaveLength(2);
    const voice = sender.sent[1]!;
    expect(voice.kind).toBe("voice");
    expect(voice.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(voice.mimeType).toBe("audio/ogg");
  });

  test("honors topicIds: only the selected topic ids are briefed", async () => {
    const { workflow, topics, reports, bus, statuses } = setup();
    topics.add({ name: "Rust" });
    const crypto = topics.add({ name: "Crypto" });
    const regulation = topics.add({ name: "AI regulation" });

    const output = await workflow.run(
      { topicIds: [crypto.id, regulation.id], topics: ["Rust"], deliver: false, generateAudio: false },
      { correlationId: "c24", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(false);
    // The ids win over the requested names; the order follows the active topics.
    expect(output.topics).toEqual(["AI regulation", "Crypto"]);
    expect(reports.latest()?.topics).toEqual(["AI regulation", "Crypto"]);
  });

  test("an empty topicIds array skips the briefing with the no-topics reason", async () => {
    const { workflow, topics, reports, bus, statuses } = setup();
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { topicIds: [], deliver: false, generateAudio: false },
      { correlationId: "c25", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(true);
    expect(output.reason).toBe("No topics configured");
    expect(reports.list()).toHaveLength(0);
  });

  test("delivers through the channels of the workflow being run", async () => {
    const { workflow, topics, reports, bus, statuses, deliveryStore } = setup();
    topics.add({ name: "Rust" });

    const briefingChannel = deliveryStore.attachments().find(
      (attachment) => attachment.workflow === "briefing",
    )!.channelId;
    const userChannel = deliveryStore.createChannel({ type: "matrix", name: "User" }).id;
    deliveryStore.attach(
      { workflow: "user-1", step: "report", output: "report" },
      userChannel,
    );
    deliveryStore.attach(
      { workflow: "user-1", step: "audio", output: "tts" },
      userChannel,
    );

    const run: WorkflowRun = {
      id: "run-user-1",
      workflow: "user-1",
      contextId: "morning-briefing",
      trigger: "manual",
      triggerDetail: {},
      status: "running",
      input: {},
      startedAt: Date.now(),
    };

    const output = await workflow.run(
      { deliver: true, generateAudio: false },
      { correlationId: "c26", bus, logger: log, statuses, run },
    );

    const rows = deliveryStore.deliveries({ reportId: output.reportId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channelId).toBe(userChannel);
    expect(rows[0]?.channelId).not.toBe(briefingChannel);

    // The report is attributed to the workflow that was run, so consumers
    // (e.g. the re-send dialog) resolve that workflow's channels.
    expect(reports.get(output.reportId!)?.workflow).toBe("user-1");
  });

  test("extracts events and attaches a timeline artifact to the report", async () => {
    const { workflow, topics, reports, artifacts, events, bus, statuses } = setup({
      events: true,
    });
    topics.add({ name: "Rust" });

    const emitted: DomainEvent[] = [];
    bus.subscribe("*", (event) => emitted.push(event));

    const output = await workflow.run(
      { deliver: false, generateAudio: false },
      { correlationId: "c27", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(false);

    // The extracted event is a row, with the tag invented by the decision step.
    const stored = events.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.title).toBe("Rust 1.90 released");
    expect(stored[0]?.date).toBe("2026-09-30");
    expect(stored[0]?.tags).toEqual(["developer-tools"]);
    expect(stored[0]?.entities).toEqual(["Rust", "Rust Foundation"]);
    expect(stored[0]?.sourceReportId).toBe(output.reportId);

    // The timeline artifact is attached to the report, in display order
    // before the text (audio was disabled for this run).
    const report = reports.get(output.reportId!);
    const timeline = report.artifacts.find((artifact) => artifact.kind === "timeline");
    expect(timeline).toBeTruthy();
    expect(timeline?.parentId).toBe(report.artifactId);
    expect(timeline?.content).toContain("Rust 1.90 released");
    expect(timeline?.metadata.eventIds).toEqual([stored[0]?.id]);
    expect(report.artifacts.map((artifact) => artifact.kind)).toEqual(["timeline", "report-text"]);
    expect(artifacts.get(timeline!.id).kind).toBe("timeline");
    expect(emitted.some((event) => event.topic === "artifact.created")).toBe(true);
  });

  test("delivers the timeline as a monospace code block to its assigned channels", async () => {
    const { workflow, topics, deliveryStore, sender, bus, statuses } = setup({ events: true });
    topics.add({ name: "Rust" });

    const channel = deliveryStore.attachments().find(
      (attachment) => attachment.workflow === "briefing",
    )!.channelId;
    deliveryStore.attach({ workflow: "briefing", step: "timeline", output: "timeline" }, channel);

    const output = await workflow.run(
      { deliver: true, generateAudio: false },
      { correlationId: "c29", bus, logger: log, statuses },
    );

    const timeline = sender.sent.find((entry) => entry.text.startsWith("Timeline ·"));
    expect(timeline).toBeTruthy();
    expect(timeline?.text).toContain("2026-09-30  Rust 1.90 released");
    expect(timeline?.html).toContain("<pre><code>");
    expect(timeline?.html).toContain("Rust 1.90 released");
    expect(timeline?.html).toContain("</code></pre>");

    // The delivery rows are attributed to the report, like the other passes:
    // the report text plus the timeline text.
    const rows = deliveryStore.deliveries({ reportId: output.reportId! });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === "text")).toBe(true);
  });

  test("extracts events concurrently with speech generation", async () => {
    const { workflow, topics, tts, events, bus, statuses } = setup({
      events: true,
      eventsWaitForTts: true,
    });
    topics.add({ name: "Rust" });

    const output = await workflow.run(
      { deliver: false, generateAudio: true },
      { correlationId: "c28", bus, logger: log, statuses },
    );

    expect(output.skipped).toBe(false);
    // The extraction LLM call only resolves because TTS started meanwhile.
    expect(tts.requests).toHaveLength(1);
    expect(events.list()).toHaveLength(1);
  });
});

