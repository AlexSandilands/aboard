import { Badge } from "~/components/ui/badge";

// What both launch dialogs show when a custom hand-off opened them (see docs/features/agent-handoff.md#custom-hand-offs).

/** Names the custom hand-off a launch dialog was opened from, beside its title. */
export function HandoffBadge({ name }: { name: string }) {
  return (
    <Badge variant="info" className="max-w-56 truncate font-medium">
      {name}
    </Badge>
  );
}

/** Says where the dialog's prompt, model and workspace came from, and that they can still be changed. */
export function HandoffNote({ name }: { name: string }) {
  return (
    <p className="mt-2 px-1 text-xs text-muted-foreground">
      The prompt, model and workspace came from the hand-off “{name}”. Change anything before sending.
    </p>
  );
}
