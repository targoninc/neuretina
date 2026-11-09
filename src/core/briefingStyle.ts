/**
 * One-click styles for the briefing compiler. A workflow stores the
 * instruction itself, so a saved workflow keeps its exact style even if a
 * preset is reworded later; the editor matches the text back to a preset by
 * value and falls back to "Custom".
 */
export interface BriefingStylePreset {
  id: string;
  name: string;
  /** One-line explanation shown under the preset picker. */
  summary: string;
  /** The style guide handed to the compiler. */
  instruction: string;
}

/** Longest accepted style description; keeps a run's prompt bounded. */
export const BRIEFING_STYLE_MAX_LENGTH = 1000;

export const BRIEFING_STYLE_PRESETS: readonly BriefingStylePreset[] = [
  {
    id: "analyst",
    name: "Analyst",
    summary: "Measured and data-forward, leading with consequences and what to watch.",
    instruction:
      "Write like a sharp analyst note: measured and data-forward. Lead with the concrete numbers and the business, market or policy consequence, then say what to watch next. Explain the so-what instead of retelling the news. Analysis means consequences and open questions, not opinions.",
  },
  {
    id: "executive",
    name: "Executive",
    summary: "Bottom line first, crisp and decision-oriented.",
    instruction:
      "Write for an executive skimming between meetings: the bottom line first, then only the context needed to act on it. Use crisp, declarative sentences and cut every aside, hedge and piece of background the reader can infer. One decisive fact or number per sentence beats three vague ones.",
  },
  {
    id: "casual",
    name: "Casual",
    summary: "Warm and conversational, like a smart friend catching you up.",
    instruction:
      "Write like a well-informed friend catching you up over coffee: warm, direct and conversational, with contractions and everyday words. Vary the sentence length and let a little personality into the phrasing, but never slip into hype, snark or opinion.",
  },
  {
    id: "deep-dive",
    name: "Deep dive",
    summary: "Explains the why: causes, context and how the pieces connect.",
    instruction:
      "Write an explanatory deep dive: spend the report on why this happened and how the pieces connect, not just what happened. Give the causal chain and the context that makes the development make sense, with concrete details. Keep it dense with insight, not long.",
  },
  {
    id: "skeptical",
    name: "Skeptical",
    summary: "Foregrounds what is unproven, who benefits and where the evidence is thin.",
    instruction:
      "Write with a healthy skeptical edge: foreground what is still unproven, who benefits from the claim, and where the evidence is thin or the incentives are misaligned. Ask the question a careful reader would ask. Stay fair: skepticism is scrutiny of evidence, not a verdict or a tone of contempt.",
  },
  {
    id: "plain-english",
    name: "Plain English",
    summary: "Jargon-free and simple, explaining terms as it goes.",
    instruction:
      "Write in plain English for a smart reader outside the field: short words, short sentences, and no jargon or acronyms unless you explain them the first time. If a technical term matters, define it in a few words rather than avoiding it.",
  },
];

const PRESETS_BY_INSTRUCTION = new Map(
  BRIEFING_STYLE_PRESETS.map((preset) => [preset.instruction, preset]),
);

/**
 * The preset whose instruction exactly matches a stored style, or "Custom"
 * for a hand-written description. Undefined means the default voice.
 */
export function briefingStyleName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return PRESETS_BY_INSTRUCTION.get(text)?.name ?? "Custom";
}
