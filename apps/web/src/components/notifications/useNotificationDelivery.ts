import { useEffect, useEffectEvent } from "react";
import { useOpenTask } from "~/components/board/boardNavigation";
import { desktopBridge } from "~/lib/desktopBridge";
import { useMarkNotificationRead } from "~/state/mutations";
import { useNotifications } from "~/state/queries";
import { showUnreadCount } from "./badge";
import { setNotificationOpener, startTabCoordination, type OpenNotification } from "./delivery";

/**
 * Mount once with the board. Opens the task when a popup is clicked, and keeps the unread count on the taskbar and
 * tray (desktop) or the tab's favicon (browser). The popups themselves come from useBoardEvents.
 */
export function useNotificationDelivery() {
  const openTask = useOpenTask();
  const markRead = useMarkNotificationRead();
  const unread = useNotifications().data?.unread;

  const open: OpenNotification = useEffectEvent(({ id, taskId }) => {
    markRead.mutate(id);
    if (taskId) void openTask(taskId);
  });

  useEffect(() => startTabCoordination(), []);
  useEffect(() => {
    setNotificationOpener((n) => open(n));
    const unsubscribe = desktopBridge()?.onNotificationClick((n) => open(n));
    return () => {
      setNotificationOpener(null);
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    // Wait for the first answer: a badge cleared before the count arrives would flash.
    if (unread !== undefined) showUnreadCount(unread);
  }, [unread]);
}
