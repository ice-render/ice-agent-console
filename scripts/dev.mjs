#!/usr/bin/env node
/**
 * 一条命令起两个进程：AG-UI 后端（8099）+ 前端 dev server（8100）。
 *
 * 家族其它仓库都是"一个进程"的纯静态应用，npm start 就够了。
 * 这个工程有后端，但又不想为了 concurrently 这种小工具引一个依赖，
 * 所以这里手写一个 30 行的进程管理器：转发 stdout/stderr、给输出加前缀、Ctrl-C 一起收掉。
 */
import { spawn } from 'node:child_process';

const procs = [
  { name: 'api', color: '\x1b[36m', cmd: 'npx', args: ['tsx', 'watch', 'server/index.ts'] },
  { name: 'web', color: '\x1b[35m', cmd: 'npx', args: ['webpack', 'serve', '--mode', 'development'] },
];

const RESET = '\x1b[0m';
const children = [];
let shuttingDown = false;

function prefix(name, color, chunk) {
  const text = chunk.toString();
  return text
    .split('\n')
    .filter((line, i, all) => line.length > 0 || i < all.length - 1)
    .map((line) => `${color}[${name}]${RESET} ${line}`)
    .join('\n');
}

for (const p of procs) {
  const child = spawn(p.cmd, p.args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  children.push(child);
  child.stdout.on('data', (c) => process.stdout.write(prefix(p.name, p.color, c) + '\n'));
  child.stderr.on('data', (c) => process.stderr.write(prefix(p.name, p.color, c) + '\n'));
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`${p.color}[${p.name}]${RESET} 退出，code=${code}`);
    shutdown(code ?? 0);
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`
  ice-agent-console
    AG-UI 后端   http://localhost:8099/agui
    控制台页面   http://localhost:8100

  Ctrl-C 一起收掉。
`);
