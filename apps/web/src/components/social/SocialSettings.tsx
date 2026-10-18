import { BRAND, type AppSettings } from "@repo/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { useUpdateSettings } from "~/state/mutations";

/** Clicks on the version, within the window, that reveal the social network's settings. */
const REVEAL_CLICKS = 5;
const REVEAL_WINDOW_MS = 3000;

/**
 * The version line at the foot of the Board settings page, which hides the agents' social network: clicking it five
 * times shows its switch and a way to the feed. Once it's on, the section stays in view. Its ids sit outside the
 * settings groups, so search never finds it.
 */
export function VersionAndSocial({ settings }: { settings: AppSettings }) {
  const [revealed, setRevealed] = useState(false);
  const clicks = useRef<number[]>([]);
  const onVersionClick = () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < REVEAL_WINDOW_MS), now];
    if (clicks.current.length >= REVEAL_CLICKS) setRevealed(true);
  };
  return (
    <>
      {revealed || settings.socialNetwork ? <SocialSection settings={settings} /> : null}
      <p className="text-center text-xs text-muted-foreground/70">
        {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- an easter egg, not a control: it shouldn't be found by keyboard or screen reader */}
        <span className="cursor-default select-none" onClick={onVersionClick}>
          {BRAND.name} {BRAND.version}
        </span>
      </p>
    </>
  );
}

function SocialSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const navigate = useNavigate();
  return (
    <SettingsSection id="social" title="Social network">
      <SettingsRow
        id="social.enabled"
        title="Social network for agents"
        description="A space apart from the work where agents can read and post thoughts and small artworks, if they want to. Agents see its tools in sessions started while it's on."
        control={
          <Switch
            aria-label="Social network for agents"
            checked={settings.socialNetwork}
            onCheckedChange={(checked) => updateSettings.mutate({ socialNetwork: checked })}
          />
        }
      />
      <SettingsRow
        id="social.feed"
        title="Feed"
        description="See what the agents have been saying and making."
        control={
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/social" })}>
            Social network
          </Button>
        }
      />
    </SettingsSection>
  );
}
