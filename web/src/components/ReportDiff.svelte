<script lang="ts">
  import type { FileDiff } from "@pierre/diffs";

  interface Props {
    before: string;
    after: string;
  }

  let { before, after }: Props = $props();
  let wrapper = $state<HTMLElement | undefined>();

  $effect(() => {
    const beforeText = before;
    const afterText = after;
    const host = wrapper;
    if (!host) return;

    let cancelled = false;
    let instance: FileDiff | undefined;

    void (async () => {
      const { FileDiff: FileDiffComponent } = await import("@pierre/diffs");
      if (cancelled) return;
      instance = new FileDiffComponent({
        theme: { dark: "pierre-dark", light: "pierre-light" },
        themeType: "system",
        diffStyle: "unified",
        diffIndicators: "bars",
        lineDiffType: "word-alt",
        hunkSeparators: "line-info",
        disableFileHeader: true,
        overflow: "wrap",
      });
      instance.render({
        oldFile: { name: "report.md", contents: beforeText },
        newFile: { name: "report.md", contents: afterText },
        containerWrapper: host,
      });
    })();

    return () => {
      cancelled = true;
      instance?.cleanUp();
    };
  });
</script>

<div class="report-diff" bind:this={wrapper}></div>

<style>
  .report-diff {
    max-height: 28rem;
    overflow: auto;
    border-radius: var(--m3-shape-small);
  }
</style>
