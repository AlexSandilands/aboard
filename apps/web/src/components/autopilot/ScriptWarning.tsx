import { TriangleAlertIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

/**
 * The orange notice for an automation that runs a script (an action or an agent's check), as the allowed-tools one is
 * for tools: shown on import, on an agent's draft and for a check script, wherever code is read before it runs. The
 * builder's own command and script get the smaller RunsAsYouBadge below.
 */
export function ScriptWarning({ children }: { children?: ReactNode }) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle className="text-sm">This runs on your machine as you</AlertTitle>
      <AlertDescription>
        <p>
          A script can do anything you can, in the project&apos;s folder and with your logins: read files, call{" "}
          <code className="font-mono">gh</code> or <code className="font-mono">git</code>, even approve or merge pull
          requests as you.
        </p>
        <p>
          Text a script reads from GitHub (a comment, a slash command, a title) comes from anyone who can comment, so
          check who wrote it before acting on it.
        </p>
        {children}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The builder's small "Runs as you" pill beside the Details heading, for a command or a script being written here. Its
 * card opens on hover, on click or tap, and on keyboard focus; Esc closes it. Code someone else wrote gets the full
 * ScriptWarning instead (import, an agent's draft).
 */
export function RunsAsYouBadge({ kind }: { kind: "command" | "script" }) {
  const [open, setOpen] = useState(false);
  // Closing (Esc, or a click outside) hands focus back to the badge; it stays closed until focus leaves and comes back.
  const closedHere = useRef(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) closedHere.current = true;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        // Base UI opens on hover and click; keyboard focus opens it too, so it isn't hover-only. A mouse click also
        // focuses the trigger, so only a focus that shows a ring (the keyboard's) opens it here, or the click would close it.
        onFocus={(event) => {
          if (!closedHere.current && event.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
        onBlur={() => {
          closedHere.current = false;
        }}
        className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-full border border-warning/40 bg-warning/12 px-2 py-0.5 text-xs font-medium text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TriangleAlertIcon aria-hidden className="size-3" />
        Runs as you
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" className="max-w-80 text-xs leading-relaxed">
        <div className="space-y-2">
          <p className="font-medium text-foreground">Runs on your machine as you, with your logins.</p>
          <p className="text-muted-foreground">
            The {kind} can do anything you can in the project&apos;s folder: read files, run{" "}
            <code className="font-mono">gh</code> or <code className="font-mono">git</code>, approve or merge pull
            requests. Text from GitHub can come from anyone who can comment, so check who wrote it.
          </p>
          {kind === "command" ? (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Windows:</span> let the program read the variable itself
              rather than passing it as an argument. PowerShell doesn&apos;t escape the quotes in it, and npm and pnpm
              hand arguments to cmd.exe, so a task title could add a command.
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
