export type StatusState = "running" | "done" | "failed";
/** Rendering hint: a coarse task/step, or one tool call with its I/O. */
export type StatusKind = "task" | "tool";

/**
 * Detail payload for a report-text revision; the activity view renders it as a
 * diff. Every step that revises the report records the change through this
 * helper so revisions read the same way.
 */
export function reportDiffDetail(before: string, after: string): string {
  return JSON.stringify({ reportDiff: { before, after } });
}

export interface StatusEntry {
  id: string;
  /** Groups entries that belong to the same running thing (parallel-safe). */
  activityId: string;
  correlationId?: string;
  /** Entry this one runs under (e.g. an agent step under its research span). */
  parentId?: string;
  text: string;
  /** Free text for tasks; JSON `{ input, output | error }` for tool calls. */
  detail?: string;
  kind?: StatusKind;
  state: StatusState;
  /** USD spent by this task, including its subtasks. */
  costUsd?: number;
  startedAt: number;
  updatedAt: number;
}

export type StatusMessage =
  | { type: "snapshot"; entries: StatusEntry[] }
  | { type: "entry"; entry: StatusEntry };

/** Persistence port for the status feed; the hub stays usable without one. */
export interface StatusStore {
  save(entry: StatusEntry): void;
  load(limit?: number): StatusEntry[];
  removeByCorrelation(correlationId: string): void;
}

export interface StatusHandle {
  readonly id: string;
  update(text: string, detail?: string): void;
  done(text?: string, detail?: string): void;
  failed(text?: string, detail?: string): void;
  /** Adds spend to this task; ancestors sum up their subtasks. */
  addCost(usd: number): void;
}

export interface BeginStatusOptions {
  correlationId?: string;
  parentId?: string;
  detail?: string;
  kind?: StatusKind;
}

export interface PushStatusOptions extends BeginStatusOptions {
  state?: StatusState;
  activityId?: string;
}

/**
 * In-memory, ephemeral status feed for the UI. Entries are appended in
 * chronological order (newest last), updated in place while a step runs, and
 * settled to done/failed. Everything is broadcast to subscribers (WebSocket
 * clients) and can be replayed as a snapshot on connect.
 */
export class StatusHub {
  private readonly entries = new Map<string, StatusEntry>();
  private readonly listeners = new Set<(message: StatusMessage) => void>();
  private readonly maxEntries: number;
  private readonly store?: StatusStore;

  constructor(options: { maxEntries?: number; store?: StatusStore } = {}) {
    // Every tool call is an entry now, so keep enough history for full runs.
    this.maxEntries = Math.max(10, options.maxEntries ?? 500);
    this.store = options.store;
  }

  begin(activityId: string, text: string, options: BeginStatusOptions = {}): StatusHandle {
    const entry = this.add(activityId, text, "running", options);
    return {
      id: entry.id,
      update: (nextText, detail) => this.settle(entry.id, "running", nextText, detail),
      done: (nextText, detail) => this.settle(entry.id, "done", nextText, detail),
      failed: (nextText, detail) => this.settle(entry.id, "failed", nextText, detail),
      addCost: (usd) => this.addCost(entry.id, usd),
    };
  }

  /** Adds an already-settled entry (e.g. derived from a bus event). */
  push(text: string, options: PushStatusOptions = {}): StatusEntry {
    return this.add(
      options.activityId ?? `misc:${crypto.randomUUID()}`,
      text,
      options.state ?? "done",
      options,
    );
  }

  /** Marks all running entries of a correlation as failed (e.g. run crashed). */
  failRunning(correlationId: string, detail?: string): void {
    for (const entry of this.entries.values()) {
      if (entry.state !== "running" || entry.correlationId !== correlationId) continue;
      this.settle(entry.id, "failed", undefined, detail);
    }
  }

  /**
   * Loads persisted entries after a restart. Running entries can never resume,
   * so they are shown (and persisted) as interrupted.
   */
  restore(entries: StatusEntry[]): void {
    for (const entry of entries) {
      if (entry.state === "running") {
        const interrupted: StatusEntry = {
          ...entry,
          state: "failed",
          detail: entry.detail
            ? `${entry.detail} · Interrupted by restart`
            : "Interrupted by restart",
          updatedAt: Date.now(),
        };
        this.entries.set(interrupted.id, interrupted);
        this.persist(interrupted);
      } else {
        this.entries.set(entry.id, { ...entry });
      }
    }
    this.trim();
  }

  /** Drops every entry of a run, in memory and in storage. */
  removeByCorrelation(correlationId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.correlationId === correlationId) this.entries.delete(id);
    }
    this.store?.removeByCorrelation(correlationId);
  }

  snapshot(): StatusEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  snapshotMessage(): StatusMessage {
    return { type: "snapshot", entries: this.snapshot() };
  }

  subscribe(listener: (message: StatusMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private add(
    activityId: string,
    text: string,
    state: StatusState,
    options: BeginStatusOptions,
  ): StatusEntry {
    const now = Date.now();
    const entry: StatusEntry = {
      id: crypto.randomUUID(),
      activityId,
      correlationId: options.correlationId,
      parentId: options.parentId,
      text,
      detail: options.detail,
      kind: options.kind,
      state,
      startedAt: now,
      updatedAt: now,
    };

    this.entries.set(entry.id, entry);
    this.persist(entry);
    this.trim();
    this.broadcast({ type: "entry", entry: { ...entry } });
    return entry;
  }

  private settle(
    id: string,
    state: StatusState,
    text: string | undefined,
    detail: string | undefined,
  ): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    if (text !== undefined) entry.text = text;
    if (detail !== undefined) entry.detail = detail;
    entry.state = state;
    entry.updatedAt = Date.now();

    this.persist(entry);
    this.broadcast({ type: "entry", entry: { ...entry } });
  }

  private addCost(id: string, usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;

    const seen = new Set<string>();
    let current = this.entries.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      current.costUsd = (current.costUsd ?? 0) + usd;
      this.persist(current);
      this.broadcast({ type: "entry", entry: { ...current } });
      current = current.parentId ? this.entries.get(current.parentId) : undefined;
    }
  }

  private persist(entry: StatusEntry): void {
    try {
      this.store?.save({ ...entry });
    } catch {
      // Persistence must never break the live feed.
    }
  }

  private trim(): void {
    if (this.entries.size <= this.maxEntries) return;

    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (entry.state === "running") continue;
      this.entries.delete(id);
    }
  }

  private broadcast(message: StatusMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // a broken listener must not break the feed
      }
    }
  }
}
