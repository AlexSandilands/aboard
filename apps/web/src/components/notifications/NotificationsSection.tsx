import { NOTIFICATION_KINDS, type AppSettings, type AutopilotOverview } from "@repo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { api } from "~/lib/api";
import { desktopBridge } from "~/lib/desktopBridge";
import { useUpdateSettings } from "~/state/mutations";
import { describeQuietHours } from "./notifications.logic";

/** Settings → Notifications: which events are recorded, quiet hours, and the browser's permission. */
export function NotificationsSection({ settings }: { settings: AppSettings }) {
  const update = useUpdateSettings();
  const { kinds, muteInQuietHours } = settings.notifications;
  // Autopilot owns the window; this only reads it to say what the mute switch follows.
  const autopilot = useQuery({
    queryKey: ["autopilot", "overview"],
    queryFn: ({ signal }) => api<AutopilotOverview>("/api/autopilot", { signal }),
    staleTime: 0,
  });
  return (
    <SettingsSection title="Notifications">
      <SettingsRow
        title="Pop-ups"
        description="An alert when something needs you and the board isn't in front of you. The inbox behind the bell keeps all of them."
        control={<PopupPermission />}
      />
      {NOTIFICATION_KINDS.map(({ kind, label, description }) => (
        <SettingsRow
          key={kind}
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
        title="Mute during quiet hours"
        description={`No pop-up while quiet hours are on; they still land in the inbox. ${
          autopilot.data ? describeQuietHours(autopilot.data.engine.quietHours) : ""
        }`.trim()}
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
