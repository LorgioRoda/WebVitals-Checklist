// Registry of performance checks.
// Add a new check: create a module in this folder that follows the check
// interface (id, name, priority, async run(context)) and register it here.

import htmlDocument from './html-document.js';

export const checks = [htmlDocument];
