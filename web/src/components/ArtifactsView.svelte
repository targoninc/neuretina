<script lang="ts">
  import { Icon, ListItem, TextFieldOutlined } from "m3-svelte";
  import iconCategory from "@ktibow/iconset-material-symbols/category";
  import iconSearch from "@ktibow/iconset-material-symbols/search";
  import { commands } from "../lib/commands";
  import { isReportContainer } from "../lib/artifacts";
  import type { ArtifactInfo } from "../lib/api";
  import { reportError } from "../lib/feedback";
  import { formatDateTime } from "../lib/format";
  import { useRefresh } from "../lib/refresh.svelte";
  import { paths, router } from "../lib/router.svelte";
  import ArtifactView from "./ArtifactView.svelte";
  import DataList from "./DataList.svelte";
  import Pane from "./Pane.svelte";

  let artifacts = $state<ArtifactInfo[]>([]);
  let selected = $state<ArtifactInfo | null>(null);
  let loading = $state(false);

  const route = $derived(router.current);
  const artifactId = $derived(route.segments[0] ?? null);

  // The search query lives in `?q=`; typing rewrites the current history entry.
  let query = $state(route.query.q ?? "");
  $effect(() => {
    const value = route.query.q ?? "";
    if (value !== query) query = value;
  });

  function setQuery(value: string): void {
    query = value;
    router.navigate(paths.artifacts(artifactId, { q: value.trim() || undefined }), {
      replace: true,
    });
  }

  async function loadList(): Promise<void> {
    loading = true;
    try {
      artifacts = (await commands.artifacts.search(query.trim() || undefined, { limit: 100 })).filter(
        (artifact) => !isReportContainer(artifact),
      );
    } catch (error) {
      reportError(error);
    } finally {
      loading = false;
    }
  }

  async function loadSelected(id: string): Promise<void> {
    try {
      const artifact = await commands.artifacts.get(id);
      if (artifactId !== id) return;
      selected = artifact;
    } catch (error) {
      reportError(error);
      if (artifactId === id) {
        router.navigate(paths.artifacts(undefined, { q: query.trim() || undefined }), {
          replace: true,
        });
      }
    }
  }

  // The URL owns the selection; search results are kept fresh on artifact events.
  $effect(() => {
    const id = artifactId;
    if (!id) {
      selected = null;
      return;
    }
    void loadSelected(id);
  });

  let debounce: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    void query;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void loadList(), 150);
    return () => {
      if (debounce) clearTimeout(debounce);
    };
  });

  useRefresh(["artifact."], async () => {
    await loadList();
    if (artifactId) await loadSelected(artifactId);
  });

  function supporting(artifact: ArtifactInfo): string {
    const parts = [artifact.kind, artifact.contentType, formatDateTime(artifact.createdAt)];
    if (artifact.workflow) parts.push(artifact.workflow);
    if (artifact.byteSize) parts.push(`${Math.max(1, Math.round(artifact.byteSize / 1024))} KB`);
    return parts.join(" · ");
  }
</script>

<Pane variant="list" title="Artifacts">
  <div class="filters">
    <TextFieldOutlined
      label="Search artifacts"
      leadingIcon={iconSearch}
      value={query}
      oninput={(event) => setQuery(event.currentTarget.value)}
    />
  </div>

  <DataList
    items={artifacts}
    empty={query.trim() ? `No artifacts match "${query.trim()}".` : "No artifacts yet."}
  >
    {#snippet children(artifact)}
      <div class="entry" class:selected={artifactId === artifact.id}>
        <ListItem
          onclick={() =>
            router.navigate(
              paths.artifacts(artifact.id, { q: query.trim() || undefined }),
            )}
          overline={artifact.kind}
          headline={artifact.name ?? artifact.id.slice(0, 8)}
          supporting={supporting(artifact)}
        >
          {#snippet leading()}
            <Icon icon={iconCategory} />
          {/snippet}
        </ListItem>
      </div>
    {/snippet}
  </DataList>
</Pane>

<Pane
  variant="detail"
  title={selected?.name ?? (selected ? selected.id.slice(0, 8) : "Artifact details")}
  subtitle={selected ? `${selected.kind} · ${selected.contentType}` : undefined}
>
  {#if selected}
    <ArtifactView
      artifact={selected}
      onremove={() =>
        router.navigate(paths.artifacts(undefined, { q: query.trim() || undefined }), {
          replace: true,
        })}
    />
  {:else}
    <p class="muted">
      {loading ? "Searching artifacts…" : "Select an artifact to open it, or search above."}
    </p>
  {/if}
</Pane>

<style>
</style>
