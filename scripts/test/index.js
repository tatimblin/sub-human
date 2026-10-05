'use strict';
// `node --test scripts/test` resolves the directory to this file (Node 24 does not expand a
// directory argument), so load every *.test.js next to it.
const fs = require('node:fs');
const path = require('node:path');

for (const f of fs.readdirSync(__dirname).filter(n => n.endsWith('.test.js')).sort()) require(path.join(__dirname, f));
