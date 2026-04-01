/**
 * Marketplace path constants
 */

import { join } from 'path';
import { ALLY_HOME } from '../config/paths.js';

/** Base directory for all marketplace/plugin data */
export const MARKETPLACE_DIR = join(ALLY_HOME, 'plugins');

/** Tracking file for installed plugins */
export const INSTALLED_PLUGINS_FILE = join(MARKETPLACE_DIR, 'installed_plugins.json');

/** Registry of known marketplace sources */
export const KNOWN_MARKETPLACES_FILE = join(MARKETPLACE_DIR, 'known_marketplaces.json');

/** Plugin blocklist */
export const BLOCKLIST_FILE = join(MARKETPLACE_DIR, 'blocklist.json');

/** Cache directory for installed plugin copies */
export const PLUGIN_CACHE_DIR = join(MARKETPLACE_DIR, 'cache');

/** Cache directory for cloned marketplace repos */
export const MARKETPLACE_CACHE_DIR = join(MARKETPLACE_DIR, 'cache', 'marketplaces');
