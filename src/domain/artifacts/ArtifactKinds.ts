import { parseJsonValue } from "../../core/json.ts";
import type { SqliteDatabase } from "../../infra/db/SqliteDatabase.ts";

/**
 * An artifact kind's storage module: kinds only add a table when the generic
 * registry cannot hold their fields. The repository strips `fields` out of the
 * generic metadata on write and resolves them back on read.
 */
export interface ArtifactKind {
  kind: string;
  /** Metadata keys stored in this kind's own table. */
  fields: readonly string[];
  resolve(db: SqliteDatabase, ids: string[]): Map<string, Record<string, unknown>>;
  persist(db: SqliteDatabase, id: string, fields: Record<string, unknown>): void;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

const reportTextKind: ArtifactKind = {
  kind: "report-text",
  fields: ["narration", "sources"],
  resolve(db, ids) {
    const rows = db.raw
      .query<{ artifact_id: string; narration: string; sources: string }, string[]>(
        `SELECT artifact_id, narration, sources FROM report_texts WHERE artifact_id IN (${placeholders(ids.length)})`,
      )
      .all(...ids);
    return new Map(
      rows.map((row) => [
        row.artifact_id,
        {
          narration: row.narration,
          sources: parseJsonValue<unknown[]>(row.sources, []),
        },
      ]),
    );
  },
  persist(db, id, fields) {
    const existing = db.raw
      .query<{ narration: string; sources: string }, [string]>(
        "SELECT narration, sources FROM report_texts WHERE artifact_id = ?",
      )
      .get(id);
    const narration =
      "narration" in fields
        ? typeof fields.narration === "string"
          ? fields.narration
          : ""
        : (existing?.narration ?? "");
    const sources =
      "sources" in fields
        ? Array.isArray(fields.sources)
          ? fields.sources
          : []
        : parseJsonValue<unknown[]>(existing?.sources, []);
    db.raw
      .query(
        `INSERT INTO report_texts (artifact_id, narration, sources) VALUES (?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET narration = excluded.narration, sources = excluded.sources`,
      )
      .run(id, narration, JSON.stringify(sources));
  },
};

const audioKind: ArtifactKind = {
  kind: "audio",
  fields: ["durationMs"],
  resolve(db, ids) {
    const rows = db.raw
      .query<{ artifact_id: string; duration_ms: number | null }, string[]>(
        `SELECT artifact_id, duration_ms FROM audio_artifacts WHERE artifact_id IN (${placeholders(ids.length)})`,
      )
      .all(...ids);
    return new Map(
      rows.map((row) => [
        row.artifact_id,
        row.duration_ms === null ? {} : { durationMs: row.duration_ms },
      ]),
    );
  },
  persist(db, id, fields) {
    if (!("durationMs" in fields)) return;
    const durationMs = typeof fields.durationMs === "number" ? fields.durationMs : null;
    db.raw
      .query(
        `INSERT INTO audio_artifacts (artifact_id, duration_ms) VALUES (?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET duration_ms = excluded.duration_ms`,
      )
      .run(id, durationMs);
  },
};

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [reportTextKind, audioKind];
