/**
 * 积分倍率与余额：单元测试。
 * 覆盖：倍率归一化（含「未知 ≠ 免费」陷阱）、余额聚合口径、
 *       报告格式化（聚合/临期/截断）、模型清单报告。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateCredits, billingBaseForAuth } from '../plugin/bridge/wb-bridge.mjs';
import { compareModelsForPicker, creditLabel, creditValue, toModelInfo } from '../plugin/lib/adapter.mjs';
import { formatCreditsReport, formatModelsReport } from '../plugin/lib/index.js';

// ── 倍率归一化 ────────────────────────────────────────────────────────

test('creditLabel: 字符串 "x0.11 credits" → ×0.11', () => {
  assert.deepEqual(creditLabel({ credits: 'x0.11 credits' }), { text: '×0.11', known: true, free: false });
});

test('creditLabel: 数值 0.08 → ×0.08', () => {
  assert.deepEqual(creditLabel({ credits: 0.08 }), { text: '×0.08', known: true, free: false });
});

test('creditLabel: "x0.00" 与 free:true 才是免费', () => {
  assert.deepEqual(creditLabel({ credits: 'x0.00' }), { text: '免费', known: true, free: true });
  assert.deepEqual(creditLabel({ free: true }), { text: '免费', known: true, free: true });
});

test('creditLabel: 未知倍率不标免费（Number(null)===0 陷阱）', () => {
  // 「不知道多少钱」≠「免费」：把未知标成免费是对用户的钱包撒谎
  assert.deepEqual(creditLabel({}), { text: '', known: false, free: false });
  assert.deepEqual(creditLabel({ credits: null }), { text: '', known: false, free: false });
  assert.deepEqual(creditLabel({ credits: 'abc' }), { text: '', known: false, free: false });
});

test('toModelInfo: 倍率同时进 name 后缀与 description', () => {
  const info = toModelInfo({ id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.69 credits' });
  assert.equal(info.name, 'GLM-5.3 · ×0.69');
  assert.match(info.description, /积分 ×0.69/);
});

test('toModelInfo: 免费模型 name 标「免费」', () => {
  const info = toModelInfo({ id: 'hy4flash-free', name: 'Hy4 flash', credits: 'x0.00' });
  assert.equal(info.name, 'Hy4 flash · 免费');
});

// ── 选择器排序：免费优先、倍率升序、未知排最后 ────────────────────────

test('creditValue: 数值/字符串/未知', () => {
  assert.equal(creditValue({ credits: 0.11 }), 0.11);
  assert.equal(creditValue({ credits: 'x0.69 credits' }), 0.69);
  assert.equal(creditValue({}), null);
  assert.equal(creditValue({ credits: 'abc' }), null);
});

test('compareModelsForPicker: 免费第一、倍率升序、未知最后', () => {
  const paid = { id: 'paid', credits: 'x0.51 credits' };
  const cheap = { id: 'cheap', credits: 'x0.08' };
  const free = { id: 'free', credits: 'x0.00' };
  const unknown = { id: 'unknown' };
  const sorted = [paid, unknown, cheap, free].sort(compareModelsForPicker);
  assert.deepEqual(sorted.map((m) => m.id), ['free', 'cheap', 'paid', 'unknown']);
});

test('compareModelsForPicker: free:true 也算免费；同价保持稳定', () => {
  const a = { id: 'a', free: true };
  const b = { id: 'b', credits: 'x0.1' };
  assert.ok(compareModelsForPicker(a, b) < 0);
  assert.ok(compareModelsForPicker(b, a) > 0);
  // 同倍率 → 0（V8 sort 稳定，保持目录原序）
  const c = { id: 'c', credits: 'x0.1' };
  assert.equal(compareModelsForPicker(b, c), 0);
  const stable = [{ id: 'first', credits: 'x0.1' }, { id: 'second', credits: 'x0.1' }]
    .sort(compareModelsForPicker);
  assert.deepEqual(stable.map((m) => m.id), ['first', 'second']);
});

// ── 余额聚合 ──────────────────────────────────────────────────────────

test('billingBaseForAuth: 计费网关跟随登录域名（与 chat 网关不同主机）', () => {
  assert.equal(billingBaseForAuth({ domain: 'www.workbuddy.cn' }), 'https://www.workbuddy.cn');
  assert.equal(billingBaseForAuth({ domain: 'www.codebuddy.cn' }), 'https://www.codebuddy.cn');
  assert.equal(billingBaseForAuth({ domain: 'www.workbuddy.ai' }), 'https://www.workbuddy.ai');
});

test('aggregateCredits: 一次性包跳过 0/负余量，月度包看 Cycle 字段', () => {
  const result = aggregateCredits({
    Accounts: [
      // 一次性包有余额 → 计入
      { PackageName: '裂变包', CapacityType: 1, CapacityRemain: 79, CapacitySize: 100 },
      // 一次性包 0 余量（历史签到记录）→ 跳过
      { PackageName: '裂变包', CapacityType: 1, CapacityRemain: 0, CapacitySize: 100 },
      // 月度包 → 看 Cycle 字段（忽略 CapacityRemain）
      { PackageName: '月度包', CapacityType: 4, CycleCapacityRemain: 500, CycleCapacitySize: 1000, CapacityRemain: 999 },
      // 一次性包负余量 → 归 0 后同样跳过（列出来也没有意义）
      { PackageName: '异常包', CapacityType: 1, CapacityRemain: -5, CapacitySize: 10 },
    ],
  });
  assert.equal(result.total, 579); // 79 + 500
  assert.equal(result.packages.length, 2);
  const monthly = result.packages.find((p) => p.name === '月度包');
  assert.equal(monthly.remain, 500);
  assert.equal(monthly.monthly, true);
});

test('aggregateCredits: 到期时间 ExpiredTime 优先，空则 CycleEndTime', () => {
  const result = aggregateCredits({
    Accounts: [
      { PackageName: 'A', CapacityType: 1, CapacityRemain: 5, ExpiredTime: '2026-11-24 20:22:01' },
      { PackageName: 'B', CapacityType: 1, CapacityRemain: 5, CycleEndTime: '2026-12-01 00:00:00' },
      { PackageName: 'C', CapacityType: 1, CapacityRemain: 5 },
    ],
  });
  const by = Object.fromEntries(result.packages.map((p) => [p.name, p]));
  assert.equal(by.A.expiresAt, '2026-11-24 20:22:01');
  assert.equal(by.B.expiresAt, '2026-12-01 00:00:00');
  assert.equal(by.C.expiresAt, undefined);
  // 到期近的排前面
  assert.deepEqual(result.packages.map((p) => p.name), ['A', 'B', 'C']);
});

test('aggregateCredits: 空/坏数据不炸', () => {
  assert.deepEqual(aggregateCredits({}), { total: 0, packages: [] });
  assert.deepEqual(aggregateCredits(null), { total: 0, packages: [] });
  assert.deepEqual(aggregateCredits({ Accounts: 'x' }), { total: 0, packages: [] });
});

// ── 报告格式化 ────────────────────────────────────────────────────────

test('formatCreditsReport: 同名套餐聚合 + 7 天临期警告', () => {
  const now = new Date(2026, 10, 20).getTime(); // 2026-11-20
  const soon = new Date(now + 3 * 86_400_000); // 3 天后
  const pad = (n) => String(n).padStart(2, '0');
  const soonText = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())} 08:00:00`;
  const text = formatCreditsReport({
    total: 516,
    packages: [
      { name: '裂变包', remain: 300, size: 400, monthly: false, expiresAt: soonText },
      { name: '裂变包', remain: 200, size: 216, monthly: false, expiresAt: soonText },
      { name: '月度包', remain: 16, size: 100, monthly: true },
    ],
  }, { now });
  assert.match(text, /积分余额：516/);
  assert.match(text, /裂变包：余 500 \/ 616/);      // 同名聚合
  assert.match(text, /⚠️ .* 到期（剩 4 天）/);       // 3.33 天向上取整为 4 天
  assert.match(text, /月度包：余 16 \/ 100 · 月度包/);
  // 临期的排前面
  assert.ok(text.indexOf('裂变包') < text.indexOf('月度包'));
});

test('formatCreditsReport: 坏数据给可读错误而不是崩溃', () => {
  assert.match(formatCreditsReport(null), /读取失败/);
  assert.match(formatCreditsReport({}), /读取失败/);
});

test('formatModelsReport: 免费优先、倍率升序、超过 40 个截断', () => {
  const catalog = [
    { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.69 credits' },
    { id: 'hy4flash-free', name: 'Hy4 flash', credits: 'x0.00' },
    { id: 'deepseek-v4.1-flash', name: 'DS', credits: 'x0.11 credits' },
    { id: 'unknown-cost', name: 'U' },
  ];
  const text = formatModelsReport(catalog);
  assert.match(text, /可用模型（4 个/);
  const lines = text.split('\n').filter((l) => l.startsWith('· '));
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes('hy4flash-free'));  // 免费第一
  assert.ok(lines[1].includes('×0.11'));          // 倍率升序
  assert.ok(lines[3].includes('倍率未知'));        // 未知排最后
  // 截断
  const many = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, name: `M${i}`, credits: `x0.1` }));
  assert.match(formatModelsReport(many), /……等 45 个模型/);
});
