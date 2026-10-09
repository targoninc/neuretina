import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createKernel, type Kernel } from "../src/kernel/Kernel.ts";
import { createLogger } from "../src/core/logger.ts";
import { SqliteDatabase } from "../src/infra/db/SqliteDatabase.ts";
import { UserWorkflowRepository } from "../src/domain/workflows/UserWorkflowRepository.ts";
import { BriefingWorkflow } from "../src/workflows/BriefingWorkflow.ts";
import { UserBriefingWorkflow } from "../src/workflows/UserBriefingWorkflow.ts";
import {
  StubDeliveryService,
  StubTts,
  completion,
  createTestKernel,
  sampleResults,
  stubLlm,
  stubSearch,
  testConfig,
  waitForEvent,
} from "./support.ts";

describe("UserWorkflowRepository", () => {
  test("round-trips user workflow rows", () => {
    const repo = new UserWorkflowRepository(new SqliteDatabase(":memory:"));

    const first = repo.add({ name: "AI desk", inputs: { topics: ["t1"] } });
    const second = repo.add({ name: "Markets", inputs: { topics: ["t2", "t3"] } });

    expect(repo.count()).toBe(2);
    expect(first.id).toBeTruthy();
    expect(repo.get(first.id)).toEqual(first);
    expect(second.inputs).toEqual({ topics: ["t2", "t3"] });
    expect(repo.list().map((workflow) => workflow.name)).toEqual(["AI desk", "Markets"]);
    expect(repo.get("missing")).toBeNull();

    const updated = repo.update(first.id, {
      name: "AI focus",
      inputs: { topics: ["t1", "t9"] },
    });
    expect(updated.name).toBe("AI focus");
    expect(updated.inputs).toEqual({ topics: ["t1", "t9"] });
    expect(updated.createdAt).toBe(first.createdAt);

    const removed = repo.remove(second.id);
    expect(removed.id).toBe(second.id);
    expect(repo.count()).toBe(1);

    expect(() => repo.add({ name: "  ", inputs: {} })).toThrow(/name/);
    expect(() => repo.update("missing", { name: "x" })).toThrow(/not found/);
    expect(() => repo.remove("missing")).toThrow(/not found/);
  });

  test("stores, keeps and clears the stop step", () => {
    const repo = new UserWorkflowRepository(new SqliteDatabase(":memory:"));

    const created = repo.add({
      name: "Stop early",
      inputs: { topics: ["t1"] },
      stopAfter: "report",
    });
    expect(created.stopAfter).toBe("report");
    expect(repo.get(created.id)?.stopAfter).toBe("report");

    // A patch without stopAfter keeps the current value.
    const renamed = repo.update(created.id, { name: "Stop early v2" });
    expect(renamed.stopAfter).toBe("report");

    // An explicit null clears it.
    const cleared = repo.update(created.id, { stopAfter: null });
    expect(cleared.stopAfter).toBeUndefined();

    const upserted = repo.upsert("briefing", {
      name: "Custom",
      inputs: {},
      stopAfter: "compile",
    });
    expect(upserted.stopAfter).toBe("compile");
  });

  test("upserts rows under an explicit id", () => {
    const repo = new UserWorkflowRepository(new SqliteDatabase(":memory:"));

    const created = repo.upsert("briefing", {
      name: "Custom briefing",
      inputs: { topics: ["t2", "t1"] },
    });
    expect(created.id).toBe("briefing");
    expect(created.name).toBe("Custom briefing");
    expect(created.inputs).toEqual({ topics: ["t2", "t1"] });
    expect(repo.count()).toBe(1);

    const updated = repo.upsert("briefing", {
      name: "Custom briefing v2",
      inputs: { topics: ["t1"] },
    });
    expect(updated.name).toBe("Custom briefing v2");
    expect(updated.inputs).toEqual({ topics: ["t1"] });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(repo.count()).toBe(1);

    expect(() => repo.upsert("briefing", { name: "  ", inputs: {} })).toThrow(/name/);
  });
});

let kernel: Kernel;
let base: string;
let delivery: StubDeliveryService;

