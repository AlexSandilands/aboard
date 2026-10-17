import { NOTIFICATION_KINDS, type AppSettings } from "@repo/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { SettingsLink, SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { desktopBridge } from "~/lib/desktopBridge";
import { useUpdateSettings } from "~/state/mutations";
import { useAutopilotOverview } from "~/state/queries";
import { describeQuietHours } from "./notifications.logic";

/** Settings → Notifications: which events are recorded, quiet hours, and the browser's permission. */
export function NotificationsSection({ settings }: { settings: AppSettings }) {
  const update = useUpdateSettings();
  const { kinds, muteInQuietHours } = settings.notifications;
  // Autopilot owns the window; this only reads it to say what the mute switch follows.
  const autopilot = useAutopilotOverview();
  return (
    <SettingsSection id="board.notifications.settings" title="Notifications">
      <SettingsRow
        id="board.notifications.popups"
        title="Pop-ups"
        description="An alert when something needs you and the board isn't in front of you. The inbox behind the bell keeps all of them."
        control={<PopupPermission />}
      />
      {NOTIFICATION_KINDS.map(({ kind, label, description }) => (
        <SettingsRow
          key={kind}
          id={`board.notifications.kind-${kind}`}
          title={label}
          description={description}
          control={
            <Switch
              aria-label={label}
              checked={kinds[kind]}
              onCheckedChange={(checked) => update.mutate({ notifications: { kinds: { [kind]: checked } } })}
            />
          }
        />
      ))}
      <SettingsRow
        id="board.notifications.mute-quiet-hours"
        title="Mute during quiet hours"
        description={
          <>
            No pop-up while quiet hours are on; they still land in the inbox.{" "}
            {autopilot.data ? `${describeQuietHours(autopilot.data.engine.quietHours)} ` : null}
            <SettingsLink to="autopilot.engine.quiet-hours">Set quiet hours</SettingsLink>
          </>
        }
        control={
          <Switch
            aria-label="Mute during quiet hours"
            checked={muteInQuietHours}
            onCheckedChange={(checked) => update.mutate({ notifications: { muteInQuietHours: checked } })}
          />
        }
      />
    </SettingsSection>
  );
}

/** The desktop app shows its own alerts; a browser has to be allowed first. */
function PopupPermission() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  if (desktopBridge()) return <span className="text-xs text-muted-foreground">Shown by the desktop app</span>;
  switch (permission) {
    case "granted":
      return <span className="text-xs text-muted-foreground">Allowed in this browser</span>;
    case "denied":
      return (
        <span className="max-w-56 text-xs text-muted-foreground">
          Blocked: allow them in the browser's site settings
        </span>
      );
    case "unsupported":
      return <span className="text-xs text-muted-foreground">This browser can't show them</span>;
    case "default":
      return (
        <Button size="sm" variant="outline" onClick={() => void Notification.requestPermission().then(setPermission)}>
          Allow in this browser
        </Button>
      );
  }
}
