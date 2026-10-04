import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/core/logger.ts";
import { levenshteinDistance, textSimilarity, tokenSimilarity } from "../src/core/text.ts";
import { EventRepository, type TimelineEvent } from "../src/domain/events/EventRepository.ts";
import {
  EventExtractor,
  findCandidates,
  findDuplicatePairs,
  shortenTitle,
} from "../src/workflows/EventExtraction.ts";
import {
  renderTimelineHtml,
  renderTimelineMarkdown,
  renderTimelineText,
  selectTimelineEvents,
} from "../src/workflows/EventTimeline.ts";
import { SqliteDatabase } from "../src/infra/db/SqliteDatabase.ts";
import { completion, stubLlm } from "./support.ts";

const log = createLogger("test", { level: "error" });

describe("EventRepository", () => {
  test("round-trips events with normalized fields and filters", () => {
    const repo = new EventRepository(new SqliteDatabase(":memory:"));

    const first = repo.upsert({
      date: "2026-09-01",
      entities: ["Nvidia", "nvidia"],
      tags: ["Markets", "AI"],
      title: "Nvidia earnings",
      description: "Beat consensus.",
    });
    expect(first.entities).toEqual(["Nvidia"]);
    expect(first.tags).toEqual(["Markets", "AI"]);
    expect(repo.count()).toBe(1);

    const second = repo.upsert({
      date: "2026-09-05",
      entities: ["Rust"],
      tags: ["AI"],
      title: "Rust 1.90",
    });
    // Most used tags first.
    expect(repo.tags()).toEqual(["AI", "Markets"]);

    // Updating keeps the fields that are not passed.
    const updated = repo.upsert({ id: first.id, date: "2026-09-02", title: "Nvidia earnings beat" });
    expect(updated.id).toBe(first.id);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.title).toBe("Nvidia earnings beat");
    expect(updated.entities).toEqual(["Nvidia"]);
    expect(updated.tags).toEqual(["Markets", "AI"]);
    expect(repo.count()).toBe(2);

    expect(repo.list().map((event) => event.title)).toEqual([
      "Rust 1.90",
      "Nvidia earnings beat",
    ]);
    expect(repo.list({ from: "2026-09-03" }).map((event) => event.title)).toEqual(["Rust 1.90"]);
    expect(repo.list({ to: "2026-09-03" }).map((event) => event.title)).toEqual([
      "Nvidia earnings beat",
    ]);
    expect(repo.list({ tags: ["markets"] }).map((event) => event.title)).toEqual([
      "Nvidia earnings beat",
    ]);
    expect(repo.list({ entities: ["rust"] }).map((event) => event.title)).toEqual(["Rust 1.90"]);
    expect(repo.list({ ids: [first.id] })).toHaveLength(1);
    expect(repo.list({ limit: 1 })).toHaveLength(1);

    expect(() => repo.upsert({ date: "yesterday", title: "x" })).toThrow(/YYYY-MM-DD/);
    expect(() => repo.upsert({ date: "2026-09-01", title: "  " })).toThrow(/title/);
    expect(() => repo.get("missing")).toThrow(/not found/);

    const removed = repo.remove(second.id);
    expect(removed.id).toBe(second.id);
    expect(repo.count()).toBe(1);
  });
});

describe("text similarity", () => {
  test("measures edit distance and percentage match", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("same", "same")).toBe(0);
    expect(textSimilarity("Nvidia earnings", "nvidia earnings")).toBe(1);
    expect(textSimilarity("Nvidia earnings", "Nvidia earnings beat")).toBeGreaterThan(0.7);
    expect(textSimilarity("Rust release", "EU AI Act ruling")).toBeLessThan(0.4);
  });

  test("matches on shared content words when the wording differs", () => {
    expect(
      tokenSimilarity(
        "Google launches Gemini 4 Argon",
        "Google launches Gemini 4 Argon frontier model",
      ),
    ).toBe(1);
    expect(
      tokenSimilarity(
        "Google challenges EU DMA orders in court",
        "Google appeals two EU Digital Markets Act orders",
      ),
    ).toBeGreaterThan(0.45);
    // camelCase folds into its parts: DevDay matches "Dev Day".
    expect(
      tokenSimilarity(
        "OpenAI unveils Decisions API at Dev Day",
        "OpenAI DevDay: Dots agents, GPT-6.1 Sol and a Pro 500 tier",
      ),
    ).toBeGreaterThan(0.5);
    // One shared generic word is not enough.
    expect(
      tokenSimilarity("OpenAI unveils Decisions API at Dev Day", "Nvidia ships containment software"),
    ).toBe(0);
    expect(tokenSimilarity("Rust release", "EU AI Act ruling")).toBe(0);
  });
});

