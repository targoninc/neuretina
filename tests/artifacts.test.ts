import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ArtifactRepository } from "../src/domain/artifacts/ArtifactRepository.ts";
import { SqliteDatabase } from "../src/infra/db/SqliteDatabase.ts";
import { migrations, runMigrations } from "../src/infra/db/migrations.ts";
import { MemoryArtifactFileStore } from "../src/infra/files.ts";

function repo(): ArtifactRepository {
  return new ArtifactRepository(new SqliteDatabase(":memory:"));
}

describe("ArtifactRepository", () => {
  test("stores text and binary artifacts with references", () => {
    const artifacts = repo();
    const report = artifacts.create({
      kind: "report",
      name: "Rust",
      contentType: "text/markdown",
      content: "# Rust",
      metadata: { topics: ["Rust"] },
      workflow: "briefing",
      correlationId: "c1",
    });
    const audio = artifacts.create({
      kind: "audio",
      contentType: "audio/ogg",
      data: new Uint8Array([1, 2, 3]),
      parentId: report.id,
      workflow: "briefing",
      correlationId: "c1",
      metadata: { reportId: report.id },
    });
    artifacts.updateMetadata(report.id, { audioArtifactId: audio.id });

    const stored = artifacts.get(report.id);
    expect(stored.kind).toBe("report");
    expect(stored.name).toBe("Rust");
    expect(stored.content).toBe("# Rust");
    expect(stored.hasContent).toBe(true);
    expect(stored.hasData).toBe(false);
    expect(stored.data).toBeUndefined();
    expect(stored.metadata).toMatchObject({ topics: ["Rust"], audioArtifactId: audio.id });
    expect(stored.workflow).toBe("briefing");
    expect(stored.correlationId).toBe("c1");

    const withData = artifacts.get(audio.id, { includeData: true });
    expect(withData.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(withData.parentId).toBe(report.id);
    expect(withData.byteSize).toBe(3);
  });

  test("lists by kind, workflow and parent", () => {
    const artifacts = repo();
    const report = artifacts.create({
      kind: "report",
      contentType: "text/markdown",
      content: "one",
      workflow: "briefing",
    });
    artifacts.create({
      kind: "audio",
      contentType: "audio/ogg",
      data: new Uint8Array([1]),
      parentId: report.id,
      workflow: "briefing",
    });
    artifacts.create({ kind: "notes", contentType: "text/plain", content: "two", workflow: "other" });

    expect(artifacts.list({ kind: "report" })).toHaveLength(1);
    expect(artifacts.list({ workflow: "briefing" })).toHaveLength(2);
    expect(artifacts.list({ parentId: report.id })).toHaveLength(1);
    expect(artifacts.list()).toHaveLength(3);
  });

  test("searches content, name and metadata", () => {
    const artifacts = repo();
    artifacts.create({
      kind: "report",
      contentType: "text/markdown",
      content: "Ownership news",
      metadata: { topics: ["Rust"] },
    });
    artifacts.create({
      kind: "report",
      contentType: "text/markdown",
      content: "New rules coming",
      metadata: { topics: ["AI regulation"] },
    });

    expect(artifacts.search("Ownership", { kind: "report" })).toHaveLength(1);
    expect(artifacts.search("regulation", { kind: "report" })).toHaveLength(1);
    expect(artifacts.search("missing", { kind: "report" })).toHaveLength(0);
    expect(artifacts.search(undefined, { kind: "report", limit: 1 })).toHaveLength(1);
  });

  test("replaceData updates the blob in place", () => {
    const artifacts = repo();
    const audio = artifacts.create({
      kind: "audio",
      contentType: "audio/ogg",
      data: new Uint8Array([1]),
    });

    artifacts.replaceData(audio.id, new Uint8Array([9, 9]), "audio/mpeg");

    const stored = artifacts.get(audio.id, { includeData: true });
    expect(stored.data).toEqual(new Uint8Array([9, 9]));
    expect(stored.contentType).toBe("audio/mpeg");
    expect(stored.byteSize).toBe(2);
  });

  test("remove cascades to child artifacts", () => {
    const artifacts = repo();
    const parent = artifacts.create({ kind: "report", contentType: "text/markdown", content: "x" });
    const child = artifacts.create({
      kind: "audio",
      contentType: "audio/ogg",
      data: new Uint8Array([1]),
      parentId: parent.id,
    });

    artifacts.remove(parent.id);

    expect(() => artifacts.get(child.id)).toThrow(/not found/);
    expect(artifacts.list()).toHaveLength(0);
  });
});

describe("artifact schema", () => {
  test("fresh databases only have the artifacts schema", () => {
    const db = new SqliteDatabase(":memory:");
    const tables = db.raw
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);

    expect(tables).toContain("artifacts");
    expect(tables).not.toContain("reports");
  });

  test("rejects pre-artifacts databases instead of half-migrating them", () => {
    const raw = new Database(":memory:");
    raw.exec(`
      CREATE TABLE briefs (
        id         TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        topics     TEXT NOT NULL,
        markdown   TEXT NOT NULL,
        narration  TEXT NOT NULL,
        sources    TEXT NOT NULL
      );
    `);

    expect(() => runMigrations(raw)).toThrow(/predates the artifacts schema/);
  });

  test("migrates briefs into reports with ordered artifacts", () => {
    const raw = new Database(":memory:");
    for (const migration of migrations.filter((entry) => entry.id < 21)) raw.exec(migration.sql);
    raw.exec(`
      INSERT INTO artifacts (id, kind, name, content_type, content, metadata, parent_id, workflow, correlation_id, context_id, created_at)
      VALUES
        ('b1', 'brief', 'Rust', 'text/markdown', '# Hello', '{"topics":["Rust"],"narration":"spoken","sources":[]}', NULL, 'briefing', 'run-1', 'default', 100),
        ('a1', 'audio', 'Rust (audio)', 'audio/ogg', NULL, '{"briefId":"b1","durationMs":1200}', 'b1', 'briefing', 'run-1', 'default', 110),
        ('t1', 'timeline', 'Timeline', 'text/markdown', '## Timeline', '{"eventIds":["e1"],"briefId":"b1"}', 'b1', 'briefing', 'run-1', 'default', 120);
      INSERT INTO brief_shares (token, brief_id, created_at) VALUES ('tok', 'b1', 100);
      INSERT INTO deliveries (id, brief_id, run_id, channel_id, kind, status, created_at, updated_at)
      VALUES ('d1', 'b1', 'run-1', 'c1', 'text', 'sent', 100, 100);
      INSERT INTO timeline_events (id, date, entities, tags, title, description, source_brief_id, created_at, updated_at)
      VALUES ('e1', '2026-09-30', '[]', '[]', 'Event', '', 'b1', 100, 100);
    `);

    raw.exec(migrations.find((entry) => entry.id === 21)!.sql);

    const report = raw
      .query<{ id: string; kind: string; metadata: string }, []>(
        "SELECT id, kind, metadata FROM artifacts WHERE id = 'b1'",
      )
      .get()!;
    expect(report.kind).toBe("report");
    const metadata = JSON.parse(report.metadata) as { topics: string[]; artifactIds: string[] };
    expect(metadata.topics).toEqual(["Rust"]);

    const text = raw
      .query<{ id: string; kind: string; content: string; metadata: string }, []>(
        "SELECT id, kind, content, metadata FROM artifacts WHERE kind = 'report-text'",
      )
      .get()!;
    expect(text.content).toBe("# Hello");
    expect(JSON.parse(text.metadata).narration).toBe("spoken");
    // Timeline first, then audio, then the text.
    expect(metadata.artifactIds).toEqual(["t1", "a1", text.id]);

    expect(
      raw.query<{ report_id: string }, []>("SELECT report_id FROM report_shares").get()?.report_id,
    ).toBe("b1");
    expect(
      raw.query<{ report_id: string }, []>("SELECT report_id FROM deliveries").get()?.report_id,
    ).toBe("b1");
    expect(
      raw.query<{ source_report_id: string }, []>("SELECT source_report_id FROM timeline_events").get()
        ?.source_report_id,
    ).toBe("b1");
  });

  test("restores report-text children for containers that held content", () => {
    const raw = new Database(":memory:");
    for (const migration of migrations.filter((entry) => entry.id < 25)) raw.exec(migration.sql);
    raw.exec(`
      INSERT INTO artifacts (id, kind, name, content_type, content, metadata, parent_id, workflow, correlation_id, context_id, created_at)
      VALUES
        ('r1', 'report', 'Rust', 'text/markdown', '# Hello', '{"topics":["Rust"],"narration":"spoken","sources":[{"title":"X","url":"https://x","provider":"exa"}],"artifactIds":["a1"]}', NULL, 'briefing', 'run-1', 'default', 100),
        ('a1', 'audio', 'Rust (audio)', 'audio/ogg', NULL, '{"reportId":"r1"}', 'r1', 'briefing', 'run-1', 'default', 110);
    `);

    const restore = migrations.find((migration) => migration.id === 25)!;
    raw.exec(restore.sql);

    const report = raw
      .query<{ content: string | null; content_type: string; metadata: string }, []>(
        "SELECT content, content_type, metadata FROM artifacts WHERE id = 'r1'",
      )
      .get()!;
    expect(report.content).toBeNull();
    expect(report.content_type).toBe("application/json");
    const metadata = JSON.parse(report.metadata) as {
      narration?: string;
      sources?: unknown;
      artifactIds: string[];
    };
    expect(metadata.narration).toBeUndefined();
    expect(metadata.sources).toBeUndefined();

    const text = raw
      .query<{ id: string; content: string; metadata: string }, []>(
        "SELECT id, content, metadata FROM artifacts WHERE kind = 'report-text'",
      )
      .get()!;
    expect(text.content).toBe("# Hello");
    expect(JSON.parse(text.metadata).narration).toBe("spoken");
    expect(JSON.parse(text.metadata).sources).toEqual([
      { title: "X", url: "https://x", provider: "exa" },
    ]);
    // The text primitive is appended after the existing attachments.
    expect(metadata.artifactIds).toEqual(["a1", text.id]);
  });

  test("splits artifact payloads and type fields into their stores", () => {
    const raw = new Database(":memory:");
    for (const migration of migrations.filter((entry) => entry.id < 26)) raw.exec(migration.sql);
    raw.exec(`
      INSERT INTO artifacts (id, kind, name, content_type, content, data, metadata, parent_id, workflow, correlation_id, context_id, created_at)
      VALUES
        ('r1', 'report', 'Rust', 'application/json', NULL, NULL, '{"topics":["Rust"],"artifactIds":["t1","a1"]}', NULL, 'briefing', 'run-1', 'default', 100),
        ('t1', 'report-text', 'Rust (text)', 'text/markdown', '# Hello', NULL, '{"narration":"spoken","sources":[{"title":"X","url":"https://x","provider":"exa"}]}', 'r1', 'briefing', 'run-1', 'default', 110),
        ('a1', 'audio', 'Rust (audio)', 'audio/ogg', NULL, x'0102', '{"reportId":"r1","mime":"audio/ogg","durationMs":1200}', 'r1', 'briefing', 'run-1', 'default', 120),
        ('tl1', 'timeline', 'Timeline', 'text/markdown', '## Timeline', NULL, '{"eventIds":["e1"],"reportId":"r1"}', 'r1', 'briefing', 'run-1', 'default', 130);
    `);

    const files = new MemoryArtifactFileStore();
    const migration = migrations.find((entry) => entry.id === 26)!;
    raw.transaction(() => {
      raw.exec(migration.sql);
      migration.run?.(raw, files);
    })();

    const text = raw
      .query<{ content: string }, []>("SELECT content FROM artifact_texts WHERE artifact_id = 't1'")
      .get()!;
    expect(text.content).toBe("# Hello");

    const links = raw
      .query<{ artifact_id: string; target_kind: string; target_id: string }, []>(
        "SELECT artifact_id, target_kind, target_id FROM artifact_links ORDER BY artifact_id, position",
      )
      .all();
    expect(links).toEqual([
      { artifact_id: "r1", target_kind: "artifact", target_id: "t1" },
      { artifact_id: "r1", target_kind: "artifact", target_id: "a1" },
      { artifact_id: "tl1", target_kind: "event", target_id: "e1" },
    ]);

    const reportText = raw
      .query<{ narration: string; sources: string }, []>(
        "SELECT narration, sources FROM report_texts WHERE artifact_id = 't1'",
      )
      .get()!;
    expect(reportText.narration).toBe("spoken");
    expect(JSON.parse(reportText.sources)).toEqual([
      { title: "X", url: "https://x", provider: "exa" },
    ]);

    const audio = raw
      .query<{ duration_ms: number; byte_size: number }, []>(
        "SELECT duration_ms, byte_size FROM audio_artifacts JOIN artifacts ON artifacts.id = audio_artifacts.artifact_id",
      )
      .get()!;
    expect(audio).toEqual({ duration_ms: 1200, byte_size: 2 });
    expect(files.read("a1")).toEqual(new Uint8Array([1, 2]));

    // The registry keeps only generic metadata.
    const registry = raw
      .query<{ metadata: string }, []>("SELECT metadata FROM artifacts WHERE id = 'a1'")
      .get()!;
    expect(JSON.parse(registry.metadata)).toEqual({});

    const columns = raw
      .query<{ name: string }, []>("PRAGMA table_info(artifacts)")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("content");
    expect(columns).not.toContain("data");
  });

  test("repairs legacy report attribution to the run's workflow", () => {
    const raw = new Database(":memory:");
    runMigrations(raw);
    raw.exec(`
      INSERT INTO workflow_runs (id, workflow, context_id, trigger, status, started_at)
      VALUES ('run-1', 'user-1', 'morning-briefing', 'manual', 'succeeded', 0);
      INSERT INTO artifacts (id, kind, content_type, workflow, correlation_id, context_id, created_at)
      VALUES
        ('report-1', 'brief', 'text/markdown', 'briefing', 'run-1', 'morning-briefing', 0),
        ('audio-1', 'audio', 'audio/ogg', 'briefing', 'run-1', 'morning-briefing', 0),
        ('report-2', 'brief', 'text/markdown', 'briefing', 'run-missing', 'morning-briefing', 0),
        ('report-3', 'brief', 'text/markdown', 'briefing', NULL, 'morning-briefing', 0);
    `);

    const repair = migrations.find((migration) => migration.id === 13)!;
    raw.exec(repair.sql);

    const rows = raw
      .query<{ id: string; workflow: string }, []>(
        "SELECT id, workflow FROM artifacts ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      { id: "audio-1", workflow: "user-1" },
      { id: "report-1", workflow: "user-1" },
      { id: "report-2", workflow: "briefing" },
      { id: "report-3", workflow: "briefing" },
    ]);
  });
});
