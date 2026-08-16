import os from 'node:os';
import { setExtraAllowedRoots } from './src/security/PathSecurity.js';

/**
 * Tools under test operate on isolated `mkdtemp` directories, which sit outside
 * the project root and would otherwise be denied by path authorization.
 *
 * Granting the system temp directory here — once, explicitly, from test setup —
 * replaces a `process.env.VITEST` branch that used to live inside
 * `isPathWithinAllowedDirectories`. Production code never calls this, so the
 * security primitive no longer changes behavior based on the ambient
 * environment.
 */
setExtraAllowedRoots([os.tmpdir()]);