beforeAll(async () => {
  delivery = new StubDeliveryService();
  kernel = await createTestKernel({
    llm: stubLlm((request) => {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("editor")) {
        return completion(JSON.stringify({ markdown: "# Report\n\nSomething happened." }));
      }
      return completion(JSON.stringify({ found: true, notes: "Notes: something happened" }));
    }),
    searchProviders: [stubSearch("perplexity", "web", sampleResults)],
    socialSearch: stubSearch("bluesky", "social", [sampleResults[1]!]),
    delivery,
  });
  base = `http://127.0.0.1:${kernel.api.port}`;
});

afterAll(async () => {
  await kernel.shutdown();
});

interface WebhookResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

// Other test files replace global fetch with mocks; Bun.fetch stays real.
const realFetch = (Bun as unknown as { fetch: typeof fetch }).fetch.bind(Bun);

async function post(message: unknown): Promise<{ status: number; body: WebhookResponse }> {
  const response = await realFetch(`${base}/api/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  let body: WebhookResponse = { ok: response.ok };
  try {
    body = (await response.json()) as WebhookResponse;
  } catch {
    // no body
  }
  return { status: response.status, body };
}

async function call<T>(type: string, payload?: unknown): Promise<T> {
  const { status, body } = await post({ type, payload });
  expect(status).toBe(200);
  return body.result as T;
}

interface UserWorkflowInfo {
  id: string;
  name: string;
  inputs: Record<string, unknown>;
  stopAfter?: string;
}

describe("user workflows through the gateway", () => {
  test("create, list, run, update and remove with job and channel cleanup", async () => {
    const changes: Array<{ action: string; workflowId: string }> = [];
    const unsubscribe = kernel.bus.subscribe("workflow.user.changed", (event) =>
      changes.push(event.payload as { action: string; workflowId: string }),
    );

    try {
      const alpha = await call<{ id: string }>("topic.create", { name: "Alpha" });
      const beta = await call<{ id: string }>("topic.create", { name: "Beta" });
      const gamma = await call<{ id: string }>("topic.create", { name: "Gamma" });

      const created = await call<UserWorkflowInfo>("workflow.user.create", {
        name: "AI desk",
        inputs: { topics: [beta.id, gamma.id] },
      });
      expect(created.name).toBe("AI desk");
      expect(created.inputs).toEqual({ topics: [beta.id, gamma.id] });

      // workflow.list marks the instance and carries its configured inputs.
      const listed = await call<
        Array<{
          id: string;
          user?: boolean;
          inputValues?: Record<string, unknown>;
          triggers: string[];
          description: string;
          steps: Array<{ id: string; outputs: Array<{ kind: string; deliverable: boolean }> }>;
        }>
      >("workflow.list");
      const entry = listed.find((workflow) => workflow.id === created.id);
      expect(entry?.user).toBe(true);
      expect(entry?.inputValues).toEqual({ topics: [beta.id, gamma.id] });
      expect(entry?.triggers).toEqual(["schedule", "manual"]);
      expect(entry?.description).toBe("User briefing workflow: AI desk");
      // The definition's steps and deliverable outputs are exposed.
      expect(entry?.steps.map((step) => step.id)).toEqual([
        "research",
        "compile",
        "followups",
        "sources",
        "report",
        "events",
        "timeline",
        "audio",
      ]);
      expect(
        entry?.steps
          .find((step) => step.id === "report")
          ?.outputs.some((output) => output.kind === "report" && output.deliverable),
      ).toBe(true);
      // Built-in workflows are untouched by the enrichment.
      expect(listed.find((workflow) => workflow.id === "briefing")?.user).toBeUndefined();

      const userList = await call<UserWorkflowInfo[]>("workflow.user.list");
      expect(userList).toEqual([
        { id: created.id, name: "AI desk", inputs: { topics: [beta.id, gamma.id] } },
      ]);

      // The instance runs the briefing over exactly its topics.
      const finished = waitForEvent(
        kernel.bus,
        "workflow.finished",
        (event) => (event.payload as { workflow: string }).workflow === created.id,
      );
      const started = await call<{ workflow: string; runId: string }>("workflow.run", {
        id: created.id,
        input: {},
      });
      expect(started.workflow).toBe(created.id);

      const event = await finished;
      const output = (event.payload as { output: { skipped: boolean; topics: string[] } }).output;
      expect(output.skipped).toBe(false);
      expect(output.topics).toEqual(["Beta", "Gamma"]);

      // Delivery routed through the user workflow's step outputs and run.
      const delivered = delivery.delivered.at(-1)!;
      expect(delivered.runId).toBe(started.runId);
      expect(delivered.channels).toEqual(["chan-1"]);

      const updated = await call<UserWorkflowInfo>("workflow.user.update", {
        id: created.id,
        name: "AI desk v2",
        inputs: { topics: [alpha.id] },
      });
      expect(updated.name).toBe("AI desk v2");
      expect(updated.inputs).toEqual({ topics: [alpha.id] });
      expect(
        kernel.workflows.list().find((workflow) => workflow.id === created.id)?.description,
      ).toBe("User briefing workflow: AI desk v2");

      // A scheduled task referencing the workflow blocks deletion.
      const job = await call<{ id: string }>("job.create", {
        name: "nightly user report",
        cron: "0 7 * * *",
        workflow: created.id,
      });
      const blocked = await post({ type: "workflow.user.remove", payload: { id: created.id } });
      expect(blocked.status).toBe(400);
      expect(blocked.body.error).toContain("scheduled task");

      // With channels attached, removal detaches them and unregisters the run.
      const channel = await call<{ id: string }>("delivery.channel.create", {
        type: "matrix",
        name: "User matrix",
        config: {},
      });
      await call("delivery.attach", {
        workflow: created.id,
        step: "report",
        output: "report",
        channelId: channel.id,
      });
      expect(kernel.deliveries.attachments().some((a) => a.workflow === created.id)).toBe(true);

      await call("job.delete", { id: job.id });
      const removed = await call<{ ok: boolean }>("workflow.user.remove", { id: created.id });
      expect(removed.ok).toBe(true);

      expect(kernel.userWorkflows.get(created.id)).toBeNull();
      expect(kernel.deliveries.attachments().some((a) => a.workflow === created.id)).toBe(false);
      expect(kernel.workflows.list().some((workflow) => workflow.id === created.id)).toBe(false);
      expect((await call<UserWorkflowInfo[]>("workflow.user.list")).some((w) => w.id === created.id)).toBe(
        false,
      );

      expect(changes.map((change) => change.action)).toEqual(["create", "update", "delete"]);
      expect(changes.every((change) => change.workflowId === created.id)).toBe(true);

      await call("delivery.channel.delete", { id: channel.id });
    } finally {
      unsubscribe();
    }
  });

  test("registers stored user workflows at boot and on changes", async () => {
    const store = new UserWorkflowRepository(new SqliteDatabase(":memory:"));
    const row = store.add({ name: "Bootstrapped", inputs: { topics: ["t1"] } });

    const bootKernel = await createKernel({
      config: testConfig(),
      stores: { userWorkflows: store },
    });

    try {
      expect(bootKernel.workflows.get(row.id).definition.description).toBe(
        "User briefing workflow: Bootstrapped",
      );

      // The workflow.user.changed subscription unregisters removed rows.
      store.remove(row.id);
      bootKernel.bus.publish(
        "workflow.user.changed",
        { action: "delete", workflowId: row.id },
        { source: "test" },
      );
      expect(bootKernel.workflows.list().some((workflow) => workflow.id === row.id)).toBe(false);
    } finally {
      await bootKernel.shutdown();
    }
  });

  test("restores the built-in briefing when its customization row disappears", async () => {
    const store = new UserWorkflowRepository(new SqliteDatabase(":memory:"));
    store.upsert("briefing", { name: "Pinned report", inputs: { topics: ["t1", "t2"] } });

    const bootKernel = await createKernel({
      config: testConfig(),
      stores: { userWorkflows: store },
    });

    try {
      // The customization row replaced the core registration with a wrapper.
      const customized = bootKernel.workflows.get("briefing");
      expect(customized).toBeInstanceOf(UserBriefingWorkflow);
      expect(customized.definition.description).toBe("User briefing workflow: Pinned report");

      // Removing the row restores the core implementation under the same id.
      store.remove("briefing");
      bootKernel.bus.publish(
        "workflow.user.changed",
        { action: "delete", workflowId: "briefing" },
        { source: "test" },
      );

      const restored = bootKernel.workflows.get("briefing");
      expect(restored).toBeInstanceOf(BriefingWorkflow);
      expect(restored.definition.description).toContain("Researches all configured topics");
    } finally {
      await bootKernel.shutdown();
    }
  });

  test("stops a user workflow after the configured step", async () => {
    const topic = await call<{ id: string }>("topic.create", { name: "Stop topic" });
    const created = await call<UserWorkflowInfo>("workflow.user.create", {
      name: "Stopped report",
      inputs: { topics: [topic.id] },
      stopAfter: "report",
    });
    expect(created.stopAfter).toBe("report");

    try {
      const listed = await call<Array<{ id: string; stopAfter?: string }>>("workflow.list");
      expect(listed.find((workflow) => workflow.id === created.id)?.stopAfter).toBe("report");

      const finished = waitForEvent(
        kernel.bus,
        "workflow.finished",
        (event) => (event.payload as { workflow: string }).workflow === created.id,
      );
      await call("workflow.run", { id: created.id, input: {} });
      const output = (
        await finished
      ).payload as {
        output: { skipped: boolean; reportId?: string; stoppedAfter?: string; audioBytes?: number };
      };

      expect(output.output.skipped).toBe(false);
      expect(output.output.stoppedAfter).toBe("report");
      expect(output.output.reportId).toBeTruthy();
      // The audio step comes after the stop step and never ran.
      expect(output.output.audioBytes).toBeUndefined();
    } finally {
      await call("workflow.user.remove", { id: created.id });
      await call("topic.delete", { id: topic.id });
    }
  });

  test("validates user workflow input", async () => {
    const topic = await call<{ id: string }>("topic.create", { name: "Validation topic" });

    const emptyName = await post({
      type: "workflow.user.create",
      payload: { name: "  ", inputs: { topics: [topic.id] } },
    });
    expect(emptyName.status).toBe(400);

    // Creating needs only a name; inputs are configured later in the editor.
    const noTopics = await post({
      type: "workflow.user.create",
      payload: { name: "No topics" },
    });
    expect(noTopics.status).toBe(200);
    const unconfigured = noTopics.body.result as UserWorkflowInfo;
    expect(unconfigured.inputs).toEqual({ topics: [] });

    // The required check still guards updates that clear the topics.
    const clearedTopics = await post({
      type: "workflow.user.update",
      payload: { id: unconfigured.id, inputs: { topics: [] } },
    });
    expect(clearedTopics.status).toBe(400);
    expect(clearedTopics.body.error).toContain("topics");
    await call("workflow.user.remove", { id: unconfigured.id });

    const unknownTopic = await post({
      type: "workflow.user.create",
      payload: { name: "Unknown", inputs: { topics: ["missing"] } },
    });
    expect(unknownTopic.status).toBe(400);
    expect(unknownTopic.body.error).toContain("not found");

    // A language is accepted by name or code and normalized to its code.
    const withLanguage = await call<UserWorkflowInfo>("workflow.user.create", {
      name: "German desk",
      inputs: { topics: [topic.id], language: "German" },
    });
    expect(withLanguage.inputs).toEqual({ topics: [topic.id], language: "de" });
    await call("workflow.user.remove", { id: withLanguage.id });

    const badLanguage = await post({
      type: "workflow.user.create",
      payload: { name: "Klingon desk", inputs: { topics: [topic.id], language: "klingon" } },
    });
    expect(badLanguage.status).toBe(400);
    expect(badLanguage.body.error).toContain("Unsupported language");

    const unknownStop = await post({
      type: "workflow.user.create",
      payload: {
        name: "Bad stop",
        inputs: { topics: [topic.id] },
        stopAfter: "missing-step",
      },
    });
    expect(unknownStop.status).toBe(400);
    expect(unknownStop.body.error).toContain("no step");

    const missing = await post({
      type: "workflow.user.update",
      payload: { id: "missing", name: "x" },
    });
    expect(missing.status).toBe(404);

    const missingRemove = await post({
      type: "workflow.user.remove",
      payload: { id: "missing" },
    });
    expect(missingRemove.status).toBe(404);

    await call("topic.delete", { id: topic.id });
  });

  test("workflow.user.create never reuses a built-in id", async () => {
    const topic = await call<{ id: string }>("topic.create", { name: "Uuid topic" });

    // An id in the payload is ignored: create always mints its own uuid.
    const created = await call<UserWorkflowInfo>("workflow.user.create", {
      id: "briefing",
      name: "Sneaky briefing",
      inputs: { topics: [topic.id] },
    });
    expect(created.id).not.toBe("briefing");
    expect(kernel.userWorkflows.get("briefing")).toBeNull();

    await call("workflow.user.remove", { id: created.id });
    await call("topic.delete", { id: topic.id });
  });

  test("customizes the built-in briefing and restores it when the row is removed", async () => {
    const changes: Array<{ action: string; workflowId: string }> = [];
    const unsubscribe = kernel.bus.subscribe("workflow.user.changed", (event) =>
      changes.push(event.payload as { action: string; workflowId: string }),
    );
    const channel = await call<{ id: string }>("delivery.channel.create", {
      type: "matrix",
      name: "Briefing matrix",
      config: {},
    });
    const alpha = await call<{ id: string }>("topic.create", { name: "Custom Alpha" });
    const beta = await call<{ id: string }>("topic.create", { name: "Custom Beta" });

    try {
      // The seeded scheduled job already references the built-in id.
      expect(kernel.jobs.list().some((job) => job.workflow === "briefing")).toBe(true);
      await call("delivery.attach", {
        workflow: "briefing",
        step: "report",
        output: "report",
        channelId: channel.id,
      });

      // No row yet: updating the built-in starts the customization.
      const customized = await call<UserWorkflowInfo>("workflow.user.update", {
        id: "briefing",
        name: "Focus report",
        inputs: { topics: [alpha.id] },
      });
      expect(customized).toEqual({
        id: "briefing",
        name: "Focus report",
        inputs: { topics: [alpha.id] },
      });

      const listed = await call<
        Array<{
          id: string;
          user?: boolean;
          inputValues?: Record<string, unknown>;
          description: string;
        }>
      >("workflow.list");
      const entry = listed.find((workflow) => workflow.id === "briefing");
      expect(entry?.user).toBe(true);
      expect(entry?.inputValues).toEqual({ topics: [alpha.id] });
      expect(entry?.description).toBe("User briefing workflow: Focus report");

      // The customized briefing only covers its pinned topics.
      const pinned = waitForEvent(
        kernel.bus,
        "workflow.finished",
        (event) => (event.payload as { workflow: string }).workflow === "briefing",
      );
      await call("workflow.run", { id: "briefing", input: {} });
      const pinnedOutput = (await pinned).payload as {
        output: { skipped: boolean; topics: string[] };
      };
      expect(pinnedOutput.output.skipped).toBe(false);
      expect(pinnedOutput.output.topics).toEqual(["Custom Alpha"]);

      // Removing the customization keeps the workflow itself: scheduled jobs
      // and channel attachments are untouched.
      const removed = await call<{ ok: boolean }>("workflow.user.remove", { id: "briefing" });
      expect(removed.ok).toBe(true);
      expect(kernel.userWorkflows.get("briefing")).toBeNull();
      expect(kernel.workflows.get("briefing")).toBeInstanceOf(BriefingWorkflow);
      expect(kernel.jobs.list().some((job) => job.workflow === "briefing")).toBe(true);
      expect(kernel.deliveries.attachments().some((a) => a.workflow === "briefing")).toBe(true);

      // The restored built-in reports every active topic again.
      const activeNames = (
        await call<Array<{ id: string; name: string; muted: boolean }>>("topic.list")
      )
        .filter((topic) => !topic.muted)
        .map((topic) => topic.name);
      expect(activeNames).toContain("Custom Alpha");
      expect(activeNames).toContain("Custom Beta");

      const all = waitForEvent(
        kernel.bus,
        "workflow.finished",
        (event) => (event.payload as { workflow: string }).workflow === "briefing",
      );
      await call("workflow.run", { id: "briefing", input: {} });
      const allOutput = (await all).payload as { output: { skipped: boolean; topics: string[] } };
      expect(allOutput.output.skipped).toBe(false);
      expect(allOutput.output.topics).toEqual(activeNames);

      expect(changes.map((change) => change.action)).toEqual(["update", "delete"]);
      expect(changes.every((change) => change.workflowId === "briefing")).toBe(true);
    } finally {
      unsubscribe();
      try {
        if (kernel.userWorkflows.get("briefing")) {
          await call("workflow.user.remove", { id: "briefing" });
        }
        await call("delivery.detach", {
          workflow: "briefing",
          step: "report",
          output: "report",
          channelId: channel.id,
        });
        await call("delivery.channel.delete", { id: channel.id });
        await call("topic.delete", { id: alpha.id });
        await call("topic.delete", { id: beta.id });
      } catch {
        // Best-effort cleanup; the test result is already decided.
      }
    }
  });
});
