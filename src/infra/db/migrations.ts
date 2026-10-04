import type { Database as BunDatabaseType } from "bun:sqlite";
import { type ArtifactFileStore, MemoryArtifactFileStore } from "../files.ts";

export interface Migration {
  id: number;
  name: string;
  sql: string;
  /** Steps SQL cannot express (e.g. writing artifact payloads to files). */
  run?: (db: BunDatabaseType, files: ArtifactFileStore) => void;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "events",
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        seq            INTEGER PRIMARY KEY AUTOINCREMENT,
        id             TEXT NOT NULL UNIQUE,
        topic          TEXT NOT NULL,
        ts             INTEGER NOT NULL,
        source         TEXT NOT NULL,
        correlation_id TEXT,
        payload        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_topic ON events (topic);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
    `,
  },
  {
    id: 2,
    name: "contexts",
    sql: `
      CREATE TABLE IF NOT EXISTS contexts (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        settings    TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO contexts (id, name, description, settings, created_at, updated_at)
      VALUES ('default', 'Default', NULL, '{}', 0, 0);
    `,
  },
  {
    id: 3,
    name: "topics",
    sql: `
      CREATE TABLE IF NOT EXISTS topics (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT,
        muted       INTEGER NOT NULL DEFAULT 0,
        context_id  TEXT NOT NULL DEFAULT 'default',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_topics_context ON topics (context_id);
    `,
  },
  {
    id: 4,
    name: "scheduled_jobs",
    sql: `
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        cron         TEXT NOT NULL,
        timezone     TEXT,
        workflow     TEXT NOT NULL,
        context_id   TEXT NOT NULL DEFAULT 'default',
        input        TEXT NOT NULL DEFAULT '{}',
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        last_run_at  INTEGER,
        last_status  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_context ON scheduled_jobs (context_id);
    `,
  },
  {
    id: 5,
    name: "kv",
    sql: `
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: 6,
    name: "artifacts",
    sql: `
      CREATE TABLE IF NOT EXISTS artifacts (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        name           TEXT,
        content_type   TEXT NOT NULL,
        content        TEXT,
        data           BLOB,
        metadata       TEXT NOT NULL DEFAULT '{}',
        parent_id      TEXT,
        workflow       TEXT,
        correlation_id TEXT,
        context_id     TEXT NOT NULL DEFAULT 'default',
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_kind_created ON artifacts (kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artifacts_parent ON artifacts (parent_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_correlation ON artifacts (correlation_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_context ON artifacts (context_id);
    `,
  },
  {
    id: 7,
    name: "workflow_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id             TEXT PRIMARY KEY,
        workflow       TEXT NOT NULL,
        context_id     TEXT NOT NULL,
        trigger        TEXT NOT NULL,
        trigger_detail TEXT NOT NULL DEFAULT '{}',
        status         TEXT NOT NULL,
        input          TEXT NOT NULL DEFAULT '{}',
        output         TEXT,
        error          TEXT,
        started_at     INTEGER NOT NULL,
        finished_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_context_started ON workflow_runs (context_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs (workflow);
    `,
  },
  {
    id: 8,
    name: "workflow_run_cost",
    sql: `
      ALTER TABLE workflow_runs ADD COLUMN cost TEXT;
    `,
  },
  {
    id: 9,
    name: "status_entries",
    sql: `
      CREATE TABLE IF NOT EXISTS status_entries (
        id             TEXT PRIMARY KEY,
        activity_id    TEXT NOT NULL,
        correlation_id TEXT,
        parent_id      TEXT,
        text           TEXT NOT NULL,
        detail         TEXT,
        state          TEXT NOT NULL,
        cost_usd       REAL,
        started_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_status_correlation ON status_entries (correlation_id);
      CREATE INDEX IF NOT EXISTS idx_status_updated ON status_entries (updated_at DESC);
    `,
  },
  {
    id: 10,
    name: "workflow_run_checkpoint",
    sql: `
      ALTER TABLE workflow_runs ADD COLUMN checkpoint TEXT;
    `,
  },
  {
    id: 11,
    name: "delivery_channels",
    sql: `
      CREATE TABLE IF NOT EXISTS delivery_channels (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        name       TEXT NOT NULL,
        config     TEXT NOT NULL DEFAULT '{}',
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_delivery_channels (
        workflow   TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES delivery_channels(id) ON DELETE CASCADE,
        PRIMARY KEY (workflow, channel_id)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id         TEXT PRIMARY KEY,
        brief_id   TEXT NOT NULL,
        run_id     TEXT,
        channel_id TEXT NOT NULL,
        kind       TEXT NOT NULL,
        status     TEXT NOT NULL,
        event_id   TEXT,
        error      TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_brief ON deliveries (brief_id);
      CREATE INDEX IF NOT EXISTS idx_deliveries_run ON deliveries (run_id);
      CREATE INDEX IF NOT EXISTS idx_deliveries_channel ON deliveries (channel_id);
    `,
  },
  {
    id: 12,
    name: "user_workflows",
    sql: `
      CREATE TABLE IF NOT EXISTS user_workflows (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        topics     TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    // Briefs produced through a user workflow used to be stored with the
    // pipeline's id ("briefing") instead of the workflow that was run; the
    // run is the source of truth (delivery already resolved through it).
    id: 13,
    name: "repair_brief_workflow_attribution",
    sql: `
      UPDATE artifacts
      SET workflow = (
        SELECT workflow_runs.workflow
        FROM workflow_runs
        WHERE workflow_runs.id = artifacts.correlation_id
      )
      WHERE kind IN ('brief', 'audio')
        AND correlation_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM workflow_runs
          WHERE workflow_runs.id = artifacts.correlation_id
            AND workflow_runs.workflow IS NOT artifacts.workflow
        );
    `,
  },
  {
    // Delivery channels attach to a workflow step *output* (e.g. the brief's
    // text, the voice message), not to the workflow itself. Legacy rows keep
    // empty step/output until the kernel expands them onto the definition's
    // deliverable outputs at boot.
    id: 14,
    name: "delivery_step_targets",
    sql: `
      CREATE TABLE workflow_delivery_targets (
        workflow   TEXT NOT NULL,
        step       TEXT NOT NULL DEFAULT '',
        output     TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL REFERENCES delivery_channels(id) ON DELETE CASCADE,
        PRIMARY KEY (workflow, step, output, channel_id)
      );
      INSERT OR IGNORE INTO workflow_delivery_targets (workflow, step, output, channel_id)
        SELECT workflow, '', '', channel_id FROM workflow_delivery_channels;
      DROP TABLE workflow_delivery_channels;
      ALTER TABLE workflow_delivery_targets RENAME TO workflow_delivery_channels;
    `,
  },
  {
    // Workflow configuration moves from the fixed topic list to generic input
    // values keyed by input id (`{"topics": ["…"]}` for the topics input).
    id: 15,
    name: "user_workflow_inputs",
    sql: `
      ALTER TABLE user_workflows ADD COLUMN inputs TEXT NOT NULL DEFAULT '{}';
      UPDATE user_workflows
      SET inputs = CASE
        WHEN topics IS NOT NULL AND json_valid(topics) AND json_type(topics) = 'array'
          THEN json_object('topics', json(topics))
        ELSE '{}'
      END;
      ALTER TABLE user_workflows DROP COLUMN topics;
    `,
  },
  {
    // Dated events extracted from briefs (the `events` table is the event
    // log). Events are rows, not artifacts: a timeline artifact is composed
    // of a set of them.
    id: 16,
    name: "timeline_events",
    sql: `
      CREATE TABLE IF NOT EXISTS timeline_events (
        id              TEXT PRIMARY KEY,
        date            TEXT NOT NULL,
        time            TEXT,
        entities        TEXT NOT NULL DEFAULT '[]',
        tags            TEXT NOT NULL DEFAULT '[]',
        title           TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        source_brief_id TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_events_date ON timeline_events (date);
    `,
  },
  {
    // Accounts. The admin account owns the original database; every other
    // account gets its own database file under data/users/.
    id: 17,
    name: "users",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        display_name TEXT,
        created_at   INTEGER NOT NULL
      );
    `,
  },
  {
    // Workflows are no longer tied to a morning brief, so the shipped context
    // becomes a plain default. Renames the row and every reference to it.
    id: 18,
    name: "default_context",
    sql: `
      UPDATE contexts SET id = 'default', name = 'Default' WHERE id = 'morning-briefing';
      UPDATE topics SET context_id = 'default' WHERE context_id = 'morning-briefing';
      UPDATE scheduled_jobs SET context_id = 'default' WHERE context_id = 'morning-briefing';
      UPDATE artifacts SET context_id = 'default' WHERE context_id = 'morning-briefing';
      UPDATE workflow_runs SET context_id = 'default' WHERE context_id = 'morning-briefing';
    `,
  },
  {
    // Anonymous, read-only access to a single brief: the token in a delivery
    // link resolves to its brief without a session.
    id: 19,
    name: "brief_shares",
    sql: `
      CREATE TABLE IF NOT EXISTS brief_shares (
        token      TEXT PRIMARY KEY,
        brief_id   TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    // A user workflow can stop after a step: everything up to and including
    // it runs (and its outputs are delivered), later steps never start.
    id: 20,
    name: "user_workflow_stop_after",
    sql: `
      ALTER TABLE user_workflows ADD COLUMN stop_after TEXT;
    `,
  },
  {
    // Briefs become reports: a `report` container holding an ordered list of
    // artifacts. The brief's markdown moves into a `report-text` child; the
    // timeline and audio children are listed after it. Share tokens, delivery
    // rows and event attribution are renamed with the entity.
    id: 21,
    name: "reports",
    sql: `
      INSERT INTO artifacts (
        id, kind, name, content_type, content, metadata, parent_id,
        workflow, correlation_id, context_id, created_at
      )
      SELECT
        lower(hex(randomblob(16))),
        'report-text',
        name,
        content_type,
        content,
        json_object(
          'narration', COALESCE(json_extract(metadata, '$.narration'), ''),
          'sources', COALESCE(json_extract(metadata, '$.sources'), json('[]'))
        ),
        id,
        workflow,
        correlation_id,
        context_id,
        created_at
      FROM artifacts
      WHERE kind = 'brief';

      WITH children AS (
        SELECT parent_id AS report_id, json_group_array(id) AS ids
        FROM (
          SELECT parent_id, id,
                 CASE kind
                   WHEN 'timeline' THEN 0
                   WHEN 'audio' THEN 1
                   WHEN 'report-text' THEN 2
                   ELSE 3
                 END AS ord
          FROM artifacts
          WHERE parent_id IS NOT NULL
          ORDER BY ord, created_at
        )
        GROUP BY parent_id
      )
      UPDATE artifacts
      SET kind = 'report',
          content_type = 'application/json',
          content = NULL,
          metadata = json_object(
            'topics', COALESCE(json_extract(metadata, '$.topics'), json('[]')),
            'artifactIds', json(COALESCE(
              (SELECT ids FROM children WHERE children.report_id = artifacts.id),
              json('[]')
            ))
          )
      WHERE kind = 'brief';

      UPDATE artifacts
      SET metadata = json_set(
        json_remove(metadata, '$.briefId'),
        '$.reportId',
        json_extract(metadata, '$.briefId')
      )
      WHERE kind IN ('audio', 'timeline')
        AND json_extract(metadata, '$.briefId') IS NOT NULL;

      ALTER TABLE brief_shares RENAME TO report_shares;
      ALTER TABLE report_shares RENAME COLUMN brief_id TO report_id;

      ALTER TABLE deliveries RENAME COLUMN brief_id TO report_id;
      DROP INDEX IF EXISTS idx_deliveries_brief;
      CREATE INDEX IF NOT EXISTS idx_deliveries_report ON deliveries (report_id);

      ALTER TABLE timeline_events RENAME COLUMN source_brief_id TO source_report_id;

      UPDATE workflow_delivery_channels
      SET step = 'report', output = 'report'
      WHERE step = 'brief' AND output = 'brief';
      UPDATE user_workflows SET stop_after = 'report' WHERE stop_after = 'brief';
    `,
  },
  {
    // Some reports were converted by an earlier revision of migration 21 that
    // failed to fill in `artifactIds`. Rebuild the ordered list from the
    // artifacts that still point at the report as their parent.
    id: 22,
    name: "repair_report_artifact_ids",
    sql: `
      WITH children AS (
        SELECT parent_id AS report_id, json_group_array(id) AS ids
        FROM (
          SELECT parent_id, id,
                 CASE kind
                   WHEN 'timeline' THEN 0
                   WHEN 'audio' THEN 1
                   WHEN 'report-text' THEN 2
                   ELSE 3
                 END AS ord
          FROM artifacts
          WHERE parent_id IS NOT NULL
          ORDER BY ord, created_at
        )
        GROUP BY parent_id
      )
      UPDATE artifacts
      SET metadata = json_set(metadata, '$.artifactIds', json(COALESCE(
        (SELECT ids FROM children WHERE children.report_id = artifacts.id),
        json('[]')
      )))
      WHERE kind = 'report'
        AND json_array_length(metadata, '$.artifactIds') = 0;
    `,
  },
  {
    // Activity-feed entries distinguish coarse tasks from tool calls, so the
    // UI can render tool inputs/outputs (and code) as collapsible details.
    id: 23,
    name: "status_entry_kind",
    sql: `
      ALTER TABLE status_entries ADD COLUMN kind TEXT;
    `,
  },
  {
    // A report container never holds content: it references its artifacts
    // (a timeline, an audio file, the report-text primitive). Recreates the
    // report-text child for databases that ran the short-lived revision which
    // folded the text into the container.
    id: 25,
    name: "restore_report_text_artifacts",
    sql: `
      INSERT INTO artifacts (
        id, kind, name, content_type, content, metadata, parent_id,
        workflow, correlation_id, context_id, created_at
      )
      SELECT
        lower(hex(randomblob(16))),
        'report-text',
        name,
        content_type,
        content,
        json_object(
          'narration', COALESCE(json_extract(metadata, '$.narration'), ''),
          'sources', COALESCE(json_extract(metadata, '$.sources'), json('[]'))
        ),
        id,
        workflow,
        correlation_id,
        context_id,
        created_at
      FROM artifacts
      WHERE kind = 'report' AND content IS NOT NULL;

      UPDATE artifacts
      SET metadata = json_set(
            json_remove(metadata, '$.narration', '$.sources'),
            '$.artifactIds',
            json_insert(
              COALESCE(json_extract(metadata, '$.artifactIds'), json('[]')),
              '$[#]',
              (SELECT text.id FROM artifacts AS text
               WHERE text.parent_id = artifacts.id AND text.kind = 'report-text')
            )
          ),
          content = NULL,
          content_type = 'application/json'
      WHERE kind = 'report' AND content IS NOT NULL;
    `,
  },
  {
    // Artifacts become modular: the generic `artifacts` table keeps only the
    // registry (id, kind, name, content type, size, generic metadata, refs and
    // timestamps). Text payloads move to `artifact_texts`, binary payloads to
    // files, ordered references (report children, timeline events) to
    // `artifact_links`, and each kind's structured fields to its own table
    // (`report_texts`, `audio_artifacts`).
    id: 26,
    name: "modular_artifact_storage",
    sql: `
      ALTER TABLE artifacts ADD COLUMN byte_size INTEGER;

      CREATE TABLE artifact_texts (
        artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
        content     TEXT NOT NULL
      );
      INSERT INTO artifact_texts (artifact_id, content)
        SELECT id, content FROM artifacts WHERE content IS NOT NULL;

      CREATE TABLE artifact_links (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        target_kind TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        PRIMARY KEY (artifact_id, position)
      );
      INSERT INTO artifact_links (artifact_id, position, target_kind, target_id)
        SELECT a.id, CAST(link.key AS INTEGER), 'artifact', link.value
        FROM artifacts a, json_each(a.metadata, '$.artifactIds') AS link
        WHERE json_type(a.metadata, '$.artifactIds') = 'array';
      INSERT INTO artifact_links (artifact_id, position, target_kind, target_id)
        SELECT a.id, CAST(link.key AS INTEGER), 'event', link.value
        FROM artifacts a, json_each(a.metadata, '$.eventIds') AS link
        WHERE json_type(a.metadata, '$.eventIds') = 'array';

      CREATE TABLE report_texts (
        artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
        narration   TEXT NOT NULL DEFAULT '',
        sources     TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO report_texts (artifact_id, narration, sources)
        SELECT id,
               COALESCE(json_extract(metadata, '$.narration'), ''),
               COALESCE(json_extract(metadata, '$.sources'), json('[]'))
        FROM artifacts WHERE kind = 'report-text';

      CREATE TABLE audio_artifacts (
        artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
        duration_ms INTEGER
      );
      INSERT INTO audio_artifacts (artifact_id, duration_ms)
        SELECT id, json_extract(metadata, '$.durationMs')
        FROM artifacts WHERE kind = 'audio'
          AND json_extract(metadata, '$.durationMs') IS NOT NULL;

      UPDATE artifacts
        SET metadata = json_remove(
          metadata,
          '$.artifactIds', '$.eventIds', '$.narration', '$.sources',
          '$.durationMs', '$.reportId', '$.mime'
        );
    `,
    run: (db, files) => {
      const rows = db
        .query<{ id: string; data: Uint8Array }, []>(
          "SELECT id, data FROM artifacts WHERE data IS NOT NULL",
        )
        .all();
      for (const row of rows) {
        files.write(row.id, new Uint8Array(row.data));
        db.query("UPDATE artifacts SET byte_size = ? WHERE id = ?").run(
          row.data.byteLength,
          row.id,
        );
      }
      db.exec("ALTER TABLE artifacts DROP COLUMN content; ALTER TABLE artifacts DROP COLUMN data;");
    },
  },
  {
    // Events are dated, not timed: the calendar day is all the timeline needs.
    id: 27,
    name: "timeline_event_dates_only",
    sql: `
      ALTER TABLE timeline_events DROP COLUMN time;
    `,
  },
];

export function runMigrations(
  db: BunDatabaseType,
  files: ArtifactFileStore = new MemoryArtifactFileStore(),
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  // The old briefs table predates the artifacts schema. There is no upgrade
  // path: wipe the database instead of half-migrating.
  const legacy = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'briefs'",
    )
    .get();
  if (legacy) {
    throw new Error(
      "This database predates the artifacts schema. Delete the database file and start fresh.",
    );
  }

  const applied = new Set(
    db
      .query<{ id: number }, []>("SELECT id FROM _migrations")
      .all()
      .map((row) => row.id),
  );
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      migration.run?.(db, files);
      db.query("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        Date.now(),
      );
    });

    apply();
  }
}
