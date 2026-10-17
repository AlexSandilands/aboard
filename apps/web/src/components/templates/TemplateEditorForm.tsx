import { MODEL_TIERS, TEMPLATE_NAME_MAX, TEMPLATE_PLACEHOLDERS, type ModelTier } from "@repo/contracts";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { OutlineEditor } from "~/components/task/PlanEditor";
import { nextOutlineKey } from "~/components/task/plan.logic";
import { EditorFooter, EditorHeader, EditorPanel, EditorTitle } from "~/components/settings/EditorFrame";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { useCreateTemplate, useUpdateTemplate } from "~/state/mutations";
import { useBoard } from "~/state/queries";
import { formToInput, type TemplateForm } from "./templates.logic";

const ALL_PROJECTS = "all";
const NO_TIER = "none";

const TIER_ITEMS = [
  { value: NO_TIER, label: "None" },
  ...MODEL_TIERS.map((tier) => ({ value: tier.value, label: tier.label })),
];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
      {hint ? <span className="text-2xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/**
 * The body of the template editor: a header, the fields with a plan outline, and Save. It sits in its own dialog
 * (Save as template) or on a settings sub-page (see EditorFrame). `templateId` is null for a new template. `onDone` runs after a save, `onCancel` on Cancel.
 */
export function TemplateEditorForm({
  templateId,
  initial,
  onDone,
  onCancel,
}: {
  templateId: string | null;
  initial: TemplateForm;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const board = useBoard();
  const projects = (board.data?.projects ?? []).filter((p) => p.archivedAt === null || p.id === form.projectId);
  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const pending = create.isPending || update.isPending;
  const patch = (next: Partial<TemplateForm>) => setForm((current) => ({ ...current, ...next }));

  const scopeItems = [
    { value: ALL_PROJECTS, label: "All projects" },
    ...projects.map((p) => ({ value: p.id, label: p.title })),
  ];

  const save = () => {
    const result = formToInput(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    const done = { onSuccess: onDone };
    if (templateId) update.mutate({ id: templateId, ...result.input }, done);
    else create.mutate(result.input, done);
  };

  return (
    <>
      <EditorHeader>
        <EditorTitle>{templateId ? "Edit template" : "New template"}</EditorTitle>
        <p className="text-sm text-muted-foreground">
          A starting point for new tasks. Creating a task copies it, so editing a template later doesn&apos;t change
          tasks already made from it.
        </p>
      </EditorHeader>
      <EditorPanel className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input
              autoFocus
              size="sm"
              aria-label="Template name"
              maxLength={TEMPLATE_NAME_MAX}
              value={form.name}
              placeholder="Bug"
              onChange={(event) => patch({ name: event.currentTarget.value })}
            />
          </Field>
          <Field label="Available in">
            <Select
              items={scopeItems}
              value={form.projectId ?? ALL_PROJECTS}
              onValueChange={(value) => patch({ projectId: value === ALL_PROJECTS ? null : value })}
            >
              <SelectTrigger size="sm" aria-label="Available in">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {scopeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
        </div>
        <Field
          label="Title"
          hint={`Used when a task is made without a title. Placeholders: ${TEMPLATE_PLACEHOLDERS.map((p) => p.token).join(", ")}.`}
        >
          <Input
            size="sm"
            aria-label="Title pattern"
            value={form.titlePattern}
            placeholder="Weekly review {{date}}"
            onChange={(event) => patch({ titlePattern: event.currentTarget.value })}
          />
        </Field>
        <Field label="Description" hint="Markdown. Placeholders work here too.">
          <Textarea
            size="sm"
            aria-label="Description"
            value={form.description}
            placeholder={"## What happens\n\n## Expected"}
            onChange={(event) => patch({ description: event.currentTarget.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Labels" hint="Separated by commas.">
            <Input
              size="sm"
              aria-label="Labels"
              value={form.labels}
              placeholder="bug, backend"
              onChange={(event) => patch({ labels: event.currentTarget.value })}
            />
          </Field>
          <Field label="Suggested model" hint="Applied with the plan.">
            <Select
              items={TIER_ITEMS}
              value={form.suggestedTier ?? NO_TIER}
              onValueChange={(value) => patch({ suggestedTier: value === NO_TIER ? null : (value as ModelTier) })}
            >
              <SelectTrigger size="sm" aria-label="Suggested model">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {TIER_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium text-foreground/80">Plan</div>
          {form.outline.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No plan. Tasks made from this template start in Backlog with just the fields above.
            </p>
          ) : (
            <OutlineEditor outline={form.outline} onChange={(outline) => patch({ outline })} />
          )}
          {form.outline.length === 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                patch({
                  outline: [{ key: nextOutlineKey(), title: "Plan", steps: [{ key: nextOutlineKey(), title: "" }] }],
                })
              }
            >
              <PlusIcon />
              Add a plan
            </Button>
          ) : null}
        </div>
        {form.outline.length > 0 ? (
          <Field label="Plan notes" hint="Approach and decisions, shown above the plan.">
            <Textarea
              size="sm"
              aria-label="Plan notes"
              value={form.planContext}
              onChange={(event) => patch({ planContext: event.currentTarget.value })}
            />
          </Field>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </EditorPanel>
      <EditorFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={pending} onClick={save}>
          {templateId ? "Save template" : "Create template"}
        </Button>
      </EditorFooter>
    </>
  );
}
