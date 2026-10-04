import type { ArtifactInfo } from "./api";

export function isReportContainer(artifact: ArtifactInfo): boolean {
  return artifact.kind === "report";
}
