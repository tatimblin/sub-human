/**
 * paths: the one place the scripts name the repo and the plugin directory.
 */
import path from 'node:path';

export const REPO: string = path.resolve(import.meta.dirname, '..', '..');
export const PLUGIN: string = path.join(REPO, 'plugin', 'sub-human');
