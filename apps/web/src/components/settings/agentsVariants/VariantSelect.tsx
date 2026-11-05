import { storageKey } from "@repo/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { AGENTS_VARIANTS, agentsVariant } from "./registry";

interface AgentsVariantState {
  variant: string | null;
  setVariant: (variant: string) => void;
}

/** The Agents design this viewer is looking at (task #97's comparison). */
export const useAgentsVariant = create<AgentsVariantState>()(
  persist((set) => ({ variant: null, setVariant: (variant) => set({ variant }) }), {
    name: storageKey("agents-variant"),
  }),
);

/** The dropdown at the top of Settings that switches the Agents design. */
export function AgentsVariantSelect() {
  const { variant, setVariant } = useAgentsVariant();
  const current = agentsVariant(variant);
  return (
    <Select
      items={AGENTS_VARIANTS.map((v) => ({ value: v.id, label: `${v.label} (${v.author})` }))}
      value={current.id}
      onValueChange={(value) => {
        if (typeof value === "string") setVariant(value);
      }}
    >
      <SelectTrigger size="sm" aria-label="Agents design" className="min-w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {AGENTS_VARIANTS.map((v) => (
          <SelectItem key={v.id} value={v.id}>
            {v.label} ({v.author})
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
