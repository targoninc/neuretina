<script lang="ts">
  import { Icon, TextFieldOutlined } from "m3-svelte";
  import iconClose from "@ktibow/iconset-material-symbols/close";
  import iconExpandMore from "@ktibow/iconset-material-symbols/expand-more";
  import iconOpenInNew from "@ktibow/iconset-material-symbols/open-in-new";
  import iconPlay from "@ktibow/iconset-material-symbols/play-arrow";
  import iconSearch from "@ktibow/iconset-material-symbols/search";
  import type { ReportSource } from "../lib/api";
  import {
    faviconUrl,
    filterSources,
    groupSourcesByDomain,
    providerLabel,
  } from "../lib/sources";

  interface Props {
    sources: ReportSource[];
    filter?: string;
    onfilter?: (value: string) => void;
  }

  let { sources, filter, onfilter }: Props = $props();

  let internalFilter = $state("");
  let open = $state(false);
  const value = $derived(filter ?? internalFilter);
  const filtered = $derived(filterSources(sources, value));
  const groups = $derived(groupSourcesByDomain(filtered));
  const filtering = $derived(value.trim().length > 0);
  const numbers = $derived(new Map(sources.map((source, index) => [source, index + 1])));

  $effect(() => {
    void sources;
    internalFilter = "";
  });

  // A filter (e.g. from the URL) only makes sense with the panel open.
  $effect(() => {
    if (filtering) open = true;
  });

  function setFilter(next: string): void {
    if (onfilter) onfilter(next);
    else internalFilter = next;
  }
</script>

