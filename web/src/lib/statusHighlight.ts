import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";

// Code mode is TypeScript-flavoured JavaScript, and its grammar covers both.
hljs.registerLanguage("typescript", typescript);

/**
 * JavaScript highlighting for code-mode programs (highlight.js). The returned
 * HTML carries `hljs-*` classes, styled with the M3 theme in the activity view.
 */
export function highlightCode(code: string): string {
  return hljs.highlight(code, { language: "typescript", ignoreIllegals: true }).value;
}
