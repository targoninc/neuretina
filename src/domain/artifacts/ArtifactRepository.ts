import { NotFoundError } from "../../core/errors.ts";
import { parseJsonObject, parseJsonValue } from "../../core/json.ts";
import type { SqliteDatabase } from "../../infra/db/SqliteDatabase.ts";
import type { ArtifactFileStore } from "../../infra/files.ts";
import { DEFAULT_CONTEXT_ID } from "../contexts/ContextRepository.ts";
import { ARTIFACT_KINDS, type ArtifactKind } from "./ArtifactKinds.ts";

/**
 * Generic artifact: any text or binary output a workflow produces (reports,
 * audio, notes, datasets, …), with references back to the run that made it
 * and, optionally, to a parent artifact it belongs to. The registry row is
 * thin: text payloads live in `artifact_texts`, binary payloads in files,
 * ordered references in `artifact_links`, and kind-specific fields in the
 * kind's table (see ArtifactKinds).
 */
export interface Artifact {
  id: string;
  kind: string;
  name?: string;
  contentType: string;
  /** Text payload (markdown, JSON, plain text) — always loaded. */
  content?: string;
  /** Binary payload — only loaded when requested. */
  data?: Uint8Array;
  metadata: Record<string, unknown>;
  /** Artifact this one belongs to (e.g. a report's audio → its report). */
  parentId?: string;
  /** Workflow that produced the artifact. */
  workflow?: string;
  /** Workflow run that produced the artifact. */
  correlationId?: string;
  /** Context the artifact belongs to. */
  contextId: string;
  createdAt: number;
  hasContent: boolean;
  hasData: boolean;
  byteSize?: number;
}

export interface CreateArtifactInput {
  kind: string;
  name?: string;
  contentType: string;
  content?: string;
  data?: Uint8Array;
  metadata?: Record<string, unknown>;
  parentId?: string;
  workflow?: string;
  correlationId?: string;
  contextId?: string;
}

export interface ListArtifactsOptions {
  kind?: string;
  workflow?: string;
  parentId?: string;
  /** Only artifacts produced by this workflow run. */
  correlationId?: string;
  /** Only artifacts belonging to this context. */
  contextId?: string;
  limit?: number;
}

interface ArtifactRow {
  id: string;
  kind: string;
  name: string | null;
  content_type: string;
  byte_size: number | null;
  metadata: string;
  parent_id: string | null;
  workflow: string | null;
  correlation_id: string | null;
  context_id: string;
  created_at: number;
  text_content: string | null;
  artifact_ids: string;
  event_ids: string;
}

/** Registry columns plus the joined text payload and ordered references. */
const SELECT = `
  SELECT
    a.id, a.kind, a.name, a.content_type, a.byte_size, a.metadata, a.parent_id,
    a.workflow, a.correlation_id, a.context_id, a.created_at,
    t.content AS text_content,
    (SELECT json_group_array(target_id) FROM (
      SELECT target_id FROM artifact_links AS l
      WHERE l.artifact_id = a.id AND l.target_kind = 'artifact'
      ORDER BY l.position
    )) AS artifact_ids,
    (SELECT json_group_array(target_id) FROM (
      SELECT target_id FROM artifact_links AS l
      WHERE l.artifact_id = a.id AND l.target_kind = 'event'
      ORDER BY l.position
    )) AS event_ids
  FROM artifacts AS a
  LEFT JOIN artifact_texts AS t ON t.artifact_id = a.id
`;

/** Storage-agnostic artifact store; swap the implementation without touching consumers. */
export interface ArtifactStore {
  create(input: CreateArtifactInput): Artifact;
  get(id: string, options?: { includeData?: boolean }): Artifact;
  list(options?: ListArtifactsOptions): Artifact[];
  /** Text search over content, name and metadata (topics, …). */
  search(
    query: string | undefined,
    options?: { kind?: string; contextId?: string; limit?: number },
  ): Artifact[];
  updateMetadata(id: string, patch: Record<string, unknown>): Artifact;
  /** Replaces the binary payload in place (regenerating a report's audio). */
  replaceData(id: string, data: Uint8Array, contentType?: string): Artifact;
  /** Removes the artifact and everything referencing it as parent. */
  remove(id: string): Artifact;
}

