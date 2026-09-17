// Registry of performance checks.
// Add a new check: create a module in this folder that follows the check
// interface (id, name, priority, async run(context)) and register it here.

import htmlDocument from './html-document.js';
import cssBeforeJs from './css-before-js.js';
import iframes from './iframes.js';
import cssMinification from './css-minification.js';

export const checks = [htmlDocument, cssBeforeJs, iframes, cssMinification];
