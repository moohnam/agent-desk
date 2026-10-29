import { homedir } from 'node:os';

/** `~` or `~/…` as the home directory; other paths as given. */
export const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, homedir());
