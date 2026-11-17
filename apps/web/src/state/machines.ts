import {
  HOSTED_RUNNER_PAIRING_PATH,
  HOSTED_RUNNER_PATH,
  type ConnectMachineInput,
  type ConnectMachineResult,
  type ConnectMachineT3Response,
  type HostedRunnerPairingCode,
  type HostedRunnerStatus,
  type UpdateHostedRunnerInput,
  type Machine,
  type MachinesResponse,
  type UpdateMachineInput,
} from "@repo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { toastManager } from "~/components/ui/toast";
import { ApiError, api } from "~/lib/api";
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

/**
 * Connects the machine's own T3 Code with a pairing link or token made there. The T3 part shows a failure itself, so
 * this raises no toast.
 */
export function useConnectMachineT3() {
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      api<ConnectMachineT3Response>(`/api/machines/${enc(id)}/t3/connect`, { method: "POST", body: { value } }),
  });
}

/**
 * A machine to open and bring into view on the Machines page, set by whatever sends the user there to do something
 * about it (connecting its T3 Code). The page clears it once shown.
 */
export const useMachineFocus = create<{ id: string | null; focus: (id: string | null) => void }>((set) => ({
  id: null,
  focus: (id) => set({ id }),
}));

// --- This board's own runner, for another board (docs/features/remote-machines.md#a-board-that-is-also-a-runner) ---

/** While the runner is on, the board pairing with it shows up without a reload: nothing publishes that here. */
const HOSTED_RUNNER_REFETCH_MS = 5_000;

export function useHostedRunner() {
  return useQuery({
    queryKey: queryKeys.hostedRunner,
    queryFn: ({ signal }) => api<HostedRunnerStatus>(HOSTED_RUNNER_PATH, { signal }),
    refetchInterval: (query) => (query.state.data?.enabled ? HOSTED_RUNNER_REFETCH_MS : false),
  });
}

export function useConfigureHostedRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateHostedRunnerInput) =>
      api<HostedRunnerStatus>(HOSTED_RUNNER_PATH, { method: "PATCH", body: input }),
    onSuccess: (status) => queryClient.setQueryData(queryKeys.hostedRunner, status),
    // A refusal over runs in flight is a question the section asks itself, with Stop anyway.
    onError: (error, input) =>
      error instanceof ApiError && error.code === "CONFLICT" && !input.force
        ? undefined
        : failed("Couldn't change whether other machines run tasks here")(error),
  });
}

/** A one-time code for another board; it is shown here once and never kept. */
export function useHostedRunnerPairingCode() {
  return useMutation({
    mutationFn: () => api<HostedRunnerPairingCode>(HOSTED_RUNNER_PAIRING_PATH, { method: "POST" }),
    onError: failed("Couldn't make a pairing code"),
  });
}

export function useUnpairHostedRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<HostedRunnerStatus>(HOSTED_RUNNER_PAIRING_PATH, { method: "DELETE" }),
    onSuccess: (status) => queryClient.setQueryData(queryKeys.hostedRunner, status),
    onError: failed("Couldn't unpair the board"),
  });
}
