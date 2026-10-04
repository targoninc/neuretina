/**
 * Dev supervisor: restarts a fresh Bun process whenever a source file changes.
 *
 * `bun --watch` reloads in the same process and leaks directory descriptors
 * with every reload (oven-sh/bun#40907). Once the descriptor table crosses
 * macOS's OPEN_MAX (10240), piped `Bun.spawn` calls — code mode, TTS
 * conversion — start failing with EBADF. A new process per restart reclaims
 * the descriptors, so long editing sessions stay healthy.
 */
import { readdirSync, statSync, watch } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const entry = process.argv[2] ?? join("src", "index.ts");
const entryPath = resolve(root, entry);
const watchDir = dirname(entryPath);

/** Only actual source files restart the server; payloads and temp files never do. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".json"]);

function isSourceChange(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (/(^|\/)data(\/|$)/.test(normalized)) return false;
  if (/(^|\/)(node_modules|\.git|web\/dist)(\/|$)/.test(normalized)) return false;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!base || base.startsWith(".") || base.endsWith("~") || base.endsWith(".swp")) return false;
  if (base.endsWith(".test.ts") || base.endsWith(".spec.ts")) return false;
  return SOURCE_EXTENSIONS.has(extname(base).toLowerCase());
}

/**
 * File contents as `size:mtime`; watch events also fire on last-access updates
 * (enabled on some Windows setups), so only a changed fingerprint restarts.
 */
const fingerprints = new Map<string, string>();

function fingerprint(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

function seed(path: string): void {
  const value = fingerprint(path);
  if (value !== undefined) fingerprints.set(path, value);
}

function seedTree(dir: string): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && entry.name !== "node_modules") seedTree(full);
    } else if (isSourceChange(full)) {
      seed(full);
    }
  }
}

function contentChanged(path: string): boolean {
  const next = fingerprint(path);
  const previous = fingerprints.get(path);
  if (next === undefined) {
    fingerprints.delete(path);
    return previous !== undefined;
  }
  fingerprints.set(path, next);
  return previous !== undefined && previous !== next;
}

let child: Bun.Subprocess | undefined;
let restartTimer: ReturnType<typeof setTimeout> | undefined;

function start(): void {
  const proc = Bun.spawn({
    cmd: [process.execPath, entry],
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  child = proc;
  void proc.exited.then((code) => {
    if (child !== proc) return;
    child = undefined;
    if (code !== 0 && code !== null) console.error(`[dev] server exited with code ${code}`);
  });
}

function restart(reason: string): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    child?.kill();
    child = undefined;
    console.log(`[dev] ${reason}; restarting…`);
    start();
  }, 250);
}

seedTree(watchDir);
console.log(`[dev] watching ${watchDir}`);
watch(watchDir, { recursive: true }, (_event, filename) => {
  if (!filename || !isSourceChange(filename)) return;
  const full = resolve(watchDir, filename);
  if (!contentChanged(full)) return;
  restart(`source changed (${filename})`);
});

const envPath = join(root, ".env");
seed(envPath);
try {
  watch(envPath, () => {
    const next = fingerprint(envPath);
    if (fingerprints.get(envPath) === next) return;
    if (next === undefined) fingerprints.delete(envPath);
    else fingerprints.set(envPath, next);
    restart(".env changed");
  });
} catch {
  // No .env file; the environment comes from the shell.
}

start();
