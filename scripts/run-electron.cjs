const { spawn } = require('node:child_process');
const path = require('node:path');

const electronPath = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const args = process.argv.slice(2);
if (args.length === 0) args.push(path.join(__dirname, '..'));

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env,
  windowsHide: false
});

child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
