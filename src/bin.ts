#!/usr/bin/env node
import { assertSupportedNodeVersion } from './node-support.js';

// Keep this bootstrap free of the CLI dependency graph so unsupported Node versions
// fail with this actionable message before Commander, jsdom, or Gutenberg load.
assertSupportedNodeVersion();
await import('./cli.js');
