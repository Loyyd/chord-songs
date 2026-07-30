import '../index.css';
import { spawn } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const commands = [
  {
    name: 'backend',
    command: isWindows ? 'python' : 'python3',
    args: ['-m', 'backend.main']
  },
  {
    name: 'frontend',
    command: isWindows ? 'npx.cmd' : 'vite',
    args: []
  }
];

const children = [];
let shuttingDown = false;

function prefixOutput(name, chunk, stream) {
  const lines = chunk.toString().split(/\r?\n/);
  for (const line of lines) {
    if (line.length > 0) {
      stream.write(`[${name}] ${line}\n`);
    }
  }
}

function stopAll(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }

  setTimeout(() => process.exit(exitCode), 150);
}

for (const { name, command, args } of commands) {
  const child = spawn(command, args, {
    env: {
      ...process.env,
      LIVE_AUTH_REQUIRED: process.env.LIVE_AUTH_REQUIRED ?? 'false',
      PYTHONUNBUFFERED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  children.push(child);

  child.stdout.on('data', (chunk) => prefixOutput(name, chunk, process.stdout));
  child.stderr.on('data', (chunk) => prefixOutput(name, chunk, process.stderr));
  child.on('error', (error) => {
    console.error(`[${name}] ${error.message}`);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      console.error(`[${name}] exited with ${reason}`);
      stopAll(code ?? 1);
    }
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
