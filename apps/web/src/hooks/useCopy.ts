import { useState } from "react";
import { toastManager } from "~/components/ui/toast";

/** Copies text, flipping `copied` on for a moment; a failure says so in a toast ("Couldn't copy the <what>"). */
export function useCopy(what: string) {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toastManager.add({ type: "error", title: `Couldn't copy the ${what}` });
    }
  };
  return { copied, copy };
}
