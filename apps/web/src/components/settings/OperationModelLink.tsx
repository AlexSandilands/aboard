import { OPERATIONS, type AppSettings, type OperationId } from "@repo/contracts";
import { resolvesTo } from "~/components/models/choicePicker.logic";
import { operationTarget } from "~/components/models/operations.logic";
import { SettingsLink, SettingsRow } from "./settingsLayout";

/**
 * Where an operation's model is set, beside the settings it belongs with: one line per operation saying what it runs
 * on now, linking to its row on the Models page, the one place the board-level choice lives.
 */
export function OperationModelLink({ ops, settings }: { ops: readonly OperationId[]; settings: AppSettings }) {
  return (
    <SettingsRow
      title={ops.length > 1 ? "Models" : "Model"}
      description={
        <span className="block space-y-0.5">
          {ops.map((op) => (
            <span key={op} className="block">
              {ops.length > 1 ? `${OPERATIONS[op].label}: ` : null}
              {resolvesTo(op, {}, settings).text.replace(/^Resolves to /, "")}{" "}
              <SettingsLink to={operationTarget(op)}>Change</SettingsLink>
            </span>
          ))}
        </span>
      }
    />
  );
}
