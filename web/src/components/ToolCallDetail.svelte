<script lang="ts">
  import {
    JsonView,
    collapseAllNested,
    darkStyles,
  } from "@humanspeak/svelte-json-view-lite";
  import type { StatusState } from "../lib/statusTypes";
  import {
    codeOf,
    formatStatusValue,
    parseToolDetail,
    reportRevision,
    restOfInput,
  } from "../lib/statusDetail";
  import { highlightCode } from "../lib/statusHighlight";
  import ReportDiff from "./ReportDiff.svelte";

  interface Props {
    detail?: string;
    status: StatusState;
  }

  let { detail, status }: Props = $props();

  // Running calls stay open so the code/IO can be watched live; finished ones
  // collapse by default, and an explicit toggle wins from then on.
  let userOpen = $state<boolean | null>(null);
  const open = $derived(userOpen ?? status !== "done");

  const parsed = $derived(parseToolDetail(detail));
  const revision = $derived(reportRevision(parsed));

  /** Objects and arrays get the collapsible tree; scalars stay plain text. */
  function isJsonContainer(value: unknown): value is Record<string, unknown> | unknown[] {
    return typeof value === "object" && value !== null;
  }

  // Keep every viewer slot from darkStyles but drop its container class, so
  // the M3 surface and the `--sjv-*` variables on `.json` theme the tree.
  const jsonStyles = { ...darkStyles, container: "" };
</script>

{#if parsed}
  <div class="io">
    <button type="button" class="io-summary" aria-expanded={open} onclick={() => (userOpen = !open)}>
      {revision ? "Report changes" : "Input & output"}
    </button>
    {#if open}
      {#if revision}
        <div class="section">
          <ReportDiff before={revision.before} after={revision.after} />
        </div>
      {:else if parsed.input !== undefined}
        {#if codeOf(parsed.input) !== null}
          <div class="section">
            <span class="label">code</span>
            <pre class="code">{@html highlightCode(codeOf(parsed.input) ?? "")}</pre>
          </div>
          {#if Object.keys(restOfInput(parsed.input)).length > 0}
            <div class="section">
              <span class="label">Input</span>
              {@render jsonBlock(restOfInput(parsed.input))}
            </div>
          {/if}
        {:else}
          <div class="section">
            <span class="label">Input</span>
            {@render jsonBlock(parsed.input)}
          </div>
        {/if}
      {/if}
      {#if parsed.error !== undefined}
        <div class="section">
          <span class="label">Error</span>
          <pre class="error">{parsed.error}</pre>
        </div>
      {:else if parsed.output !== undefined}
        <div class="section">
          <span class="label">Output</span>
          {@render jsonBlock(parsed.output)}
        </div>
      {/if}
    {/if}
  </div>
{:else if detail}
  <!-- Legacy details that are not valid JSON still collapse as raw text. -->
  <div class="io">
    <button type="button" class="io-summary" aria-expanded={open} onclick={() => (userOpen = !open)}>
      Raw detail
    </button>
    {#if open}
      <div class="section">
        <pre>{detail}</pre>
      </div>
    {/if}
  </div>
{/if}

{#snippet jsonBlock(value: unknown)}
  {#if isJsonContainer(value)}
    <div class="json">
      <JsonView
        data={value}
        style={jsonStyles}
        shouldExpandNode={collapseAllNested}
        clickToExpandNode
      />
    </div>
  {:else}
    <pre>{formatStatusValue(value)}</pre>
  {/if}
{/snippet}

<style>
  .io {
    border: 1px solid var(--m3c-outline-variant);
    border-radius: var(--m3-shape-small);
    background-color: var(--m3c-surface-container-lowest);
    overflow: hidden;
  }

  .io-summary {
    display: flex;
    align-items: center;
    gap: var(--space-small);
    width: 100%;
    padding: var(--space-small) var(--space-medium);
    border: none;
    background: transparent;
    color: var(--m3c-on-surface-variant);
    font: inherit;
    font-size: var(--font-medium);
    text-align: start;
    cursor: pointer;
    user-select: none;
  }

  .io-summary:hover {
    background-color: var(--m3c-surface-container-high);
  }

  .section {
    padding: 0 var(--space-medium) var(--space-small);
  }

  .label {
    display: block;
    margin-bottom: 2px;
    color: var(--m3c-on-surface-variant);
    font-size: var(--font-medium);
    font-weight: 600;
  }

  pre {
    margin: 0;
    max-height: 22rem;
    overflow: auto;
    padding: var(--space-small) var(--space-medium);
    border-radius: var(--m3-shape-small);
    background-color: var(--m3c-surface-container-high);
    font-size: var(--font-medium);
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  pre.code {
    background-color: var(--m3c-surface-container-highest);
    white-space: pre;
    overflow-wrap: normal;
  }

  /* Collapsible JSON tree, themed with the M3 surface and token colors. */
  .json {
    padding: var(--space-small) var(--space-medium);
    border-radius: var(--m3-shape-small);
    background-color: var(--m3c-surface-container-high);
    font-size: var(--font-medium);
    line-height: 1.3;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    --sjv-label: var(--m3c-on-surface);
    --sjv-punctuation: var(--m3c-on-surface-variant);
    --sjv-string: var(--m3c-tertiary);
    --sjv-number: var(--m3c-secondary);
    --sjv-boolean: var(--m3c-primary);
    --sjv-null: var(--m3c-error);
    --sjv-undefined: var(--m3c-error);
    --sjv-other: var(--m3c-primary);
    --sjv-expander: var(--m3c-on-surface-variant);
  }

  pre.error {
    color: var(--m3c-error);
  }
</style>
