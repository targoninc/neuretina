import { ValidationError } from "../../core/errors.ts";
import { languageBy } from "../../core/languages.ts";
import type { WorkflowInputKind } from "../../core/workflow/inputs.ts";

/**
 * Language as workflow context: the configured code pins the language every
 * artifact of the run is written in. An empty value means the configured
 * default language.
 */
export function createLanguageInputKind(): WorkflowInputKind<
  string | undefined,
  string | undefined
> {
  return {
    id: "language",
    title: "Language",
    context: true,

    parse(value, spec, _deps, { requireFilled }) {
      const code = normalize(value);
      if (code === undefined && requireFilled && spec.required) {
        throw new ValidationError(`"${spec.id}" must be a supported language`);
      }
      return code;
    },

    resolve(value) {
      if (typeof value !== "string" || !value.trim()) return undefined;
      return languageBy(value)?.code ?? value.trim();
    },
  };
}

/** Normalizes a stored value to an ISO 639-1 code; unknown names are rejected. */
function normalize(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ValidationError("A language must be a string");
  const language = languageBy(value);
  if (!language) throw new ValidationError(`Unsupported language "${value}"`);
  return language.code;
}
