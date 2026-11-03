/** IPC channel names shared by the main process and the preload (kept free of heavier imports). */
export const SET_THEME_CHANNEL = "desktop:set-theme";
export const SET_BACKGROUND_CHANNEL = "desktop:set-background";
export const NOTIFY_CHANNEL = "desktop:notify";
export const SET_BADGE_CHANNEL = "desktop:set-badge";
/** Main to page: the user clicked a notification. */
export const NOTIFICATION_CLICK_CHANNEL = "desktop:notification-click";
/** Main to page: whether the window is hidden (in the tray or minimised). */
export const WINDOW_HIDDEN_CHANNEL = "desktop:window-hidden";
