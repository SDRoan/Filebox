// Temporary: set to false to restore sign-in during local development.
export const LOCAL_PREVIEW_ENABLED =
  process.env.NODE_ENV === 'development' &&
  ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
