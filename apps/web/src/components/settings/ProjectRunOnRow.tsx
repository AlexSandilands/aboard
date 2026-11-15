import { RUN_HERE, type Machine, type Project } from "@repo/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { SETTINGS_TEXT_WIDTH, SettingsRow } from "~/components/settings/settingsLayout";
import { machineOffline, machineUsable } from "~/components/task/runOn.logic";
import { useMachines } from "~/state/machines";
import { useUpdateProject } from "~/state/mutations";

const HERE = RUN_HERE;
const NO_MACHINES: Machine[] = [];

/**
 * Project settings › Runs on: the machine its tasks run on unless a task picks another
 * (docs/features/remote-machines.md#choosing-the-machine). Only once a machine is connected and the project has a
 * folder, a repository a machine can clone.
 */
export function ProjectRunOnRow({ project }: { project: Project }) {
  const machines = useMachines().data?.machines ?? NO_MACHINES;
  const updateProject = useUpdateProject();
  // As the task's own picker: only once a machine could take the project's tasks (canChooseRunOn).
  if (!machines.some(machineUsable) || !project.workspaceRoot) return null;
  const known = machines.some((m) => m.id === project.runOn);
  const value = known && project.runOn ? project.runOn : HERE;
  const items = [
    { value: HERE, label: "This machine", disabled: false },
    ...machines.map((machine) => ({
      value: machine.id,
      label: machineOffline(machine) ? `${machine.name} (can't be reached)` : machine.name,
      disabled: machineOffline(machine) && machine.id !== value,
    })),
  ];
  return (
    <SettingsRow
      id="project.general.run-on"
      title="Runs on"
      description="Where this project's tasks run unless a task picks another machine. Tasks that have started stay where they are."
      control={
        <Select
          items={items}
          value={value}
          onValueChange={(next) => {
            if (next === null || next === value) return;
            updateProject.mutate({
              id: project.id,
              runOn: next === HERE ? null : next,
            });
          }}
        >
          <SelectTrigger size="sm" className={SETTINGS_TEXT_WIDTH} aria-label="Runs on">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
