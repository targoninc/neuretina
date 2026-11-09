import { BRIEFING_STYLE_MAX_LENGTH } from "../../core/briefingStyle.ts";
import { ValidationError } from "../../core/errors.ts";
import type { WorkflowInputKind } from "../../core/workflow/inputs.ts";

/**
 * Free-form style guidance as workflow context: the compiler receives the
 * description verbatim. An empty value keeps the built-in briefing voice.
 */
export function createStyleInputKind(): WorkflowInputKind<string | undefined, string | undefined> {
  return {
    id: "style",
    title: "Style",
    context: true,

    parse(value, spec, _deps, { requireFilled }) {
      const style = normalize(value);
      if (style === undefined && requireFilled && spec.required) {
        throw new ValidationError(`"${spec.id}" must describe a style`);
      }
      return style;
    },

    resolve(value) {
      // A run resolves whatever was stored; validation happened on save.
      return textOf(value);
    },
  };
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalize(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError("A briefing style must be a string");
  const style = textOf(value);
  if (!style) return undefined;
  if (style.length > BRIEFING_STYLE_MAX_LENGTH) {
    throw new ValidationError(
      `A briefing style must be at most ${BRIEFING_STYLE_MAX_LENGTH} characters`,
    );
  }
  return style;
}
