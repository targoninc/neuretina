import { Database as BunDatabase } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runMigrations } from "./migrations.ts";
import {
  type ArtifactFileStore,
  DiskArtifactFileStore,
  MemoryArtifactFileStore,
} from "../files.ts";

export class SqliteDatabase {
  readonly raw: BunDatabase;
  readonly path: string;
  /** Binary artifact payloads for this database (`:memory:` keeps them in RAM). */
  readonly artifactFiles: ArtifactFileStore;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.raw = new BunDatabase(path, { create: true });
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.artifactFiles =
      path === ":memory:"
        ? new MemoryArtifactFileStore()
        : new DiskArtifactFileStore(join(dirname(path), "artifacts"));
    runMigrations(this.raw, this.artifactFiles);
  }

  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }

  close(): void {
    this.raw.close();
  }
}
