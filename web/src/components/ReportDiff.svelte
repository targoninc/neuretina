<script lang="ts">
  import { Icon } from "m3-svelte";
  import iconSplit from "@ktibow/iconset-material-symbols/view-column-2";
  import iconUnified from "@ktibow/iconset-material-symbols/view-stream";
  import type { FileDiff } from "@pierre/diffs";

  type DiffStyle = "split" | "unified";

  interface Props {
    before: string;
    after: string;
  }

  let { before, after }: Props = $props();
  let wrapper = $state<HTMLElement | undefined>();
  let instance = $state<FileDiff | undefined>();
  let diffStyle = $state<DiffStyle>("split");
  let appliedStyle: DiffStyle = "split";

  $effect(() => {
    const beforeText = before;
    const afterText = after;
    const host = wrapper;
    if (!host) return;

    let cancelled = false;
    let created: FileDiff | undefined;

    void (async () => {
      const { FileDiff: FileDiffComponent } = await import("@pierre/diffs");
      if (cancelled) return;
      created = new FileDiffComponent({
        theme: { dark: "pierre-dark", light: "pierre-light" },
        themeType: "system",
        diffStyle: "split",
        diffIndicators: "bars",
        lineDiffType: "word-alt",
        hunkSeparators: "line-info",
        disableFileHeader: true,
        overflow: "wrap",
      });
      created.render({
        oldFile: { name: "report.md", contents: beforeText },
        newFile: { name: "report.md", contents: afterText },
        containerWrapper: host,
      });
      instance = created;
    })();

    return () => {
      cancelled = true;
      instance = undefined;
      created?.cleanUp();
    };
  });

  // Switching layouts updates the live instance (setOptions replaces options).
  $effect(() => {
    const next = diffStyle;
    const current = instance;
    if (!current || appliedStyle === next) return;
    appliedStyle = next;
    current.setOptions({ ...current.options, diffStyle: next });
    current.rerender();
  });
</script>

<div class="report-diff">
  <div class="diff-head">
    <span class="view-toggle" role="group" aria-label="Diff layout">
      <button
        type="button"
        class="view"
        class:active={diffStyle === "split"}
        aria-pressed={diffStyle === "split"}
        title="Split view"
        onclick={() => (diffStyle = "split")}
      >
        <Icon icon={iconSplit} size={16} />
      </button>
      <button
        type="button"
        class="view"
        class:active={diffStyle === "unified"}
        aria-pressed={diffStyle === "unified"}
        title="Unified view"
        onclick={() => (diffStyle = "unified")}
      >
        <Icon icon={iconUnified} size={16} />
      </button>
    </span>
  </div>
  <div class="diff-body" bind:this={wrapper}></div>
</div>

<style>
  .report-diff {
    border-radius: var(--m3-shape-small);
    overflow: hidden;
  }

  .diff-head {
    display: flex;
    justify-content: flex-end;
    padding: var(--space-small) var(--space-small) 0;
  }

  .view-toggle {
    display: inline-flex;
    gap: var(--space-small);
  }

  .view {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.7rem;
    height: 1.6rem;
    padding: 0;
    border: none;
    border-radius: var(--m3-shape-full);
    background: transparent;
    color: var(--m3c-on-surface-variant);
    cursor: pointer;
  }

  .view:hover {
    background-color: var(--m3c-surface-container-high);
  }

  .view.active {
    background-color: var(--m3c-tertiary-container);
    color: var(--m3c-on-tertiary-container);
  }

  .diff-body {
    max-height: 26rem;
    overflow: auto;
  }
</style>
