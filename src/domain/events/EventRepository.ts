import type { SqliteDatabase } from "../../infra/db/SqliteDatabase.ts";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { parseJsonValue } from "../../core/json.ts";

/**
 * A dated event learned from reports: a row in the events table (never an
 * artifact) with a calendar date, the entities it relates to, category tags,
 * a title and a description.
 */
export interface TimelineEvent {
  id: string;
  /** ISO calendar date (YYYY-MM-DD). */
  date: string;
  entities: string[];
  tags: string[];
  title: string;
  description: string;
  /** Report the event was extracted from, when known. */
  sourceReportId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EventInput {
  /** Existing event to update; a new id is minted when absent. */
  id?: string;
  date: string;
  entities?: string[];
  tags?: string[];
  title: string;
  description?: string;
  sourceReportId?: string;
}

export interface EventFilter {
  ids?: string[];
  /** Inclusive ISO date bounds. */
  from?: string;
  to?: string;
  /** Events carrying any of these tags (case-insensitive). */
  tags?: string[];
  /** Events relating to any of these entities (case-insensitive). */
  entities?: string[];
  limit?: number;
}

/** Storage-agnostic event store; swap the implementation freely. */
export interface EventStore {
  list(filter?: EventFilter): TimelineEvent[];
  get(id: string): TimelineEvent;
  /** Inserts a new event, or updates one (absent fields keep their value). */
  upsert(input: EventInput): TimelineEvent;
  remove(id: string): TimelineEvent;
  count(): number;
  /** Distinct tags across stored events, most used first. */
  tags(): string[];
}

interface EventRow {
  id: string;
  date: string;
  entities: string;
  tags: string;
  title: string;
  description: string;
  source_report_id: string | null;
  created_at: number;
  updated_at: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class EventRepository implements EventStore {
  constructor(private readonly db: SqliteDatabase) {}

  list(filter: EventFilter = {}): TimelineEvent[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (filter.ids && filter.ids.length > 0) {
      conditions.push(`id IN (${filter.ids.map(() => "?").join(", ")})`);
      params.push(...filter.ids);
    }
    if (filter.from) {
      conditions.push("date >= ?");
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push("date <= ?");
      params.push(filter.to);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.raw
      .query<EventRow, string[]>(
        `SELECT * FROM timeline_events${where} ORDER BY date DESC, created_at ASC, id ASC`,
      )
      .all(...params);

    const wantedTags = filter.tags?.map((tag) => tag.toLowerCase());
    const wantedEntities = filter.entities?.map((entity) => entity.toLowerCase());
    let events = rows.map(toEvent);
    if (wantedTags && wantedTags.length > 0) {
      events = events.filter((event) =>
        event.tags.some((tag) => wantedTags.includes(tag.toLowerCase())),
      );
    }
    if (wantedEntities && wantedEntities.length > 0) {
      events = events.filter((event) =>
        event.entities.some((entity) => wantedEntities.includes(entity.toLowerCase())),
      );
    }
    return filter.limit !== undefined ? events.slice(0, filter.limit) : events;
  }

  get(id: string): TimelineEvent {
    const row = this.db.raw
      .query<EventRow, [string]>("SELECT * FROM timeline_events WHERE id = ?")
      .get(id);
    if (!row) throw new NotFoundError(`Event ${id} not found`);
    return toEvent(row);
  }

  upsert(input: EventInput): TimelineEvent {
    const date = input.date.trim();
    if (!DATE_PATTERN.test(date)) {
      throw new ValidationError(`Event date must be YYYY-MM-DD (got "${input.date}")`);
    }
    const title = input.title.trim();
    if (!title) throw new ValidationError("Event title is required");

    const now = Date.now();
    const existing = input.id ? this.get(input.id) : null;
    const event: TimelineEvent = {
      id: existing?.id ?? crypto.randomUUID(),
      date,
      entities:
        input.entities !== undefined ? normalizeList(input.entities) : existing?.entities ?? [],
      tags: input.tags !== undefined ? normalizeList(input.tags) : existing?.tags ?? [],
      title,
      description:
        input.description !== undefined ? input.description.trim() : existing?.description ?? "",
      sourceReportId: input.sourceReportId ?? existing?.sourceReportId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.db.raw
      .query(
        `INSERT INTO timeline_events
           (id, date, entities, tags, title, description, source_report_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           date = excluded.date,
           entities = excluded.entities,
           tags = excluded.tags,
           title = excluded.title,
           description = excluded.description,
           source_report_id = excluded.source_report_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        event.id,
        event.date,
        JSON.stringify(event.entities),
        JSON.stringify(event.tags),
        event.title,
        event.description,
        event.sourceReportId ?? null,
        event.createdAt,
        event.updatedAt,
      );

    return event;
  }

  remove(id: string): TimelineEvent {
    const event = this.get(id);
    this.db.raw.query("DELETE FROM timeline_events WHERE id = ?").run(id);
    return event;
  }

  count(): number {
    const row = this.db.raw
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM timeline_events")
      .get();
    return row?.n ?? 0;
  }

  tags(): string[] {
    const counts = new Map<string, { label: string; count: number }>();
    for (const event of this.list()) {
      for (const tag of event.tags) {
        const key = tag.toLowerCase();
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { label: tag, count: 1 });
      }
    }
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .map((entry) => entry.label);
  }
}

function toEvent(row: EventRow): TimelineEvent {
  return {
    id: row.id,
    date: row.date,
    entities: parseStringList(row.entities),
    tags: parseStringList(row.tags),
    title: row.title,
    description: row.description,
    sourceReportId: row.source_report_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStringList(value: string): string[] {
  const parsed = parseJsonValue<unknown>(value, []);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function normalizeList(values: string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}