{#if sources.length > 0}
  <details class="source-section" bind:open>
    <summary class="source-section-head">
      <h3>Sources</h3>
      <span class="total">{sources.length}</span>
      <span class="chevron"><Icon icon={iconExpandMore} size={18} /></span>
    </summary>

    <div class="source-section-body">
      <TextFieldOutlined
        label="Filter sources"
        leadingIcon={iconSearch}
        value={value}
        oninput={(event) => setFilter(event.currentTarget.value)}
        trailing={filtering ? { icon: iconClose, onclick: () => setFilter("") } : undefined}
      />
      {#if groups.length === 0}
        <p class="muted">No sources match "{value.trim()}".</p>
      {:else}
        <div class="source-groups">
          {#each groups as group (group.domain)}
            <details class="source-group" open={filtering}>
              <summary>
                <span class="monogram" aria-hidden="true">
                  <img
                    class="favicon"
                    src={faviconUrl(group.domain)}
                    alt=""
                    loading="lazy"
                    onerror={(event) => event.currentTarget.remove()}
                  />
                </span>
                <span class="domain">{group.domain}</span>
                <span class="count">{group.sources.length}</span>
                <span class="provider-tags">
                  {#each group.providers as provider (provider)}
                    <span class="provider-tag" data-provider={provider}>
                      {providerLabel(provider)}
                    </span>
                  {/each}
                </span>
                <span class="chevron"><Icon icon={iconExpandMore} size={18} /></span>
              </summary>
              <ul>
                {#each group.sources as source (numbers.get(source))}
                  <li class="source">
                    <a class="source-head" href={source.url} target="_blank" rel="noreferrer">
                      <span class="ref">{numbers.get(source)}</span>
                      <span class="title">{source.title}</span>
                      <span class="open" aria-hidden="true">
                        <Icon icon={iconOpenInNew} size={15} />
                      </span>
                    </a>
                    {#if source.provider === "bluesky" && source.snippet}
                      <p class="snippet">{source.snippet}</p>
                    {/if}
                    {#if source.media?.length}
                      <div class="media">
                        {#each source.media as item, index (item.thumbUrl + index)}
                          <a
                            class="media-item"
                            href={item.type === "video" ? source.url : item.fullUrl}
                            target="_blank"
                            rel="noreferrer"
                            title={item.alt ?? "Open media"}
                          >
                            <img
                              src={item.thumbUrl}
                              alt={item.alt ?? ""}
                              loading="lazy"
                              width={item.width}
                              height={item.height}
                              style={item.width && item.height
                                ? `aspect-ratio: ${item.width} / ${item.height};`
                                : ""}
                            />
                            {#if item.type === "video"}
                              <span class="play" aria-hidden="true">
                                <Icon icon={iconPlay} size={18} />
                              </span>
                            {/if}
                          </a>
                        {/each}
                      </div>
                    {/if}
                  </li>
                {/each}
              </ul>
            </details>
          {/each}
        </div>
      {/if}
    </div>
  </details>
{/if}

<style>
  .source-section {
    margin-top: var(--space-large);
    border: 1px solid var(--m3c-outline-variant);
    border-radius: var(--m3-shape-medium);
    background-color: var(--m3c-surface-container-low);
    overflow: hidden;
  }

  .source-section-head {
    display: flex;
    align-items: center;
    gap: var(--space-small);
    padding: var(--space-small) var(--space-medium);
    cursor: pointer;
    list-style: none;
    user-select: none;
  }

  .source-section-head::-webkit-details-marker {
    display: none;
  }

  .source-section-head:hover {
    background-color: var(--m3c-surface-container-high);
  }

  .source-section-head h3 {
    margin: 0;
    font-size: var(--font-medium);
    font-weight: 600;
  }

  .source-section-head .chevron {
    margin-left: auto;
  }

  .source-section[open] > .source-section-head .chevron {
    transform: rotate(180deg);
  }

  .source-section-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-small);
    padding: 0 var(--space-medium) var(--space-medium);
  }

  .total {
    padding: 0 var(--space-small);
    border-radius: var(--m3-shape-full);
    background-color: var(--m3c-surface-container-highest);
    color: var(--m3c-on-surface-variant);
    font-size: var(--font-small);
    line-height: 1.5;
  }

  .source-groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-small);
  }

  .source-group {
    border: 1px solid var(--m3c-outline-variant);
    border-radius: var(--m3-shape-medium);
    background-color: var(--m3c-surface-container-low);
    overflow: hidden;
  }

  .source-group summary {
    display: flex;
    align-items: center;
    gap: var(--space-small);
    padding: var(--space-small) var(--space-medium);
    cursor: pointer;
    list-style: none;
    user-select: none;
  }

  .source-group summary::-webkit-details-marker {
    display: none;
  }

  .source-group summary:hover {
    background-color: var(--m3c-surface-container-high);
  }

  .monogram {
    position: relative;
    flex: none;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: var(--m3-shape-full);
    background-color: var(--m3c-secondary-container);
    overflow: hidden;
  }

  .favicon {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: var(--space-small);
    box-sizing: border-box;
    border-radius: inherit;
    object-fit: contain;
  }

  .domain {
    font-weight: 600;
    font-size: var(--font-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    color: var(--m3c-on-surface-variant);
    font-size: var(--font-small);
  }

  .provider-tags {
    display: inline-flex;
    gap: var(--space-large);
    margin-left: auto;
  }

  .chevron {
    display: inline-flex;
    color: var(--m3c-on-surface-variant);
    transition: transform 150ms;
  }

  .source-group[open] .chevron {
    transform: rotate(180deg);
  }

  .source-group ul {
    display: flex;
    flex-direction: column;
    gap: var(--space-small);
    margin: 0;
    padding: 0 var(--space-small) var(--space-small);
    list-style: none;
  }

  .source {
    padding: var(--space-small) var(--space-small);
    border-radius: var(--m3-shape-small);
    background-color: var(--m3c-surface-container-highest);
  }

  .source:hover {
    background-color: var(--m3c-surface-container-high);
  }

  .source-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-small);
    color: var(--m3c-on-surface);
    text-decoration: none;
  }

  .ref {
    display: inline-grid;
    place-items: center;
    flex: none;
    min-width: 1.35em;
    height: 1.35em;
    padding: 0 0.25em;
    border-radius: var(--m3-shape-full);
    background-color: var(--m3c-tertiary-container);
    color: var(--m3c-on-tertiary-container);
    font-size: var(--font-small);
    font-weight: 600;
    line-height: 1;
  }

  .title {
    flex: 1;
    min-width: 0;
    font-size: var(--font-medium);
    line-height: 1.35;
  }

  .open {
    display: inline-flex;
    color: var(--m3c-on-surface-variant);
    opacity: 0;
    transition: opacity 120ms;
  }

  .source-head:hover .open,
  .source-head:focus-visible .open {
    opacity: 1;
  }

  .snippet {
    margin: 0 0 0;
    font-size: var(--font-medium);
    line-height: 1.45;
    color: var(--m3c-on-surface-variant);
    white-space: pre-wrap;
  }

  .media {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-large);
    margin-top: var(--space-small);
  }

  .media-item {
    position: relative;
    display: inline-flex;
    border-radius: var(--m3-shape-small);
    overflow: hidden;
  }

  .media img {
    display: block;
    height: 7rem;
    width: auto;
    max-width: 100%;
    object-fit: cover;
    background-color: var(--m3c-surface-container-highest);
  }

  .media-item:hover img {
    opacity: 0.9;
  }

  .play {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #fff;
    background-color: rgba(0, 0, 0, 0.25);
    pointer-events: none;
  }
</style>
