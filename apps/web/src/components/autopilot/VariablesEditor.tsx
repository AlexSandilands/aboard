import { AUTOMATION_VARIABLES_MAX, variableEnvName, type AutomationVariable } from "@repo/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  blankVariable,
  inheritedVariables,
  rowsToVariables,
  variablesChanged,
  type VariableRow,
} from "./variables.logic";

const toRows = (variables: readonly AutomationVariable[]): VariableRow[] => variables.map((v) => ({ ...v }));

export const variablesKey = (variables: readonly AutomationVariable[]): string => JSON.stringify(variables);

/**
 * Edits a list of automation variables: the board's, or a project's overrides of them (`inherited` is then the
 * board's, shown with what each override replaces and a way to override the rest). Saved with the Save button, so a
 * half-typed name doesn't reach the automations. Give it `key={variablesKey(variables)}` so a save (this window's or
 * another's) starts it again from what was saved.
 */
export function VariablesEditor({
  variables,
  inherited,
  saving,
  onSave,
  idPrefix,
}: {
  variables: readonly AutomationVariable[];
  inherited?: readonly AutomationVariable[];
  saving: boolean;
  onSave: (variables: AutomationVariable[]) => void;
  /** Names the fields, so the board's and a project's editor don't share labels. */
  idPrefix: string;
}) {
  const [rows, setRows] = useState<VariableRow[]>(() => toRows(variables));
  const [error, setError] = useState<string | null>(null);

  const patch = (index: number, next: Partial<VariableRow>) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...next } : row)));
  const changed = variablesChanged(rows, variables);
  const fromBoard = inherited ? inheritedVariables(inherited, rows) : [];
  const save = () => {
    const parsed = rowsToVariables(rows);
    if (!parsed.ok) return setError(parsed.error);
    setError(null);
    onSave(parsed.variables);
  };

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => {
        const replaces = inherited?.find((v) => v.name === row.name.trim());
        return (
          // oxlint-disable-next-line react/no-array-index-key -- rows are controlled and have no id of their own
          <div key={i} className="flex flex-col gap-1">
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2">
              <Input
                size="sm"
                font="mono"
                aria-label={`${idPrefix} variable ${i + 1} name`}
                value={row.name}
                placeholder="jira_key"
                onChange={(event) => patch(i, { name: event.currentTarget.value })}
              />
              <Input
                size="sm"
                aria-label={`${idPrefix} variable ${i + 1} value`}
                value={row.value}
                placeholder={replaces ? replaces.value || "(empty)" : "ABC"}
                onChange={(event) => patch(i, { value: event.currentTarget.value })}
              />
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                aria-label={`Remove ${row.name.trim() || `variable ${i + 1}`}`}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                <Trash2Icon />
              </Button>
            </div>
            <p className="text-2xs text-muted-foreground">
              {row.name.trim() ? (
                <>
                  <code className="font-mono">{`{{vars.${row.name.trim()}}}`}</code>, or{" "}
                  <code className="font-mono">{variableEnvName(row.name.trim())}</code> in a script
                </>
              ) : null}
              {replaces ? ` · overrides the board's ${replaces.value ? `"${replaces.value}"` : "empty value"}` : ""}
              {inherited && row.name.trim() && row.value.trim() === ""
                ? " · empty here, so automations that need it skip this project"
                : ""}
            </p>
          </div>
        );
      })}
      {fromBoard.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-foreground/70">From the board</span>
          {fromBoard.map((v) => (
            <div key={v.name} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate">
                <code className="font-mono">{v.name}</code>{" "}
                <span className="text-muted-foreground">= {v.value ? v.value : "(empty)"}</span>
              </span>
              <Button size="xs" variant="ghost" onClick={() => setRows([...rows, { name: v.name, value: v.value }])}>
                Override
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <div className="flex items-center gap-1.5">
        {rows.length < AUTOMATION_VARIABLES_MAX ? (
          <Button size="xs" variant="outline" onClick={() => setRows([...rows, blankVariable()])}>
            <PlusIcon />
            Add variable
          </Button>
        ) : null}
        {changed ? (
          <>
            <Button size="xs" disabled={saving} onClick={save}>
              Save
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setRows(toRows(variables))}>
              Reset
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The variables an action reads, each with the projects that have no value for it. */
export function VariableNeedsList({ needs }: { needs: ReadonlyArray<{ name: string; missingIn: string[] }> }) {
  return (
    <ul className="space-y-0.5 text-xs">
      {needs.map((need) => (
        <li key={need.name}>
          <code className="font-mono">{need.name}</code>{" "}
          <span className={need.missingIn.length > 0 ? "text-warning-foreground" : "text-muted-foreground"}>
            {need.missingIn.length > 0 ? `has no value in ${need.missingIn.join(", ")}` : "is set everywhere"}
          </span>
        </li>
      ))}
    </ul>
  );
}
