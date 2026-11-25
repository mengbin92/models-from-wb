/**
 * 端口占用（多宿主 race）行为测试。
 *
 * 场景：desktop 与 web 两个 dsh 宿主都装着插件时，两边都可能尝试拉起桥，
 * 后起的必然 EADDRINUSE。要求：
 *   · 占用者是健康桥 → 安静退出（0），调用方复用现有实例；
 *   · 占用者不健康   → 报错退出（1），不假装成功。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'bridge', 'wb-bridge.mjs');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 等端口上的 /health 就绪；超时返回 null。 */
async function waitHealthy(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return null;
}

/** 起一个桥子进程，返回 { child, waitExit }。 */
function spawnBridge(port, extraEnv = {}) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, WB_PORT: String(port), WB_LOG: '0', ...extraEnv },
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal })); });
  return { child, exited };
}

test('端口已被健康桥占用：第二个实例安静退出（0），原桥不受影响', async (t) => {
  const port = 18771 + (process.pid % 100);
  const first = spawnBridge(port);
  t.after(() => { first.child.kill(); });

  const health = await waitHealthy(port);
  assert.ok(health, '第一个桥应就绪');
  const firstPid = health.pid;

  const second = spawnBridge(port);
  const result = await Promise.race([
    second.exited,
    sleep(8000).then(() => ({ code: 'timeout', signal: '' })),
  ]);
  assert.equal(result.code, 0, '占用者是健康桥时应安静退出');
  assert.equal(result.signal, null, '应是主动 exit(0)，不是被信号杀死');

  // 原桥还在服务
  const still = await waitHealthy(port, 3000);
  assert.ok(still, '原桥应继续服务');
  assert.equal(still.pid, firstPid, '原桥进程不应被替换');
});

test('端口被不健康进程占用：第二个实例报错退出（1）', async (t) => {
  const port = 18971 + (process.pid % 100);
  // 占用者：接受连接但永不响应（半死的旧桥）
  const squatter = createServer((socket) => { /* 不响应，静默持有端口 */ });
  await new Promise((resolve) => { squatter.listen(port, '127.0.0.1', resolve); });
  t.after(() => { squatter.close(); });

  const second = spawnBridge(port);
  const result = await Promise.race([
    second.exited,
    sleep(10000).then(() => ({ code: 'timeout', signal: '' })),
  ]);
  assert.equal(result.code, 1, '占用者不健康时应报错退出');
});
