/**
 * Workflow ports carry values of a registered type. Every type is either a
 * primitive (`text`, `audio`, …) or a derivative of one: a `report` is a
 * `text` plus metadata (narration, sources, the stored artifact), a `tts`
 * voice message is an `audio` clip plus the text it was spoken from.
 *
 * Steps declare inputs by the type they accept, and any derivative of that
 * type satisfies the input — so a `tts` action takes `report`, `draft` or any
 * other text derivative, and actions compose across workflows.
 */
export interface PortMetadataField {
  /** Metadata key carried alongside the primitive value. */
  name: string;
  title: string;
  description?: string;
}

export interface PortType {
  /** Stable id used in port specs, e.g. "report", "tts". */
  id: string;
  title: string;
  description?: string;
  /** Primitive this type derives from; primitives themselves omit it. */
  base?: string;
  /** Extra metadata a value of this type carries besides its primitive. */
  metadata?: PortMetadataField[];
}

export const PORT_TYPES: readonly PortType[] = [
  { id: "text", title: "Text", description: "Plain text content." },
  { id: "audio", title: "Audio", description: "An audio clip." },
  { id: "topics", title: "Topics", description: "A list of topic ids." },
  { id: "sources", title: "Sources", description: "A list of research sources." },
  { id: "events", title: "Events", description: "A set of timeline events." },
  {
    id: "research",
    title: "Research notes",
    description: "Compact notes with attributions.",
    base: "text",
    metadata: [
      { name: "sources", title: "Sources" },
      { name: "queries", title: "Queries" },
      { name: "missingTopics", title: "Missing topics" },
    ],
  },
  {
    id: "draft",
    title: "Draft",
    base: "text",
    metadata: [{ name: "narration", title: "Narration" }],
  },
  {
    id: "implications",
    title: "Deepened report",
    description: "A report with follow-up findings woven into its topic sections.",
    base: "text",
    metadata: [{ name: "sources", title: "Sources" }],
  },
  {
    id: "report",
    title: "Report",
    base: "text",
    metadata: [
      { name: "narration", title: "Narration" },
      { name: "reference", title: "Stored artifact" },
      { name: "sources", title: "Sources" },
    ],
  },
  { id: "question", title: "Question", base: "text" },
  { id: "answer", title: "Answer", base: "text" },
  {
    id: "timeline",
    title: "Timeline",
    description: "A timeline composed of a set of events.",
    base: "text",
    metadata: [
      { name: "eventIds", title: "Events" },
      { name: "from", title: "From" },
      { name: "to", title: "To" },
      { name: "count", title: "Event count" },
    ],
  },
  {
    id: "tts",
    title: "Voice message",
    description: "The spoken form of a text value.",
    base: "audio",
    metadata: [
      { name: "source", title: "Source text" },
      { name: "text", title: "Spoken text" },
      { name: "mimeType", title: "MIME type" },
      { name: "durationMs", title: "Duration" },
    ],
  },
];

const TYPES_BY_ID = new Map(PORT_TYPES.map((type) => [type.id, type]));

export function portType(id: string): PortType | undefined {
  return TYPES_BY_ID.get(id);
}

/** True when `id` is `primitive` itself or derives from it through its base chain. */
export function derivesFrom(id: string, primitive: string): boolean {
  const seen = new Set<string>();
  let current = TYPES_BY_ID.get(id);
  while (current && !seen.has(current.id)) {
    if (current.id === primitive) return true;
    seen.add(current.id);
    current = current.base ? TYPES_BY_ID.get(current.base) : undefined;
  }
  return false;
}

/**
 * Value convention for text-derived ports: the core `text`, plus an optional
 * `narration` (spoken form) and `reference` (stored artifact id) and a
 * `metadata` bag with whatever else the producing step attached (sources,
 * queries, …). Consumers like TTS read any text derivative uniformly.
 */
export interface TextPortValue {
  text: string;
  narration?: string;
  reference?: string;
  metadata?: Record<string, unknown>;
}
