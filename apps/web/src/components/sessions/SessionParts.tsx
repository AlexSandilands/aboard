import { canFork, type AgentHarness } from "@repo/contracts";
import { CopyIcon, GitForkIcon, SquareTerminalIcon } from "lucide-react";
import { ClaudeAI, CopilotCli, T3Code } from "~/components/handoff/providerIcons";
import { MenuItem } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { useAgentClis } from "~/state/queries";
import { harnessAvailable, type SessionLink } from "./sessions.logic";
import { copyResumeCommand } from "./useSessionActions";

/** The harness's mark: Claude's logo, or the stand-in Copilot mark. */
export function HarnessIcon({ harness, className }: { harness: AgentHarness; className?: string }) {
  const Icon = harness === "claude-code" ? ClaudeAI : CopilotCli;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />;
}

/** T3 Code's mark, sized like HarnessIcon. */
export function T3Icon({ className }: { className?: string }) {
  return <T3Code aria-hidden className={cn("size-3.5 shrink-0", className)} />;
}

/** Whether the harness's CLI can be started here: when it can't, a session can only be resumed by hand. */
export function useHarnessAvailable(harness: AgentHarness): boolean {
  return harnessAvailable(useAgentClis().data, harness);
}

/**
 * Open, fork (where the harness can) and copy, shared by the card chip and the panel row. Open and fork need the CLI
 * on this machine; copying the resume command doesn't.
 */
export function SessionMenuItems({
  link,
  onOpen,
  includeOpen = true,
}: {
  link: SessionLink;
  onOpen: (mode: "resume" | "fork") => void;
  includeOpen?: boolean;
}) {
  const available = useHarnessAvailable(link.ref.harness);
  return (
    <>
      {includeOpen && available ? (
        <MenuItem onClick={() => onOpen("resume")}>
          <SquareTerminalIcon />
          Open in terminal
        </MenuItem>
      ) : null}
      {available && canFork(link.ref.harness) ? (
        <MenuItem onClick={() => onOpen("fork")}>
          <GitForkIcon />
          Fork in terminal
        </MenuItem>
      ) : null}
      <MenuItem onClick={() => void copyResumeCommand(link.id)}>
        <CopyIcon />
        Copy resume command
      </MenuItem>
    </>
  );
}
