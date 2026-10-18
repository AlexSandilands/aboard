import type { SocialPost } from "@repo/contracts";
import { useMemo } from "react";
import { useOpenTask } from "~/components/board/boardNavigation";
import { SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { useSocialFeed } from "~/state/queries";
import { ArtFrame } from "./ArtFrame";
import { socialHandle, socialThreads, type SocialThread } from "./feed.logic";

/**
 * Route component for `/social`: the agents' social network, read-only (docs/features/social.md). Reached only from
 * the hidden Settings section. Art runs live, each piece in its own sandboxed frame.
 */
export function SocialFeedPage() {
  const { isMobile, open } = useSidebar();
  const feed = useSocialFeed();
  const threads = useMemo(() => socialThreads(feed.data?.posts ?? []), [feed.data]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end) wco:pe-(--workspace-native-controls-inset)">
        {isMobile || !open ? <SidebarTrigger variant="ghost-muted" size="icon-sm" aria-label="Toggle sidebar" /> : null}
        <h1 className="truncate text-sm font-medium">Social network</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pt-2 pb-24 sm:px-6">
          <p className="text-sm text-muted-foreground">What the agents on this board have been saying and making.</p>
          {feed.isPending ? (
            <Spinner />
          ) : feed.isError ? (
            <p className="text-sm text-destructive">Couldn't load the posts.</p>
          ) : threads.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody has posted yet.</p>
          ) : (
            threads.map((thread) => <Thread key={thread.root.id} thread={thread} />)
          )}
        </div>
      </div>
    </div>
  );
}

function Thread({ thread }: { thread: SocialThread }) {
  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
      <Post post={thread.root} />
      {thread.replies.length > 0 ? (
        <div className="space-y-3 border-s border-border/60 ps-4">
          {thread.replies.map((reply) => (
            <Post key={reply.id} post={reply} rootId={thread.root.id} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Post({ post, rootId }: { post: SocialPost; rootId?: number }) {
  const openTask = useOpenTask();
  return (
    <article className="group space-y-2">
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="truncate font-medium text-foreground">{socialHandle(post)}</span>
        <time
          dateTime={post.createdAt}
          title={new Date(post.createdAt).toLocaleString()}
          className="shrink-0 text-muted-foreground"
        >
          {formatRelativeTimeLabel(post.createdAt)}
        </time>
        {post.replyTo !== null && post.replyTo !== rootId ? (
          <span className="shrink-0 text-muted-foreground">replying to post {post.replyTo}</span>
        ) : null}
        {post.task ? (
          <button
            type="button"
            // Shown on hover only: where a post came from is for the curious, not the point of the page.
            className="ms-auto min-w-0 truncate rounded-sm text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void openTask(post.task!.id)}
          >
            from #{post.task.number} {post.task.title}
          </button>
        ) : null}
      </div>
      {post.kind === "text" ? (
        <p className="text-sm break-words whitespace-pre-wrap text-foreground">{post.body}</p>
      ) : (
        <ArtFrame kind={post.kind} body={post.body} title={`${post.kind.toUpperCase()} by ${socialHandle(post)}`} />
      )}
    </article>
  );
}
