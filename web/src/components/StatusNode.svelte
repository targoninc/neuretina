<script lang="ts">
  import { Icon } from "m3-svelte";
  import iconError from "@ktibow/iconset-material-symbols/error";
  import iconExpandMore from "@ktibow/iconset-material-symbols/expand-more";
  import iconTerminal from "@ktibow/iconset-material-symbols/terminal";
  import { clock } from "../lib/clock.svelte";
  import { formatDuration, formatUsd } from "../lib/format";
  import type { OrderedStatusEntry } from "../lib/statusOrder";
  import { parseToolDetail } from "../lib/statusDetail";
  import PulseDot from "./PulseDot.svelte";
  import StatusNode from "./StatusNode.svelte";
  import ToolCallDetail from "./ToolCallDetail.svelte";

  interface Props {
    entry: OrderedStatusEntry;
  }

  let { entry }: Props = $props();

  /**
   * Subactions follow the action's state until the user decides otherwise:
   * running (and failed, to surface errors) start expanded, done collapses by
   * default. An explicit toggle wins from then on.
   */
  let userOpen = $state<boolean | null>(null);
  const open = $derived(userOpen ?? entry.state !== "done");
  const hasChildren = $derived(entry.children.length > 0);

  // The whole line toggles the subactions; clicks inside the tool I/O panel
  // (its own expander, selectable code) must not collapse the branch.
  function onRowClick(event: MouseEvent): void {
    if (!hasChildren || (event.target as HTMLElement).closest(".io")) return;
    userOpen = !open;
  }

  function onRowKeydown(event: KeyboardEvent): void {
    if (!hasChildren) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if ((event.target as HTMLElement).closest(".io")) return;
    event.preventDefault();
    userOpen = !open;
  }

  /** Settled rows show their total time; running rows tick live. */
  const durationMs = $derived(
    entry.state === "running"
      ? clock.now - entry.startedAt
      : Math.max(0, entry.updatedAt - entry.startedAt),
  );
</script>

<div class="node">
  <div
    class="row"
    class:tool={entry.kind === "tool"}
    class:dim={entry.state !== "running"}
    class:failed={entry.state === "failed"}
    class:clickable={hasChildren}
    role={hasChildren ? "button" : undefined}
    tabindex={hasChildren ? 0 : undefined}
    aria-expanded={hasChildren ? open : undefined}
    title={hasChildren ? (open ? "Collapse subactions" : "Expand subactions") : undefined}
    onclick={onRowClick}
    onkeydown={onRowKeydown}
  >
    {#if entry.state !== "done"}
      <span class="icon">
        {#if entry.state === "running"}
          <PulseDot size={9} />
        {:else}
          <Icon icon={iconError} size={18} />
        {/if}
      </span>
    {/if}
    <span class="body">
      <span class="line">
        <!-- A disclosure chevron marks expandable actions; leaves get a dot. -->
        <span class="disclosure" aria-hidden="true">
          {#if hasChildren}
            <span class="chevron" class:open><Icon icon={iconExpandMore} size={16} /></span>
          {:else}
            <span class="leaf-dot"></span>
          {/if}
        </span>
        {#if entry.kind === "tool"}
          <span class="tool-icon"><Icon icon={iconTerminal} size={16} /></span>
        {/if}
        <span class="text">{entry.text}</span>
        {#if entry.kind !== "tool" && entry.detail && !parseToolDetail(entry.detail)}
          <span class="detail-inline">{entry.detail}</span>
        {/if}
      </span>

      {#if entry.kind === "tool" || parseToolDetail(entry.detail)}
        <ToolCallDetail detail={entry.detail} status={entry.state} />
      {/if}
    </span>
    {#if entry.costUsd && entry.costUsd > 0}
      <span class="cost">{formatUsd(entry.costUsd)}</span>
    {/if}
    <span class="duration" title={`Started ${new Date(entry.startedAt).toLocaleTimeString()}`}>
      {formatDuration(durationMs)}
    </span>
  </div>

  {#if hasChildren && open}
    <div class="sub">
      {#each entry.children as child (child.id)}
        <StatusNode entry={child} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .node {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .row {
    display: flex;
    gap: var(--space-small);
    align-items: flex-start;
    padding: var(--space-small);
    border-radius: var(--m3-shape-small);
  }

  .row.tool {
    background-color: var(--m3c-surface-container-low);
  }

  /* Dim settled rows, but keep their expanded tool details readable. */
  .row.dim .icon,
  .row.dim .line,
  .row.dim .duration,
  .row.dim .cost {
    opacity: 0.65;
  }

  .row.failed {
    color: var(--m3c-error);
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.5rem;
  }

  .body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-small);
  }

  .line {
    display: flex;
    align-items: center;
    gap: var(--space-small);
    min-width: 0;
    /* Same box as the state icon so both icons share a center line. */
    min-height: 1.5rem;
  }

  .disclosure {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 1rem;
    height: 1.5rem;
  }

  .chevron {
    display: inline-flex;
    color: var(--m3c-on-surface-variant);
    transition: transform 150ms;
    transform: rotate(-90deg);
  }

  .chevron.open {
    transform: rotate(0deg);
  }

  .leaf-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background-color: var(--m3c-outline-variant);
  }

  .row.clickable {
    cursor: pointer;
  }

  .row.clickable:hover {
    background-color: var(--m3c-surface-container-high);
  }

  .row.clickable:focus-visible {
    outline: 2px solid var(--m3c-primary);
    outline-offset: 1px;
  }

  .tool-icon {
    display: inline-flex;
    align-items: center;
    flex: none;
    color: var(--m3c-on-surface-variant);
  }

  .text {
    font-size: var(--font-medium);
    overflow-wrap: anywhere;
  }

  .row.tool .text {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .detail-inline {
    color: var(--m3c-on-surface-variant);
    font-size: var(--font-medium);
    overflow-wrap: anywhere;
  }

  .duration {
    margin-inline-start: auto;
    color: var(--m3c-on-surface-variant);
    font-size: var(--font-medium);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .cost {
    flex: none;
    color: var(--m3c-on-surface-variant);
    font-size: var(--font-medium);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    margin-inline-start: 0.5rem;
  }

  /* Indented subactions, nested recursively. */
  .sub {
    display: flex;
    flex-direction: column;
    /* Never let the parent flex column squash a nested section to nothing. */
    flex-shrink: 0;
    gap: 2px;
    margin-inline-start: 1.1rem;
    padding-inline-start: 0.5rem;
    border-inline-start: 1px solid var(--m3c-outline-variant);
  }
</style>