describe("duplicate matching", () => {
  test("flags rewordings, merged details and cross-day repeats", () => {
    const stored = [
      event({ id: "argon", date: "2026-09-30", title: "Google launches Gemini 4 Argon" }),
      event({ id: "dma", date: "2026-09-29", title: "Google challenges EU DMA orders in court" }),
      event({
        id: "devday",
        date: "2026-09-29",
        title: "OpenAI DevDay: Dots agents, GPT-6.1 Sol and a Pro 500 tier",
      }),
    ];

    const candidates = (date: string, title: string) =>
      findCandidates({ date, title, entities: [], description: "" }, stored).map(
        (candidate) => candidate.event.id,
      );

    expect(
      candidates(
        "2026-09-30",
        "Google launches Gemini 4 Argon frontier model to select cyber defenders",
      ),
    ).toEqual(["argon"]);
    expect(candidates("2026-09-30", "Google asks EU court to suspend DMA search-data order")).toContain(
      "dma",
    );
    expect(candidates("2026-09-29", "Google appeals two EU Digital Markets Act orders")).toContain(
      "dma",
    );
    // The Dev Day roundup and a single launch from it are sent to review.
    expect(candidates("2026-09-29", "OpenAI unveils Decisions API at Dev Day")).toContain("devday");
    // A different company's news on the same day is not a candidate.
    expect(candidates("2026-09-29", "Nvidia ships containment software")).not.toContain("devday");
  });
});

describe("existing event dedup", () => {
  test("finds reworded duplicates across nearby days", () => {
    const a = event({
      id: "a",
      date: "2026-09-29",
      title: "Google challenges EU DMA orders in court",
    });
    const b = event({
      id: "b",
      date: "2026-09-30",
      title: "Google appeals two EU Digital Markets Act orders",
    });

    const pairs = findDuplicatePairs([a, b]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.keep.id).toBe("a");
    expect(pairs[0]?.drop.id).toBe("b");
  });

  test("merges stored duplicates through the review model", async () => {
    const events = new EventRepository(new SqliteDatabase(":memory:"));
    const older = events.upsert({
      date: "2026-09-29",
      title: "Google challenges EU DMA orders in court",
      description: "Old note.",
      tags: ["regulation"],
      entities: ["Google"],
    });
    const newer = events.upsert({
      date: "2026-09-30",
      title: "Google appeals two EU Digital Markets Act orders",
      description: "Newer detail.",
      tags: ["markets"],
      entities: ["EU"],
    });

    const llm = stubLlm((request) => {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("extract dated events")) {
        return completion(JSON.stringify({ events: [] }));
      }
      if (system.includes("You review a newly suggested event")) {
        return completion(
          JSON.stringify({
            action: "update",
            id: older.id,
            date: "2026-09-29",
            title: "Google appeals DMA orders",
            description: "Merged detail.",
            entities: ["Google", "EU"],
          }),
        );
      }
      return completion("{}");
    });

    const extractor = new EventExtractor({ llm, events, logger: log });
    const result = await extractor.extract({ report: "# Report", sources: [] });

    expect(result.merged).toBe(1);
    expect(events.count()).toBe(1);
    const kept = events.get(older.id);
    expect(kept.title).toBe("Google appeals DMA orders");
    expect(kept.description).toBe("Merged detail.");
    expect(kept.tags).toEqual(["regulation", "markets"]);
    expect(kept.entities).toEqual(["Google", "EU"]);
    expect(() => events.get(newer.id)).toThrow();
  });
});

