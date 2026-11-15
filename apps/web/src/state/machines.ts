import type {
  ConnectMachineInput,
  ConnectMachineResult,
  Machine,
  MachinesResponse,
  UpdateMachineInput,
} from "@repo/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toastManager } from "~/components/ui/toast";
import { api } from "~/lib/api";
import { queryKeys } from "./queries";

/*
 * The machines this board is connected to (Settings › Integrations › Machines). Every change publishes
 * `machines.changed`, and useBoardEvents refetches the list on it, so the mutations here don't touch its cache.
 */

const enc = encodeURIComponent;

export function useMachines() {
  return useQuery({
    queryKey: queryKeys.machines,
    queryFn: ({ signal }) => api<MachinesResponse>("/api/machines", { signal }),
  });
}

const failed = (title: string) => (error: unknown) =>
  toastManager.add({ type: "error", title, description: error instanceof Error ? error.message : String(error) });

/** Connects a machine. The add dialog shows a failure itself, so this raises no toast. */
export function useConnectMachine() {
  return useMutation({
    mutationFn: (input: ConnectMachineInput) =>
      api<ConnectMachineResult>("/api/machines", { method: "POST", body: input }),
  });
}

export function useDismissMachineInstall() {
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/machines/installs/${enc(id)}`, { method: "DELETE" }),
    onError: failed("Couldn't dismiss the install"),
  });
}

export function useUpdateMachine() {
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateMachineInput & { id: string }) =>
      api<Machine>(`/api/machines/${enc(id)}`, { method: "PATCH", body: input }),
    onError: failed("Couldn't save the machine"),
  });
}

export function useRemoveMachine() {
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/machines/${enc(id)}`, { method: "DELETE" }),
    onError: failed("Couldn't remove the machine"),
  });
}

/** Tries every route to the machine now. */
export function useCheckMachine() {
  return useMutation({
    mutationFn: (id: string) => api<Machine>(`/api/machines/${enc(id)}/check`, { method: "POST" }),
    onError: failed("Couldn't check the machine"),
  });
}

/** Pairs again with a machine that dropped this board. */
export function useRepairMachine() {
  return useMutation({
    mutationFn: ({ id, code }: { id: string; code: string }) =>
      api<Machine>(`/api/machines/${enc(id)}/pair`, { method: "POST", body: { code } }),
    onError: failed("Couldn't pair with the machine"),
  });
}

/** Asks the machine to update to this board's version; `now` doesn't wait for its runs. */
export function useRequestMachineUpdate() {
  return useMutation({
    mutationFn: ({ id, now }: { id: string; now: boolean }) =>
      api<Machine>(`/api/machines/${enc(id)}/update`, { method: "POST", body: { now } }),
    onError: failed("Couldn't ask the machine to update"),
  });
}
