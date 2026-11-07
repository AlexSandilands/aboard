import { toastManager } from "~/components/ui/toast";

/**
 * "Ask an agent to fix": copies a prompt that hands an agent what went wrong, for the user to paste into a session of
 * their choice. Nothing starts by itself.
 */
export async function copyFixPrompt(prompt: string, done = "Prompt copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(prompt);
    toastManager.add({
      type: "success",
      title: done,
      description: "Paste it into an agent session (Claude Code, Codex or T3 Code) to have it look into the failures.",
    });
  } catch {
    toastManager.add({ type: "error", title: "Couldn't copy the prompt" });
  }
}
