import type { SearchMedia } from "../../capabilities/search/SearchProvider.ts";
import { NotFoundError } from "../../core/errors.ts";
import { numberField, stringField } from "../../core/records.ts";
import type { Artifact, ArtifactStore } from "../artifacts/ArtifactRepository.ts";
import type { ReportShareStore } from "./ReportShareRepository.ts";

export interface ReportSource {
  title: string;
  url: string;
  provider: string;
  /** Short excerpt, e.g. the text of a social post. */
  snippet?: string;
  /** Attached media (Bluesky images / video thumbnails). */
  media?: SearchMedia[];
}

/**
 * A report as stored: a `report` artifact holding an ordered list of other
 * artifacts (its text, a timeline, audio, anything a workflow attaches). The
 * text is a `report-text` artifact with the markdown plus narration/sources in
 * metadata; derived fields below expose it directly for convenience.
 */
export interface Report {
  id: string;
  /** Id of the underlying artifact (the report's canonical reference). */
  artifactId: string;
  createdAt: number;
  correlationId?: string;
  workflow?: string;
  /** Context this report belongs to. */
  contextId: string;
  topics: string[];
  /** Attached artifacts in display order. */
  artifacts: Artifact[];
  /** The markdown text artifact, when the report has one. */
  textArtifact?: Artifact;
  markdown: string;
  narration: string;
  sources: ReportSource[];
  audioArtifactId?: string;
  audioMime?: string;
  audioDurationMs?: number;
  hasAudio: boolean;
}

export interface ReportWithAudio extends Report {
  audio?: Uint8Array;
}

export interface CreateReportInput {
  correlationId?: string;
  workflow?: string;
  contextId?: string;
  topics: string[];
  markdown: string;
  narration: string;
  sources: ReportSource[];
}

export const REPORT_KIND = "report";
export const REPORT_TEXT_KIND = "report-text";
const AUDIO_KIND = "audio";
const MARKDOWN_TYPE = "text/markdown";

/** Storage-agnostic report store; swap the implementation without touching consumers. */
export interface ReportStore {
  create(input: CreateReportInput): Report;
  /** Appends an artifact to the report's ordered list (idempotent). */
  attach(reportId: string, artifactId: string): Report;
  /** Sets the exact display order of the report's artifacts. */
  order(reportId: string, artifactIds: string[]): Report;
  /**
   * Stores speech as an audio artifact attached to the report and returns its
   * id; regenerating replaces the existing audio in place.
   */
  attachAudio(id: string, audio: Uint8Array, mimeType: string, durationMs?: number): string;
  get(id: string, includeAudio?: boolean): ReportWithAudio;
  getAudio(id: string): { audio: Uint8Array; mimeType: string } | null;
  list(limit?: number, contextId?: string): Report[];
  /** Searches earlier reports (text + topics); without a query returns the latest. */
  search(query: string | undefined, limit?: number, contextId?: string): Report[];
  latest(contextId?: string): Report | null;
  remove(id: string): Report;
  /**
   * Token for anonymous read-only access to the report, created on first use.
   * Undefined when no share store is wired (tests with stubbed stores).
   */
  shareToken(id: string): string | undefined;
  /** Resolves a share token to its report; null for unknown or deleted ones. */
  findByShareToken(token: string): Report | null;
  /** Drops the report's share token after a delete outside remove(). */
  forgetShare(id: string): void;
}

