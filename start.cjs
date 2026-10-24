// Botkeep / single-command start: install backend deps once, then run the
// single-service server (it serves frontend/dist itself). Listens on
// SERVER_PORT (Botkeep) or PORT, falling back to 4000.
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
if (!fs.existsSync(path.join(root, 'backend', 'node_modules'))) {
  console.log('[start] installing backend deps...');
  execSync('npm install --prefix backend --no-audit --no-fund', { stdio: 'inherit', cwd: root });
} else console.log('[start] backend deps already installed, skipping npm install');
const child = spawn(process.execPath, [path.join(root, 'backend', 'src', 'server.js')], { stdio: 'inherit', cwd: root, env: { ...process.env } });
child.on('exit', (code) => process.exit(code ?? 1));
