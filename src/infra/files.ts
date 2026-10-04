import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Binary payload storage for artifacts, addressed by artifact id. */
export interface ArtifactFileStore {
  write(id: string, data: Uint8Array): void;
  read(id: string): Uint8Array | null;
  remove(id: string): void;
}

/** Files next to the database, so a data directory stays self-contained. */
export class DiskArtifactFileStore implements ArtifactFileStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  private path(id: string): string {
    return join(this.root, id);
  }

  write(id: string, data: Uint8Array): void {
    writeFileSync(this.path(id), data);
  }

  read(id: string): Uint8Array | null {
    return existsSync(this.path(id)) ? new Uint8Array(readFileSync(this.path(id))) : null;
  }

  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }
}

/** Payloads that never leave memory; used by test databases. */
export class MemoryArtifactFileStore implements ArtifactFileStore {
  private readonly files = new Map<string, Uint8Array>();

  write(id: string, data: Uint8Array): void {
    this.files.set(id, data);
  }

  read(id: string): Uint8Array | null {
    return this.files.get(id) ?? null;
  }

  remove(id: string): void {
    this.files.delete(id);
  }
}
