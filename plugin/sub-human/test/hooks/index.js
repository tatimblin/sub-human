'use strict';
// `node --test plugin/sub-human/test/hooks` resolves the directory to this file (Node 24 does not
// expand a directory argument), so load every *.test.js beside it.
const fs = require('node:fs');
const path = require('node:path');
for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) require(path.join(__dirname, f));
