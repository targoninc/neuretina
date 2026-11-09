import { describe, expect, test } from "bun:test";
import {
  BRIEFING_STYLE_MAX_LENGTH,
  BRIEFING_STYLE_PRESETS,
  briefingStyleName,
} from "../src/core/briefingStyle.ts";
import type { WorkflowInputSpec } from "../src/core/workflow/definition.ts";
import { WorkflowInputRegistry, type WorkflowInputKind } from "../src/core/workflow/inputs.ts";
import { TopicRepository } from "../src/domain/topics/TopicRepository.ts";
import { SqliteDatabase } from "../src/infra/db/SqliteDatabase.ts";
import { createWorkflowInputs } from "../src/workflows/inputKinds.ts";

const TOPICS_SPEC: WorkflowInputSpec = {
  id: "topics",
  kind: "topics",
  title: "Topics",
  required: true,
  multiple: true,
};

const LANGUAGE_SPEC: WorkflowInputSpec = {
  id: "language",
  kind: "language",
  title: "Language",
  required: false,
  multiple: false,
};

const STYLE_SPEC: WorkflowInputSpec = {
  id: "style",
  kind: "style",
  title: "Style",
  required: false,
  multiple: false,
};

function topicStore(): TopicRepository {
  return new TopicRepository(new SqliteDatabase(":memory:"));
}

