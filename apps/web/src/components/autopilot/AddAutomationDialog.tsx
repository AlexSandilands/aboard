// + Add automation: one place to start anything. Quick setup, a line to ask the user's own agent, recipes, import a
// file, or start from scratch. Switched-off built-ins stay in the main list, so they aren't repeated here.
import { AUTOMATION_RECIPES, createAutomationPrompt } from "@repo/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FileUpIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { AskAgentMenu } from "~/components/handoff/HandoffActions";
import { FROM_SETTINGS_LIST } from "~/components/settings/settingsNavigation";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { QuickSetup, type QuickSetupState } from "./QuickSetup";
import { useScopeParam } from "~/components/settings/SettingsScope";
import { scopeSearch } from "~/components/settings/settingsScope.logic";

export function AddAutomationDialog({
  open,
  onOpenChange,
  quickSetup,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quickSetup: QuickSetupState;
}) {
  const navigate = useNavigate();
  const scope = scopeSearch(useScopeParam());
  const [choosing, setChoosing] = useState(false);
  const go = (to: () => void) => {
    onOpenChange(false);
    to();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setChoosing(false);
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add automation</DialogTitle>
          <DialogDescription>
            The built-in automations are already in the list: switch one on there. Here you add your own, or switch on a
            sensible set at once.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="@container space-y-5">
          <section aria-label="Quick setup" className="rounded-lg border border-border/60 p-3">
            {choosing ? (
              <QuickSetup
                state={quickSetup}
                title="Quick setup"
                onApplied={() => {
                  setChoosing(false);
                  onOpenChange(false);
                }}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium text-foreground">Quick setup</h3>
                  <p className="text-xs text-muted-foreground">
                    Switch on a sensible set in one go: Notify, Assist or Hands-off.
                  </p>
                </div>
                <Button size="xs" variant="outline" onClick={() => setChoosing(true)}>
                  Choose…
                </Button>
              </div>
            )}
          </section>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted/30 px-3 py-2.5">
            <SparklesIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 text-sm text-foreground">
              <span className="font-medium">Quickest: ask your agent.</span>{" "}
              <span className="text-muted-foreground">Its draft lands in Needs you, in Preview.</span>
            </p>
            <AskAgentMenu
              label="Ask an agent to write an automation"
              threadLabel="Write an automation"
              prompt={() => createAutomationPrompt({ boardUrl: window.location.origin })}
              variant="outline"
              triggerLabel="Ask an agent"
            />
          </div>
          <section aria-label="Recipes" className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Recipes</h3>
            <div className="grid gap-2 @min-[34rem]:grid-cols-2">
              {AUTOMATION_RECIPES.map((recipe) => (
                <button
                  key={recipe.id}
                  type="button"
                  className="flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border border-border/60 p-3 text-left transition-colors outline-none hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    go(
                      () =>
                        void navigate({
                          to: "/settings/autopilot/custom/import",
                          search: { ...scope, recipe: recipe.id },
                          state: FROM_SETTINGS_LIST,
                        }),
                    )
                  }
                >
                  <span className="text-sm font-medium text-foreground">{recipe.title}</span>
                  <span className="text-xs text-muted-foreground">{recipe.blurb}</span>
                  <Badge variant="outline" size="sm">
                    {recipe.kind}
                  </Badge>
                </button>
              ))}
            </div>
          </section>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="outline"
              onClick={() =>
                go(
                  () =>
                    void navigate({
                      to: "/settings/autopilot/custom/import",
                      search: scope,
                      state: FROM_SETTINGS_LIST,
                    }),
                )
              }
            >
              <FileUpIcon />
              Import a file
            </Button>
            <Button
              onClick={() =>
                go(
                  () =>
                    void navigate({
                      to: "/settings/autopilot/custom/$customId",
                      params: { customId: "new" },
                      search: scope,
                      state: FROM_SETTINGS_LIST,
                    }),
                )
              }
            >
              Start from scratch
            </Button>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
