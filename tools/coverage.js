/* ==========================================================================
   tools/coverage.js — 降级分支覆盖测试
   动画里有两处能力探测：
     1. ctx.filter 是否支持（超分镜的模糊层）；不支持时退化为多次偏移叠加
     2. DOMMatrix 是否可用（解码镜的 pattern 变换）
   这个脚本故意把两者关掉，再跑一遍全片时间点，确保备选路径同样不报错。
   用法：node tools/coverage.js
   ========================================================================== */
'use strict';
const H = require('./harness');

let fail = 0;

function run(label, opts, expect) {
  process.stdout.write('\n=== ' + label + ' ===\n');
  let app;
  try {
    app = H.boot(opts);
  } catch (e) {
    console.log('  启动失败: ' + e.message);
    fail++;
    return;
  }
  const DUR = app.CTX.__dsh.duration;
  const N = 140;
  let errors = 0, nan = 0, opsTotal = 0;
  for (let i = 0; i < N; i++) {
    const t = (i / (N - 1)) * (DUR - 0.02);
    let ops;
    try {
      ops = H.renderAt(app, t);
    } catch (e) {
      errors++;
      if (errors <= 3) console.log('  t=' + t.toFixed(2) + 's 抛异常: ' + (e && e.message));
      continue;
    }
    opsTotal += ops.length;
    for (const o of ops) {
      if (o.m.some(v => !Number.isFinite(v))) { nan++; break; }
      if (o.t === 'text' && (!Number.isFinite(o.x) || !Number.isFinite(o.y))) { nan++; break; }
      if (o.t === 'img' && [o.dx, o.dy, o.dw, o.dh].some(v => !Number.isFinite(v))) { nan++; break; }
    }
  }
  // 能力探测结果
  const ctx = app.CTX.document.createElement('canvas').getContext('2d');
  ctx.filter = 'blur(2px)';
  const filterOn = ctx.filter === 'blur(2px)';
  const domOn = typeof app.CTX.DOMMatrix === 'function';
  console.log('  采样 %d 帧 · 平均 %d 指令/帧', N, Math.round(opsTotal / N));
  console.log('  ctx.filter = %s（预期 %s）', filterOn, expect.filter ? '可用' : '不可用');
  console.log('  DOMMatrix  = %s（预期 %s）', domOn, expect.domMatrix ? '可用' : '不可用');
  console.log('  异常 %d 次 / 非有限坐标 %d 次', errors, nan);
  if (errors || nan) fail++;
  if (filterOn !== expect.filter || domOn !== expect.domMatrix) {
    console.log('  ✗ 能力探测与实际不符');
    fail++;
  } else {
    console.log('  ✓ 该分支执行正常');
  }
}

run('默认环境（filter + DOMMatrix 都可用）', {}, { filter: true, domMatrix: true });
run('降级环境（filter 关闭 → 超分用多次偏移叠加）', { filter: false }, { filter: false, domMatrix: true });
run('降级环境（DOMMatrix 关闭 → pattern.setTransform 跳过）', { domMatrix: false }, { filter: true, domMatrix: false });
run('最差环境（两者都关闭）', { filter: false, domMatrix: false }, { filter: false, domMatrix: false });

console.log('\n=== 结论 ===');
if (fail) {
  console.log('  有 %d 项未通过 ✗', fail);
  process.exitCode = 1;
} else {
  console.log('  4 种环境全部跑通，降级分支均有效 ✓');
}