describe("workflow input registry", () => {
  test("parses topics: validates ids, dedupes and honors required", () => {
    const topics = topicStore();
    const alpha = topics.add({ name: "Alpha" });
    const inputs = createWorkflowInputs();

    expect(
      inputs.parseInputs([TOPICS_SPEC], { topics: [alpha.id, alpha.id] }, { topics }, {
        requireFilled: true,
      }),
    ).toEqual({ topics: [alpha.id] });

    expect(() =>
      inputs.parseInputs([TOPICS_SPEC], { topics: ["missing"] }, { topics }, {
        requireFilled: true,
      }),
    ).toThrow(/not found/);

    expect(() =>
      inputs.parseInputs([TOPICS_SPEC], {}, { topics }, { requireFilled: true }),
    ).toThrow(/topics/);

    // Creation may defer the required check; updates enforce it.
    expect(inputs.parseInputs([TOPICS_SPEC], {}, { topics }, { requireFilled: false })).toEqual({
      topics: [],
    });
  });

  test("resolves topics to active ones; an empty pin means none", () => {
    const topics = topicStore();
    const alpha = topics.add({ name: "Alpha" });
    const beta = topics.add({ name: "Beta" });
    topics.update(beta.id, { muted: true });
    const inputs = createWorkflowInputs();
    const contextId = "default";

    const all = inputs.resolveContext([TOPICS_SPEC], {}, { topics }, { contextId });
    expect((all.topics as Array<{ id: string }>).map((topic) => topic.id)).toEqual([alpha.id]);

    const none = inputs.resolveContext([TOPICS_SPEC], { topics: [] }, { topics }, { contextId });
    expect(none.topics).toEqual([]);

    const pinned = inputs.resolveContext([TOPICS_SPEC], { topics: [alpha.id] }, { topics }, {
      contextId,
    });
    expect((pinned.topics as Array<{ id: string }>).map((topic) => topic.id)).toEqual([alpha.id]);
  });

  test("parses a language by code or name and rejects unknown ones", () => {
    const topics = topicStore();
    const inputs = createWorkflowInputs();

    expect(
      inputs.parseInputs([LANGUAGE_SPEC], { language: "DE" }, { topics }, { requireFilled: true }),
    ).toEqual({ language: "de" });
    expect(
      inputs.parseInputs([LANGUAGE_SPEC], { language: "German" }, { topics }, {
        requireFilled: true,
      }),
    ).toEqual({ language: "de" });

    // Empty means "use the configured default".
    const empty = inputs.parseInputs([LANGUAGE_SPEC], { language: "" }, { topics }, {
      requireFilled: true,
    });
    expect(empty.language).toBeUndefined();

    expect(() =>
      inputs.parseInputs([LANGUAGE_SPEC], { language: "klingon" }, { topics }, {
        requireFilled: true,
      }),
    ).toThrow(/Unsupported language/);
  });

  test("resolves the language into the run context", () => {
    const topics = topicStore();
    const inputs = createWorkflowInputs();

    expect(
      inputs.resolveContext([LANGUAGE_SPEC], { language: "German" }, { topics }, {
        contextId: "default",
      }),
    ).toEqual({ language: "de" });
    expect(
      inputs.resolveContext([LANGUAGE_SPEC], {}, { topics }, { contextId: "default" }),
    ).toEqual({ language: undefined });
  });

  test("parses a style description: trims, rejects non-strings and caps length", () => {
    const topics = topicStore();
    const inputs = createWorkflowInputs();

    expect(
      inputs.parseInputs([STYLE_SPEC], { style: "  Measured and data-forward.  " }, { topics }, {
        requireFilled: true,
      }),
    ).toEqual({ style: "Measured and data-forward." });

    // Empty means "use the default briefing voice".
    const empty = inputs.parseInputs([STYLE_SPEC], { style: "" }, { topics }, {
      requireFilled: true,
    });
    expect(empty.style).toBeUndefined();

    expect(() =>
      inputs.parseInputs([STYLE_SPEC], { style: 42 }, { topics }, { requireFilled: true }),
    ).toThrow(/must be a string/);
    expect(() =>
      inputs.parseInputs(
        [STYLE_SPEC],
        { style: "x".repeat(BRIEFING_STYLE_MAX_LENGTH + 1) },
        { topics },
        { requireFilled: true },
      ),
    ).toThrow(/at most/);
  });

  test("style presets fit the input limit and match back to their names", () => {
    for (const preset of BRIEFING_STYLE_PRESETS) {
      expect(preset.instruction.length).toBeLessThanOrEqual(BRIEFING_STYLE_MAX_LENGTH);
      expect(briefingStyleName(preset.instruction)).toBe(preset.name);
    }

    expect(briefingStyleName("  Write like a pirate.  ")).toBe("Custom");
    expect(briefingStyleName("")).toBeUndefined();
  });

  test("resolves the style into the run context", () => {
    const topics = topicStore();
    const inputs = createWorkflowInputs();

    expect(
      inputs.resolveContext([STYLE_SPEC], { style: "Write like an analyst." }, { topics }, {
        contextId: "default",
      }),
    ).toEqual({ style: "Write like an analyst." });
    expect(
      inputs.resolveContext([STYLE_SPEC], {}, { topics }, { contextId: "default" }),
    ).toEqual({ style: undefined });
  });

  test("a newly registered context kind flows through parse and resolve", () => {
    const topics = topicStore();
    const inputs = new WorkflowInputRegistry();
    const files: WorkflowInputKind<string[], string[]> = {
      id: "files",
      title: "Files",
      context: true,
      parse: (value) =>
        Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
      resolve: (value) =>
        Array.isArray(value) ? value.map((entry) => `resolved:${String(entry)}`) : [],
    };
    inputs.register(files);

    const spec: WorkflowInputSpec = {
      id: "files",
      kind: "files",
      title: "Files",
      required: false,
      multiple: true,
    };

    expect(
      inputs.parseInputs([spec], { files: ["f1"] }, { topics }, { requireFilled: true }),
    ).toEqual({ files: ["f1"] });
    expect(
      inputs.resolveContext([spec], { files: ["f1"] }, { topics }, { contextId: "default" }),
    ).toEqual({ files: ["resolved:f1"] });
  });

  test("unknown input kinds pass through untouched", () => {
    const topics = topicStore();
    const inputs = new WorkflowInputRegistry();
    const spec: WorkflowInputSpec = {
      id: "custom",
      kind: "custom",
      title: "Custom",
      required: false,
      multiple: false,
    };

    expect(
      inputs.parseInputs([spec], { custom: "value" }, { topics }, { requireFilled: true }),
    ).toEqual({ custom: "value" });
    expect(
      inputs.resolveContext([spec], { custom: "value" }, { topics }, { contextId: "default" }),
    ).toEqual({});
  });
});
