import { ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { useNow } from "~/hooks/useNow";
import { updateStatusView } from "./desktopUpdate.logic";
import { useDesktopUpdate, type DesktopUpdate } from "./useDesktopUpdate";

/** Settings → Board → Desktop app: the app's version and its updates. Only in the desktop shell. */
export function DesktopAppSection() {
  const update = useDesktopUpdate();
  if (!update) return null;
  return <DesktopAppRows update={update} />;
}

function DesktopAppRows({ update }: { update: DesktopUpdate }) {
  const { state } = update;
  // Keeps "Checked 12 minutes ago" current while the page is open.
  const now = useNow(60_000, state.status === "up-to-date");
  const view = updateStatusView(state, now.getTime());
  // Dev and sandbox shells, builds from source: nothing to check or install.
  const off = state.mode === "disabled";
  const { button } = view;
  const run = () => {
    if (button.action === "check") update.check();
    else if (button.action === "install") update.install();
    else if (button.action === "notes") update.openReleaseNotes();
  };
  return (
    <SettingsSection id="board.desktop.settings" title="Desktop app">
      <SettingsRow
        id="board.desktop.version"
        title={
          <>
            Version{" "}
            <span className="ms-1 font-mono text-xs font-normal text-muted-foreground">v{state.currentVersion}</span>
          </>
        }
        description={
          state.mode === "notice-only"
            ? "New versions come from the project's GitHub releases; this install is updated the way it was installed."
            : "Updates come from the project's GitHub releases and download in the background."
        }
        status={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {view.badge ? (
              <Badge variant={view.badge.tone} size="sm">
                {view.badge.label}
              </Badge>
            ) : null}
            {view.text ? <span>{view.text}</span> : null}
            {view.percent !== null ? (
              <>
                <span
                  role="progressbar"
                  aria-label="Download progress"
                  aria-valuenow={view.percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="inline-block h-1 w-32 overflow-hidden rounded-full bg-muted"
                >
                  <span className="block h-full bg-primary transition-[width]" style={{ width: `${view.percent}%` }} />
                </span>
                <span className="font-mono">{view.percent}%</span>
              </>
            ) : null}
          </div>
        }
        control={
          <>
            {state.status === "ready" ? (
              <Button size="sm" variant="ghost" onClick={update.openReleaseNotes}>
                Release notes
              </Button>
            ) : null}
            {off ? null : (
              <Button
                size="sm"
                variant={button.primary ? "default" : "outline"}
                disabled={button.action === null}
                onClick={run}
              >
                {button.action === "install" ? <RotateCwIcon /> : null}
                {button.action === "notes" ? <ExternalLinkIcon /> : null}
                {button.label}
              </Button>
            )}
          </>
        }
      />
      <SettingsRow
        id="board.desktop.auto-check"
        title="Check for updates automatically"
        description={
          state.mode === "notice-only"
            ? "Checks an hour apart for a new version. The tray menu has the same switch."
            : "Checks an hour apart and downloads new versions in the background. Nothing installs until you restart. The tray menu has the same switch."
        }
        control={
          <Switch
            aria-label="Check for updates automatically"
            checked={state.autoCheck && !off}
            disabled={off}
            onCheckedChange={update.setAutoCheck}
          />
        }
      />
    </SettingsSection>
  );
}
