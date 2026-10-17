import { canFork, type AgentHarness } from "@repo/contracts";
import { CopyIcon, GitForkIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react";
import { ClaudeAI } from "~/components/handoff/providerIcons";
import { MenuItem } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import type { SessionLink } from "./sessions.logic";
import { copyResumeCommand } from "./useSessionActions";

/** The harness's mark: Claude's logo, or a terminal for Copilot CLI (no licensed mark to hand). */
export function HarnessIcon({ harness, className }: { harness: AgentHarness; className?: string }) {
  return harness === "claude-code" ? (
    <ClaudeAI aria-hidden className={cn("size-3.5 shrink-0", className)} />
  ) : (
    <TerminalIcon aria-hidden className={cn("size-3.5 shrink-0", className)} />
  );
}

/** Open, fork (where the harness can) and copy, shared by the card chip and the panel row. */
export function SessionMenuItems({
  link,
  onOpen,
  includeOpen = true,
}: {
  link: SessionLink;
  onOpen: (mode: "resume" | "fork") => void;
  includeOpen?: boolean;
}) {
  return (
    <>
      {includeOpen ? (
        <MenuItem onClick={() => onOpen("resume")}>
          <SquareTerminalIcon />
          Open in terminal
        </MenuItem>
      ) : null}
      {canFork(link.ref.harness) ? (
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