export class ReportRepository implements ReportStore {
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly shares?: ReportShareStore,
  ) {}

  create(input: CreateReportInput): Report {
    const report = this.artifacts.create({
      kind: REPORT_KIND,
      name: input.topics.join(", ") || undefined,
      contentType: "application/json",
      metadata: { topics: input.topics, artifactIds: [] },
      workflow: input.workflow,
      correlationId: input.correlationId,
      contextId: input.contextId,
    });
    const text = this.artifacts.create({
      kind: REPORT_TEXT_KIND,
      name: report.name ? `${report.name} (text)` : "report text",
      contentType: MARKDOWN_TYPE,
      content: input.markdown,
      metadata: { narration: input.narration, sources: input.sources },
      parentId: report.id,
      workflow: input.workflow,
      correlationId: input.correlationId,
      contextId: input.contextId,
    });
    this.artifacts.updateMetadata(report.id, { artifactIds: [text.id] });
    this.shares?.tokenFor(report.id);
    return this.get(report.id);
  }

  attach(reportId: string, artifactId: string): Report {
    const artifact = this.loadReportArtifact(reportId);
    const ids = stringArray(artifact.metadata.artifactIds);
    if (!ids.includes(artifactId)) {
      ids.push(artifactId);
      this.artifacts.updateMetadata(reportId, { artifactIds: ids });
    }
    return this.get(reportId);
  }

  order(reportId: string, artifactIds: string[]): Report {
    this.loadReportArtifact(reportId);
    this.artifacts.updateMetadata(reportId, { artifactIds });
    return this.get(reportId);
  }

  attachAudio(id: string, audio: Uint8Array, mimeType: string, durationMs?: number): string {
    const report = this.loadReportArtifact(id);
    const existing = this.audioArtifactId(report);
    const audioDuration = durationMs !== undefined ? { durationMs } : {};

    if (existing) {
      this.artifacts.replaceData(existing, audio, mimeType);
      if (durationMs !== undefined) this.artifacts.updateMetadata(existing, { durationMs });
      return existing;
    }

    const created = this.artifacts.create({
      kind: AUDIO_KIND,
      name: report.name ? `${report.name} (audio)` : "report audio",
      contentType: mimeType,
      data: audio,
      parentId: id,
      workflow: report.workflow,
      correlationId: report.correlationId,
      contextId: report.contextId,
      metadata: audioDuration,
    });
    this.attach(id, created.id);
    return created.id;
  }

  get(id: string, includeAudio = false): ReportWithAudio {
    const report: ReportWithAudio = toReport(this.loadReportArtifact(id), this.artifacts);
    if (includeAudio && report.audioArtifactId) {
      const audio = this.artifacts.get(report.audioArtifactId, { includeData: true });
      if (audio.data) report.audio = audio.data;
    }
    return report;
  }

  getAudio(id: string): { audio: Uint8Array; mimeType: string } | null {
    let artifact: Artifact;
    try {
      artifact = this.artifacts.get(id);
    } catch {
      return null;
    }
    if (artifact.kind !== REPORT_KIND) return null;

    const audioArtifactId = this.audioArtifactId(artifact);
    if (!audioArtifactId) return null;

    const audio = this.artifacts.get(audioArtifactId, { includeData: true });
    if (!audio.data) return null;
    return { audio: audio.data, mimeType: audio.contentType };
  }

  list(limit = 50, contextId?: string): Report[] {
    return this.artifacts
      .list({ kind: REPORT_KIND, contextId, limit })
      .map((artifact) => toReport(artifact, this.artifacts));
  }

  /**
   * Searches earlier reports by keyword. The query is split into terms and
   * every term is matched against the report's topics (container metadata) and
   * its text; reports matching more terms rank first. Without a query the
   * latest reports are returned.
   */
  search(query: string | undefined, limit = 3, contextId?: string): Report[] {
    const terms = searchTerms(query);
    if (terms.length === 0) return this.list(limit, contextId);

    const matches = new Map<string, { report: Report; terms: Set<string> }>();
    const record = (report: Report, term: string): void => {
      const entry = matches.get(report.id) ?? { report, terms: new Set<string>() };
      entry.terms.add(term);
      matches.set(report.id, entry);
    };

    for (const term of terms) {
      for (const artifact of this.artifacts.search(term, {
        kind: REPORT_KIND,
        contextId,
        limit: limit * 4,
      })) {
        record(toReport(artifact, this.artifacts), term);
      }
      // The markdown lives on the child text artifact, so match there too.
      for (const text of this.artifacts.search(term, {
        kind: REPORT_TEXT_KIND,
        contextId,
        limit: limit * 4,
      })) {
        if (!text.parentId) continue;
        try {
          record(this.get(text.parentId), term);
        } catch {
          // The parent report was removed; ignore the orphaned text.
        }
      }
    }

    return [...matches.values()]
      .sort(
        (a, b) => b.terms.size - a.terms.size || b.report.createdAt - a.report.createdAt,
      )
      .slice(0, limit)
      .map((entry) => entry.report);
  }

  latest(contextId?: string): Report | null {
    return this.list(1, contextId)[0] ?? null;
  }

  remove(id: string): Report {
    const report = this.get(id);
    this.artifacts.remove(id);
    this.shares?.remove(id);
    return report;
  }

  shareToken(id: string): string | undefined {
    return this.shares?.tokenFor(id);
  }

  findByShareToken(token: string): Report | null {
    const reportId = this.shares?.reportIdFor(token);
    if (!reportId) return null;
    try {
      return this.get(reportId);
    } catch {
      return null;
    }
  }

  forgetShare(id: string): void {
    this.shares?.remove(id);
  }

  private loadReportArtifact(id: string): Artifact {
    const artifact = this.artifacts.get(id);
    if (artifact.kind !== REPORT_KIND) throw new NotFoundError(`Report ${id} not found`);
    return artifact;
  }

  private audioArtifactId(report: Artifact): string | undefined {
    for (const childId of stringArray(report.metadata.artifactIds)) {
      try {
        if (this.artifacts.get(childId).kind === AUDIO_KIND) return childId;
      } catch {
        // Child removed; keep looking.
      }
    }
    return undefined;
  }
}