/** Stores every workflow output in one registry so the engine stays generic. */
export class ArtifactRepository implements ArtifactStore {
  private readonly kinds: Map<string, ArtifactKind>;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly files: ArtifactFileStore = db.artifactFiles,
    kinds: readonly ArtifactKind[] = ARTIFACT_KINDS,
  ) {
    this.kinds = new Map(kinds.map((kind) => [kind.kind, kind]));
  }

  create(input: CreateArtifactInput): Artifact {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const kind = this.kinds.get(input.kind);
    const source = { ...(input.metadata ?? {}) };
    const artifactIds = stringArray(source.artifactIds);
    const eventIds = stringArray(source.eventIds);
    delete source.artifactIds;
    delete source.eventIds;
    for (const field of kind?.fields ?? []) delete source[field];
    const byteSize = input.data === undefined ? null : input.data.byteLength;

    this.db.transaction(() => {
      this.db.raw
        .query(
          `INSERT INTO artifacts
             (id, kind, name, content_type, byte_size, metadata, parent_id,
              workflow, correlation_id, context_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.kind,
          input.name ?? null,
          input.contentType,
          byteSize,
          JSON.stringify(source),
          input.parentId ?? null,
          input.workflow ?? null,
          input.correlationId ?? null,
          input.contextId ?? DEFAULT_CONTEXT_ID,
          createdAt,
        );

      if (input.content !== undefined) {
        this.db.raw
          .query("INSERT INTO artifact_texts (artifact_id, content) VALUES (?, ?)")
          .run(id, input.content);
      }
      if (input.data !== undefined) {
        this.files.write(id, input.data);
      }
      if (artifactIds.length > 0) this.writeLinks(id, "artifact", artifactIds);
      if (eventIds.length > 0) this.writeLinks(id, "event", eventIds);
      kind?.persist(this.db, id, input.metadata ?? {});
    });

    return this.get(id);
  }

  get(id: string, options: { includeData?: boolean } = {}): Artifact {
    const row = this.db.raw
      .query<ArtifactRow, [string]>(`${SELECT} WHERE a.id = ?`)
      .get(id);
    if (!row) throw new NotFoundError(`Artifact ${id} not found`);

    const artifact = this.resolve([row])[0]!;
    if (options.includeData && row.byte_size !== null) {
      const data = this.files.read(id);
      if (data) artifact.data = data;
    }
    return artifact;
  }

  list(options: ListArtifactsOptions = {}): Artifact[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options.kind) {
      conditions.push("a.kind = ?");
      params.push(options.kind);
    }
    if (options.workflow) {
      conditions.push("a.workflow = ?");
      params.push(options.workflow);
    }
    if (options.parentId) {
      conditions.push("a.parent_id = ?");
      params.push(options.parentId);
    }
    if (options.correlationId) {
      conditions.push("a.correlation_id = ?");
      params.push(options.correlationId);
    }
    if (options.contextId) {
      conditions.push("a.context_id = ?");
      params.push(options.contextId);
    }

    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 500);
    params.push(limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db.raw
      .query<ArtifactRow, Array<string | number>>(
        `${SELECT} ${where} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
      )
      .all(...params);
    return this.resolve(rows);
  }

  /** Text search over content, name and metadata (topics, …). */
  search(
    query: string | undefined,
    options: { kind?: string; contextId?: string; limit?: number } = {},
  ): Artifact[] {
    const trimmed = query?.trim();
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 3), 1), 100);
    if (!trimmed) return this.list({ kind: options.kind, contextId: options.contextId, limit });

    const like = `%${trimmed}%`;
    const conditions = ["(t.content LIKE ? OR a.name LIKE ? OR a.metadata LIKE ?)"];
    const params: Array<string | number> = [like, like, like];
    if (options.kind) {
      conditions.push("a.kind = ?");
      params.push(options.kind);
    }
    if (options.contextId) {
      conditions.push("a.context_id = ?");
      params.push(options.contextId);
    }
    params.push(limit);

    const rows = this.db.raw
      .query<ArtifactRow, Array<string | number>>(
        `${SELECT} WHERE ${conditions.join(" AND ")} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
      )
      .all(...params);
    return this.resolve(rows);
  }

  updateMetadata(id: string, patch: Record<string, unknown>): Artifact {
    const artifact = this.get(id);
    const generic = { ...artifact.metadata };
    delete generic.artifactIds;
    delete generic.eventIds;
    const kind = this.kinds.get(artifact.kind);
    for (const field of kind?.fields ?? []) delete generic[field];

    const rest = { ...patch };
    if ("artifactIds" in rest) {
      this.writeLinks(id, "artifact", stringArray(rest.artifactIds));
      delete rest.artifactIds;
    }
    if ("eventIds" in rest) {
      this.writeLinks(id, "event", stringArray(rest.eventIds));
      delete rest.eventIds;
    }

    const kindFields: Record<string, unknown> = {};
    for (const field of kind?.fields ?? []) {
      if (!(field in rest)) continue;
      kindFields[field] = rest[field];
      delete rest[field];
    }
    if (Object.keys(kindFields).length > 0) kind!.persist(this.db, id, kindFields);

    if (Object.keys(rest).length > 0) {
      this.db.raw
        .query("UPDATE artifacts SET metadata = ? WHERE id = ?")
        .run(JSON.stringify({ ...generic, ...rest }), id);
    }
    return this.get(id);
  }

  /** Replaces the binary payload in place (regenerating a report's audio). */
  replaceData(id: string, data: Uint8Array, contentType?: string): Artifact {
    const artifact = this.get(id);
    this.files.write(id, data);
    this.db.raw
      .query("UPDATE artifacts SET byte_size = ?, content_type = COALESCE(?, content_type) WHERE id = ?")
      .run(data.byteLength, contentType ?? null, id);
    return {
      ...artifact,
      contentType: contentType ?? artifact.contentType,
      hasData: true,
      byteSize: data.byteLength,
    };
  }

  /** Removes the artifact and everything referencing it as parent. */
  remove(id: string): Artifact {
    const artifact = this.get(id);
    const children = this.db.raw
      .query<{ id: string }, [string]>("SELECT id FROM artifacts WHERE parent_id = ?")
      .all(id);
    const removed = [id, ...children.map((child) => child.id)];
    const marks = removed.map(() => "?").join(", ");

    this.db.transaction(() => {
      this.db.raw.query("DELETE FROM artifacts WHERE parent_id = ?").run(id);
      this.db.raw.query("DELETE FROM artifacts WHERE id = ?").run(id);
      this.db.raw
        .query(
          `DELETE FROM artifact_links WHERE artifact_id IN (${marks}) OR target_id IN (${marks})`,
        )
        .run(...removed, ...removed);
    });
    for (const target of removed) this.files.remove(target);
    return artifact;
  }

  private writeLinks(id: string, targetKind: string, targets: string[]): void {
    this.db.raw
      .query("DELETE FROM artifact_links WHERE artifact_id = ? AND target_kind = ?")
      .run(id, targetKind);
    const insert = this.db.raw.query(
      "INSERT INTO artifact_links (artifact_id, position, target_kind, target_id) VALUES (?, ?, ?, ?)",
    );
    targets.forEach((target, position) => insert.run(id, position, targetKind, target));
  }

  private resolve(rows: ArtifactRow[]): Artifact[] {
    const fields = new Map<string, Record<string, unknown>>();
    for (const kind of this.kinds.values()) {
      const ids = rows.filter((row) => row.kind === kind.kind).map((row) => row.id);
      if (ids.length === 0) continue;
      for (const [id, values] of kind.resolve(this.db, ids)) fields.set(id, values);
    }

    return rows.map((row) => {
      const metadata = parseJsonObject(row.metadata);
      const artifactIds = parseJsonValue<unknown>(row.artifact_ids, []);
      const eventIds = parseJsonValue<unknown>(row.event_ids, []);
      if (Array.isArray(artifactIds) && artifactIds.length > 0) {
        metadata.artifactIds = artifactIds;
      }
      if (Array.isArray(eventIds) && eventIds.length > 0) {
        metadata.eventIds = eventIds;
      }
      const extra = fields.get(row.id);
      if (extra) Object.assign(metadata, extra);

      return {
        id: row.id,
        kind: row.kind,
        name: row.name ?? undefined,
        contentType: row.content_type,
        content: row.text_content ?? undefined,
        metadata,
        parentId: row.parent_id ?? undefined,
        workflow: row.workflow ?? undefined,
        correlationId: row.correlation_id ?? undefined,
        contextId: row.context_id,
        createdAt: row.created_at,
        hasContent: row.text_content !== null,
        hasData: row.byte_size !== null,
        byteSize: row.byte_size ?? undefined,
      };
    });
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
