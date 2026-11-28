import { BRAND, type DesktopRelease, type DesktopReleaseList, type GitHubRepository } from "@repo/contracts";
import {
  describeReleasesError,
  isNewerVersion,
  isReleaseVersion,
  parseGitHubReleases,
  releaseNotesUrl,
} from "./shell.logic.ts";

const FETCH_TIMEOUT_MS = 20_000;
/** GitHub's most per page; a year of weekly releases. Older ones stay on the release page. */
const PER_PAGE = 100;

export interface ReleaseFeedOptions {
  /** Where releases live; null (no GitHub `repository`) has none to read. */
  repo: GitHubRepository | null;
  /** The running version: later releases (not installed yet) are left out. */
  currentVersion: string;
  /** Electron's `net.fetch`, so the request goes through the system proxy like the rest of the app. */
  fetch: typeof globalThis.fetch;
}

/**
 * The published releases, for the release notes dialog: read from the GitHub releases API the first time they're
 * asked for, then kept for the rest of the run. A failure isn't kept, so opening the dialog again tries again.
 */
export class ReleaseFeed {
  private releases: DesktopRelease[] | null = null;
  private loading: Promise<DesktopReleaseList> | null = null;

  constructor(private readonly options: ReleaseFeedOptions) {}

  list(): Promise<DesktopReleaseList> {
    if (this.releases) return Promise.resolve({ ok: true, releases: this.releases });
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<DesktopReleaseList> {
    const { repo, currentVersion } = this.options;
    if (!repo) return { ok: false, error: "This build has no GitHub repository to read releases from.", url: null };
    try {
      const response = await this.options.fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=${PER_PAGE}`,
        {
          headers: { Accept: "application/vnd.github+json", "User-Agent": `${BRAND.id}-desktop` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      // 403 and 429 are GitHub's rate limit for unauthenticated requests: 60 an hour per address.
      if (response.status === 403 || response.status === 429) {
        throw new Error("GitHub's rate limit was reached. Try again in a while.");
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseGitHubReleases(await response.json());
      if (!parsed) throw new Error("GitHub's answer wasn't a list of releases.");
      // A build from source has no release version; it shows them all.
      const releases = isReleaseVersion(currentVersion)
        ? parsed.filter((release) => !isNewerVersion(release.version, currentVersion))
        : parsed;
      this.releases = releases;
      return { ok: true, releases };
    } catch (error) {
      console.warn(`[${BRAND.id}] releases:`, error instanceof Error ? error.message : error);
      return { ok: false, error: describeReleasesError(error), url: releaseNotesUrl(repo, null) };
    }
  }
}