describe("shortenTitle", () => {
  test("strips dates, markdown and clauses, then caps the length", () => {
    expect(shortenTitle("**2026-09-30: Gemini 4 Argon launches**")).toBe("Gemini 4 Argon launches");
    expect(
      shortenTitle("Google launches Gemini 4 Argon frontier model to select cyber defenders"),
    ).toBe("Google launches Gemini 4 Argon frontier model");
    expect(shortenTitle("Google asks EU court to suspend DMA search-data order")).toBe(
      "Google asks EU court to suspend DMA",
    );
    expect(shortenTitle("Anthropic releases Claude Sonnet 5.5")).toBe(
      "Anthropic releases Claude Sonnet 5.5",
    );
    expect(shortenTitle("OpenAI unveils Decisions API (Dev Day)")).toBe(
      "OpenAI unveils Decisions API",
    );
    expect(shortenTitle("OpenAI DevDay: Dots agents, GPT-6.1 Sol and a Pro 500 tier")).toBe(
      "OpenAI DevDay",
    );
  });
});

describe("EventExtractor", () => {
  test("suggests events, reviews duplicates and grows the tag list", async () => {
    const events = new EventRepository(new SqliteDatabase(":memory:"));
    const existing = events.upsert({
      date: "2026-09-29",
      tags: ["markets"],
      title: "Nvidia earnings",
      description: "Old note.",
    });

    const calls: string[] = [];
    const llm = stubLlm((request) => {
      const system = request.messages[0]?.content ?? "";
      calls.push(system);

      if (system.includes("extract dated events")) {
        return completion(
          JSON.stringify({
            events: [
              {
                date: "2026-09-30",
                title: "Nvidia earnings beat",
                description: "Revenue beat consensus.",
                entities: ["Nvidia"],
              },
              {
                date: "2026-09-30",
                title: "Rust 1.90 released",
                description: "Faster builds.",
                entities: ["Rust"],
              },
            ],
          }),
        );
      }

      if (system.includes("You review a newly suggested event")) {
        return completion(
          JSON.stringify({
            action: "update",
            id: existing.id,
            date: "2026-09-30",
            title: "Nvidia earnings beat",
            description: "Revenue beat consensus and guidance rose.",
            entities: ["Nvidia"],
          }),
        );
      }

      if (system.includes("strict categorizer")) {
        const user = JSON.parse(request.messages[1]?.content ?? "{}") as {
          event?: { title?: string };
        };
        if (user.event?.title === "Rust 1.90 released") {
          return completion(JSON.stringify({ tags: [{ tag: "other", confidence: 0.8 }] }));
        }
        return completion(
          JSON.stringify({
            tags: [
              { tag: "markets", confidence: 0.92 },
              { tag: "not-a-tag", confidence: 0.2 },
            ],
          }),
        );
      }

      if (system.includes("Invent ONE short")) {
        return completion(JSON.stringify({ tag: "Developer Tools" }));
      }

      return completion("{}");
    });

    const extractor = new EventExtractor({ llm, events, logger: log });
    const result = await extractor.extract({ reportId: "report-1", report: "# Report", sources: [] });

    // The first suggestion updated the stored event instead of duplicating it.
    expect(result.events).toHaveLength(2);
    expect(events.count()).toBe(2);
    const updated = events.get(existing.id);
    expect(updated.date).toBe("2026-09-30");
    expect(updated.title).toBe("Nvidia earnings beat");
    expect(updated.description).toContain("guidance rose");
    expect(updated.tags).toEqual(["markets"]);
    expect(updated.sourceReportId).toBe("report-1");

    // The second used "other": the decision step invented a tag, normalized it
    // and it is now part of the shared tag list.
    const rust = result.events.find((event) => event.title === "Rust 1.90 released");
    expect(rust?.tags).toEqual(["developer-tools"]);
    expect(result.newTags).toEqual(["developer-tools"]);
    expect(events.tags()).toContain("developer-tools");

    // suggest + review + categorize ×2 + generate.
    expect(calls).toHaveLength(5);
  });

  test("shortens long suggested titles before storing them", async () => {
    const events = new EventRepository(new SqliteDatabase(":memory:"));
    const llm = stubLlm((request) => {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("extract dated events")) {
        return completion(
          JSON.stringify({
            events: [
              {
                date: "2026-09-30",
                title: "Google launches Gemini 4 Argon frontier model to select cyber defenders",
                description: "A new frontier model.",
                entities: ["Google"],
              },
            ],
          }),
        );
      }
      return completion(JSON.stringify({ tags: [] }));
    });

    const extractor = new EventExtractor({ llm, events, logger: log });
    await extractor.extract({ report: "# Report", sources: [] });

    expect(events.list().map((stored) => stored.title)).toEqual([
      "Google launches Gemini 4 Argon frontier model",
    ]);
  });
});

