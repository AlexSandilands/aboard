import type { ReactNode } from "react";
import { InfoHover } from "~/components/settings/settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";

/** A labelled form row with an optional one-line hint under it and the rest behind an info button by the label. */
export function Field({
  label,
  hint,
  info,
  action,
  children,
}: {
  label: string;
  /** One short line (docs/reference/style.md); anything longer goes in `info`. */
  hint?: ReactNode;
  info?: ReactNode;
  /** A control on the label's row, at its end. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const title = (
    <span className="flex items-center gap-1 text-xs font-medium text-foreground/80">
      {label}
      {info ? <InfoHover label={`More about ${label}`}>{info}</InfoHover> : null}
    </span>
  );
  return (
    <div className="flex flex-col gap-1.5">
      {action ? (
        <div className="flex items-center justify-between gap-2">
          {title}
          {action}
        </div>
      ) : (
        title
      )}
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
