import { useState, type ComponentProps } from "react";
import { Input } from "~/components/ui/input";

/** A text setting saved on blur or Enter, like the Jira base URL. */
export function BlurInput({
  value,
  onSave,
  ...props
}: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onBlur"> & {
  value: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <Input
      {...props}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onSave(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
