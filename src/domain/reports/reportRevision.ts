import { wordCount } from "../../core/text.ts";

/** Generic catch-all sections that must never replace topic sections. */
export const GENERIC_SECTION_HEADING =
  /^#{2,6}\s+(?:implications?|context|background|analysis|takeaways?|outlook|what (?:it|this) means|why it matters)\s*$/im;

/** True when the report contains a catch-all section instead of topic sections. */
export function hasGenericSection(markdown: string): boolean {
  return GENERIC_SECTION_HEADING.test(markdown);
}

/**
 * Removes catch-all sections from an old report before a model sees it, either
 * as a previous-briefing example or through the past-report tools, so the
 * retired shape is never imitated.
 */
export function stripGenericSections(markdown: string): string {
  const kept: string[] = [];
  let skipLevel: number | undefined;

  for (const line of markdown.split("\n")) {
    const heading = /^(#{1,6})\s+/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (skipLevel !== undefined && level <= skipLevel) skipLevel = undefined;
      if (GENERIC_SECTION_HEADING.test(line)) {
        skipLevel = level;
        continue;
      }
    }
    if (skipLevel === undefined) kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** How far a revised report may drift from the original's length. */
export interface RevisionLimits {
  /** Smallest share of the original word count the revision must keep. */
  minWordsRatio?: number;
  /** Largest share of the original word count, before `maxExtraWords`. */
  maxWordsRatio?: number;
  /** Extra words allowed on top of the ratio (for added material). */
  maxExtraWords?: number;
  /** Absolute ceiling for the revision, when it has its own budget. */
  maxWords?: number;
}

/**
 * Guards against mangled model rewrites: the revision must keep a comparable
 * length and may only cite numbers from the numbered source list.
 */
export function isAcceptableRevision(
  original: string,
  revised: string,
  sourceCount: number,
  limits: RevisionLimits = {},
): boolean {
  const revisedWords = wordCount(revised);
  const originalWords = wordCount(original);
  const minWordsRatio = limits.minWordsRatio ?? 0.5;
  const maxWordsRatio = limits.maxWordsRatio ?? 1.5;
  const maxExtraWords = limits.maxExtraWords ?? 20;
  const maxWords = limits.maxWords ?? Math.ceil(originalWords * maxWordsRatio) + maxExtraWords;

  if (revisedWords < Math.max(5, Math.ceil(originalWords * minWordsRatio))) return false;
  if (revisedWords > maxWords) return false;

  for (const match of revised.matchAll(/\[(\d+)\]/g)) {
    const number = Number(match[1]);
    if (number < 1 || number > sourceCount) return false;
  }
  return true;
}
