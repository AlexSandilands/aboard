import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";

/**
 * The orange notice for an automation that runs a script (an action or an agent's check), as the allowed-tools one is
 * for tools: shown on import and in the editor, so the same words warn wherever a script is read or written.
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