function toReport(artifact: Artifact, store: ArtifactStore): Report {
  const children: Artifact[] = [];
  for (const childId of stringArray(artifact.metadata.artifactIds)) {
    try {
      children.push(store.get(childId));
    } catch {
      // Child removed; skip it.
    }
  }
  // Older rows (or a list without explicit order) fall back to parent links.
  if (children.length === 0) {
    children.push(...orderReportArtifacts(store.list({ parentId: artifact.id })));
  }

  const text = children.find((child) => child.kind === REPORT_TEXT_KIND);
  const audio = children.find((child) => child.kind === AUDIO_KIND);
  return {
    id: artifact.id,
    artifactId: artifact.id,
    createdAt: artifact.createdAt,
    correlationId: artifact.correlationId,
    workflow: artifact.workflow,
    contextId: artifact.contextId,
    topics: stringArray(artifact.metadata.topics),
    artifacts: children,
    textArtifact: text,
    markdown: text?.content ?? "",
    narration: stringField(text?.metadata ?? {}, "narration") ?? "",
    sources: Array.isArray(text?.metadata.sources)
      ? (text.metadata.sources as ReportSource[])
      : [],
    audioArtifactId: audio?.id,
    audioMime: audio ? audio.contentType : undefined,
    audioDurationMs: audio ? numberField(audio.metadata, "durationMs") : undefined,
    hasAudio: Boolean(audio),
  };
}

/** Canonical display order: timeline, audio, text, then anything else. */
export function orderReportArtifacts(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort(
    (a, b) => kindRank(a.kind) - kindRank(b.kind) || a.createdAt - b.createdAt,
  );
}

function kindRank(kind: string): number {
  if (kind === "timeline") return 0;
  if (kind === AUDIO_KIND) return 1;
  if (kind === REPORT_TEXT_KIND) return 2;
  return 3;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Query words used for keyword matching; stopwords and one-letter terms drop. */
const SEARCH_STOPWORDS = new Set([
  "and", "are", "for", "from", "into", "not", "the", "that", "this", "was",
  "were", "with", "what", "when", "where", "which", "who", "why", "about",
]);

function searchTerms(query: string | undefined): string[] {
  if (!query) return [];
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2 && !SEARCH_STOPWORDS.has(term));
  return [...new Set(terms)];
}
