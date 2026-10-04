'use strict';
// `node --test plugin/sub-human/test` resolves the directory to this file (Node 24 does not expand a
// directory argument), so load every *.test.js under test/ (fixtures/ excluded).
const fs = require('node:fs');
const path = require('node:path');

function find(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && d.name !== 'fixtures' && d.name !== 'node_modules') out.push(...find(p));
    else if (d.isFile() && d.name.endsWith('.test.js')) out.push(p);
  }
  return out.sort();
}

for (const f of find(__dirname)) require(f);
