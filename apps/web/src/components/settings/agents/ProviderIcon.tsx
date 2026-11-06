import type { ProviderId } from "@repo/contracts";
import { ClaudeAI, CopilotCli, OpenAI, T3Code } from "~/components/handoff/providerIcons";
import { cn } from "~/lib/utils";

/** A provider's mark, sized for the list and the dialog. */
export function ProviderIcon({ id, className }: { id: ProviderId; className?: string }) {
  const Icon = id === "t3-code" ? T3Code : id === "claude-code" ? ClaudeAI : id === "codex" ? OpenAI : CopilotCli;
  return <Icon aria-hidden className={cn("size-4 shrink-0", className)} />;
}
