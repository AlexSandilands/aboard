import type { ReactNode } from "react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";

/** A labelled form row with an optional hint under it. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
      {hint ? <span className="text-2xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** A select over a short list; "" stands for the unset choice. */
export function Choice<T extends string>({
  label,
  value,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  value: T | "";
  items: ReadonlyArray<{ value: T | ""; label: string }>;
  onChange: (value: T | "") => void;
  placeholder?: string;
}) {
  return (
    <Select<string>
      items={items as ReadonlyArray<{ value: string; label: string }>}
      value={value}
      onValueChange={(next) => onChange((next ?? "") as T | "")}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