describe("EventTimeline", () => {
  test("selects related events and renders markdown", () => {
    const anchor = event({ id: "a", date: "2026-09-30", tags: ["ai"], entities: ["OpenAI"] });
    const byEntity = event({ id: "b", date: "2026-01-01", entities: ["OpenAI"] });
    const byTag = event({ id: "c", date: "2026-09-20", tags: ["ai"] });
    const unrelated = event({ id: "d", date: "2026-09-30", tags: ["markets"], entities: ["Nvidia"] });
    const staleTag = event({ id: "e", date: "2025-01-01", tags: ["ai"] });

    const selected = selectTimelineEvents([anchor], [anchor, byEntity, byTag, unrelated, staleTag]);
    expect(selected.map((entry) => entry.id)).toEqual(["a", "c", "b"]);
    expect(selected.some((entry) => entry.id === "d")).toBe(false);
    expect(selected.some((entry) => entry.id === "e")).toBe(false);

    const markdown = renderTimelineMarkdown(selected);
    expect(markdown).toContain("## Timeline");
    expect(markdown).toContain("### 2026-09-30");
    expect(markdown).toContain("**OpenAI launch**");
    expect(markdown).toContain("#ai");
    expect(markdown).toContain("OpenAI");
  });

  test("renders a monospace timeline for chat code blocks", () => {
    const events = [
      event({ id: "b", date: "2026-09-30", title: "Nvidia beats estimates" }),
      event({ id: "a", date: "2026-09-30", title: "Rust 1.90 released" }),
      event({ id: "c", date: "2026-09-20", title: "A very long headline that wraps onto a continuation line because it exceeds the column width of the code block" }),
    ];

    const text = renderTimelineText(events);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Timeline · 3 events · 2026-09-20 → 2026-09-30");
    expect(text).toContain("2026-09-30  Nvidia beats estimates");
    expect(text).toContain("2026-09-30  Rust 1.90 released");
    // Long titles wrap with a hanging indent under the title column.
    expect(lines.some((line) => /^ {12}\S/.test(line))).toBe(true);
    // Every event title survives the wrap.
    for (const entry of events) {
      expect(text.replace(/\s+/g, " ")).toContain(entry.title);
    }

    const html = renderTimelineHtml(text);
    expect(html.startsWith("<pre><code>")).toBe(true);
    expect(html.endsWith("</code></pre>")).toBe(true);
    expect(renderTimelineText([])).toBe("");
  });

  test("caps the delivered timeline and reports the hidden events", () => {
    const events = Array.from({ length: 45 }, (_, index) =>
      event({
        id: `e${index}`,
        date: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
        title: `Event ${index}`,
      }),
    );

    const text = renderTimelineText(events);
    expect(text).toContain("Timeline · 45 events");
    expect(text).toContain("… and 5 more");
  });
});

function event(overrides: Partial<TimelineEvent> & { id: string }): TimelineEvent {
  return {
    date: "2026-09-30",
    entities: [],
    tags: [],
    title: "OpenAI launch",
    description: "Something happened.",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}
