import { AGENT_HARNESSES, AgentHarness } from "./agentSessions.ts";

// How an agent links the session or thread it runs in to a task, on every host. Everything code-built that tells agents
// this comes from here, and skills.test.ts ties the static skill files to it. See docs/features/agent-sessions.md.

/** One place an agent can find its own id, tried in the order listed. */
export type SelfLinkLookup =
  | { kind: "env"; name: string }
  | { kind: "tool"; host: string; name: string; note: string }
  | { kind: "context"; where: string };

export type SelfLinkHostId = AgentHarness | "t3-code";

export interface SelfLinkHost {
  id: SelfLinkHostId;
  label: string;
  lookups: readonly SelfLinkLookup[];
  /** The link call, with `<...>` where the agent fills in its own values. */
  call: (task: string | null, label: string) => string;
  /** What to try when the board refuses that call, before giving up. */
  ifRefused?: string;
}

// "task" stands for the argument itself, in a prompt that covers several tasks.
const taskArg = (task: string | null): string => (task === "task" ? "task, " : task ? `task: ${task}, ` : "");

const harnessHost = (harness: AgentHarness): SelfLinkHost => {
  const { label, idEnvVar } = AGENT_HARNESSES[harness];
  return {
    id: harness,
    label,
    lookups: [{ kind: "env", name: idEnvVar }],
    call: (task, sessionLabel) =>
      `link(${taskArg(task)}agentSession: {harness: "${harness}", sessionId: <$${idEnvVar}>, cwd: <your working directory>}, label: "${sessionLabel}")`,
  };
};

// T3 can run where the board doesn't detect it, or in another environment: the board then can't place a bare id, and
// only the explicit form, which it doesn't check, still links.
export const SELF_LINK_T3_REFUSED =
  "If the board refuses the bare id, call the T3 tool t3_environment_read and retry with link(t3Thread: {environmentId, threadId}).";

const T3_CODE_HOST: SelfLinkHost = {
  id: "t3-code",
  label: "T3 Code",
  lookups: [
    {
      kind: "tool",
      host: "T3",
      name: "t3_thread_configure",
      note: "call it with no arguments; threadId is in its result",
    },
    {
      kind: "context",
      where:
        "the T3 references attached to this conversation's messages, only one that identifies the thread you are running in, not a thread someone mentioned",
    },
  ],
  // A bare id is enough: the board adds the environment and checks the thread exists.
  call: (task) => `link(${taskArg(task)}value: "<thread id>")`,
  ifRefused: SELF_LINK_T3_REFUSED,
};

/**
 * Every host an agent can link itself from. A new CLI goes in AGENT_HARNESSES and reaches every text. Another kind of
 * host is one more entry here, which the reminder picks up; the prompt lines and the Missing links hint name T3 Code and
 * the CLIs, so they need it too.
 */
export const SELF_LINK_HOSTS: readonly SelfLinkHost[] = [T3_CODE_HOST, ...AgentHarness.options.map(harnessHost)];

const hostOf = (id: SelfLinkHostId): SelfLinkHost => SELF_LINK_HOSTS.find((host) => host.id === id)!;

export const SELF_LINK_WHEN =
  "Link your own session or thread when you create a task you will work on or start planning or implementing one, not when you only read, note, triage or move one.";

export const SELF_LINK_ENV_RULE = "Read only the variable named for your host; never list your environment.";

export const SELF_LINK_OTHER_HOST =
  'On a host not listed here, if your session or thread has a URL, link(value: "<url>", label: "<what this session does>").';

export const SELF_LINK_FAILED =
  "If nothing works, carry on with the work, say in your reply what you tried, and record the same with add_note; never guess an id or use request_attention for it.";

export const SELF_LINK_SUBAGENT =
  "A subagent shares its parent's session id, so only the main session links; a subagent must not.";

/** What a prompt says after its link lines: how to look, and what to do when nothing works. */
export const SELF_LINK_RULES = [SELF_LINK_ENV_RULE, SELF_LINK_OTHER_HOST, SELF_LINK_FAILED].join(" ");

const lookupText = (lookup: SelfLinkLookup): string => {
  switch (lookup.kind) {
    case "env":
      return `$${lookup.name}, read with your shell (echo $${lookup.name})`;
    case "tool":
      return `the ${lookup.host} tool ${lookup.name} (${lookup.note})`;
    case "context":
      return lookup.where;
  }
};

/** Where a host's id comes from, in the order to try: "A, else B". */
export const selfLinkLookups = (id: SelfLinkHostId): string => hostOf(id).lookups.map(lookupText).join(", else ");

export const selfLinkCall = (id: SelfLinkHostId, task: string | null, label: string): string =>
  hostOf(id).call(task, label);

/** One host's whole answer: the call and where its id comes from. */
export const selfLinkHostLine = (id: SelfLinkHostId, task: string | null, label: string): string => {
  const { label: host, ifRefused } = hostOf(id);
  return `${host}: ${selfLinkCall(id, task, label)}, with the id from ${selfLinkLookups(id)}.${ifRefused ? ` ${ifRefused}` : ""}`;
};

/** The hosts a caller could be on: T3 Code hosts the CLIs, so it stays listed, and an unknown client gets them all. */
export const selfLinkHostsFor = (harness: AgentHarness | null): readonly SelfLinkHostId[] =>
  harness ? ["t3-code", harness] : SELF_LINK_HOSTS.map((host) => host.id);

/** The reminder a result gives an agent starting work, a line each. A harness the board recognised narrows the hosts. */
export function selfLinkReminder(input: { task: string; label: string; harness: AgentHarness | null }): string[] {
  return [
    "Only if you are the one working on this task, and unless you were told the board linked you. Linking again is harmless, even if another session is already linked.",
    ...selfLinkHostsFor(input.harness).map((id) => selfLinkHostLine(id, input.task, input.label)),
    SELF_LINK_ENV_RULE,
    ...(input.harness ? [] : [SELF_LINK_OTHER_HOST]),
    SELF_LINK_FAILED,
    SELF_LINK_SUBAGENT,
  ];
}

/** The prompt line for T3 Code. `where` reads "to the task" or "to every task"; every task needs a task argument. */
export function t3ThreadLinkLine(where: string, everyTask = false): string {
  return `If you're running in T3 Code, link this thread ${where} with ${selfLinkCall("t3-code", everyTask ? "task" : null, "")}, the id from ${selfLinkLookups("t3-code")}. ${SELF_LINK_T3_REFUSED}`;
}

/** "A, B or C". */
export const orList = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

/** The prompt line for the CLIs, naming every harness and the variable its id is in. */
export function sessionLinkLine(input: { label: string; also?: boolean; everyTask?: boolean }): string {
  const hosts = AgentHarness.options.map((harness) => AGENT_HARNESSES[harness]);
  const own = input.everyTask ? "your own session to every task" : "your own session";
  const call = input.everyTask ? "link(task, agentSession: " : "link(agentSession: ";
  return (
    `In ${orList(hosts.map((h) => h.label))}, ${input.also ? "also " : ""}link ${own} with ${call}{harness, sessionId, cwd}, ` +
    `label: "${input.label}"), the id from ${orList(hosts.map((h) => `$${h.idEnvVar}`))}, so it can be reopened from the board ` +
    "under that name (unless you're told the board linked it for you)."
  );
}
