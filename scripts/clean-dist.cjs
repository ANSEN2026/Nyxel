const fs = require('node:fs');
const path = require('node:path');

for (const target of process.argv.slice(2)) {
  fs.rmSync(path.join(__dirname, '..', target), { recursive: true, force: true });
}
