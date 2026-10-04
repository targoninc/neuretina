/** How timeline artifacts are laid out; shared by every timeline view. */
export type TimelineOrientation = "horizontal" | "vertical";

const STORAGE_KEY = "reports.timelineOrientation";

function readStoredOrientation(): TimelineOrientation {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  return stored === "horizontal" ? "horizontal" : "vertical";
}

class TimelinePrefs {
  orientation = $state<TimelineOrientation>(readStoredOrientation());

  setOrientation(orientation: TimelineOrientation): void {
    this.orientation = orientation;
    try {
      localStorage.setItem(STORAGE_KEY, orientation);
    } catch {}
  }
}

export const timelinePrefs = new TimelinePrefs();
