/** IPC channel names shared by the main process and the preload (kept free of heavier imports). */
export const SET_THEME_CHANNEL = "desktop:set-theme";
export const SET_BACKGROUND_CHANNEL = "desktop:set-background";
export const NOTIFY_CHANNEL = "desktop:notify";
export const SET_BADGE_CHANNEL = "desktop:set-badge";
/** Main to page: the user clicked a notification. */
export const NOTIFICATION_CLICK_CHANNEL = "desktop:notification-click";
/** Page to main (invoke): the current update state. */
export const GET_UPDATE_STATE_CHANNEL = "desktop:get-update-state";
/** Main to page: the update state changed. */
export const UPDATE_STATE_CHANNEL = "desktop:update-state";
export const CHECK_FOR_UPDATES_CHANNEL = "desktop:check-for-updates";
export const INSTALL_UPDATE_CHANNEL = "desktop:install-update";
export const SET_AUTO_CHECK_UPDATES_CHANNEL = "desktop:set-auto-check-updates";
export const OPEN_RELEASE_NOTES_CHANNEL = "desktop:open-release-notes";
