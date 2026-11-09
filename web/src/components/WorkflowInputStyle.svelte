<script lang="ts">
  import { Select } from "m3-svelte";
  import {
    BRIEFING_STYLE_MAX_LENGTH,
    BRIEFING_STYLE_PRESETS,
  } from "../../../src/core/briefingStyle.ts";
  import type { WorkflowInputEditorProps } from "../lib/workflowInputs";

  let { value, disabled = false, capped = true, onchange }: WorkflowInputEditorProps = $props();

  /** Sentinel for a hand-written description that matches no preset. */
  const CUSTOM = "__custom__";

  const text = $derived(typeof value === "string" ? value : "");
  const preset = $derived(
    BRIEFING_STYLE_PRESETS.find((entry) => entry.instruction === text.trim()),
  );
  const selected = $derived(preset?.id ?? (text.trim() ? CUSTOM : ""));
  const options = $derived([
    { text: "Default voice", value: "" },
    ...BRIEFING_STYLE_PRESETS.map((entry) => ({ text: entry.name, value: entry.id })),
    ...(selected === CUSTOM ? [{ text: "Custom", value: CUSTOM }] : []),
  ]);

  function pick(event: Event): void {
    const id = (event.currentTarget as HTMLSelectElement).value;
    if (id === CUSTOM) return;
    const entry = BRIEFING_STYLE_PRESETS.find((candidate) => candidate.id === id);
    onchange(entry?.instruction ?? "");
  }
</script>

<Select label="Preset" {options} value={selected} {disabled} onchange={pick} />

<p class="preset-summary">
  {preset
    ? preset.summary
    : "Pick a preset or describe the voice yourself — the text is handed to the compiler as the briefing's style."}
</p>

<textarea
  class="style-input"
  class:capped
  aria-label="Style description"
  placeholder="e.g. Measured and data-forward, with the business consequence first and what to watch next."
  maxlength={BRIEFING_STYLE_MAX_LENGTH}
  {disabled}
  spellcheck="true"
  value={text}
  oninput={(event) => onchange(event.currentTarget.value)}
></textarea>

<p class="character-count">{text.length} / {BRIEFING_STYLE_MAX_LENGTH}</p>

<style>
  .preset-summary {
    margin: 0;
    color: var(--m3c-on-surface-variant);
    font-size: var(--font-medium);
  }

  .style-input {
    box-sizing: border-box;
    width: 100%;
    min-height: 7rem;
    padding: var(--space-small) var(--space-medium);
    border: 1px solid var(--m3c-outline);
    border-radius: var(--m3-shape-small);
    background: transparent;
    color: var(--m3c-on-surface);
    font: inherit;
    font-size: var(--font-medium);
    line-height: 1.5;
    resize: vertical;
  }

  .style-input.capped {
    max-height: 12rem;
  }

  .style-input:focus-visible {
    outline: 2px solid var(--m3c-primary);
    outline-offset: 1px;
  }

  .style-input:disabled {
    opacity: 0.6;
  }

  .character-count {
    align-self: flex-end;
    margin: 0;
    color: var(--m3c-on-surface-variant);
    font-size: var(--font-small);
  }
</style>
