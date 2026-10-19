/* ==========================================================================
   tools/doccheck.js — 文档与代码的一致性检查
   把 README / DOCS 里写的时长、分镜时间范围等信息，跟真实时间轴对一遍，
   防止“改了代码忘了改文档”（本项目的 57.4s 笔误就是这么来的）。
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');

const app = H.boot();
const T = app.CTX.SCENE.TIMELINE;
const DUR = T.duration;
const docs = ['README.md', 'DOCS.md'];
const problems = [];
const ok = [];

console.log('真实时间轴：总时长 %ss，%d 个分镜\n', DUR.toFixed(1), T.shots.length);
for (const s of T.shots) {
  console.log('  ' + String(s.index + 1).padStart(2, '0') + '  ' +
    s.start.toFixed(1).padStart(5) + ' → ' + s.end.toFixed(1).padStart(5) +
    '  (' + s.dur.toFixed(1) + 's)  ' + s.name);
}
console.log('');

for (const d of docs) {
  const p = path.join(H.ROOT, d);
  if (!fs.existsSync(p)) { problems.push(`${d}: 文件不存在`); continue; }
  const src = fs.readFileSync(p, 'utf8');

  // 1) 总时长声明：抓“52.7 秒 / 52.7s”且后面跟句读或行尾的数字短语；
  //    跳过行内代码，以及“本章在讲缺陷”的条目（那里会引用历史错值）
  const lineOf = idx => src.slice(src.lastIndexOf('\n', idx) + 1, src.indexOf('\n', idx) === -1 ? src.length : src.indexOf('\n', idx));
  const inCode = idx => (lineOf(idx).match(/`/g) || []).length % 2 === 1;
  const isBugReport = idx => {
    const line = lineOf(idx);
    if (/^\s*\d+\.\s/.test(line)) return true;                       // 有序列表里的缺陷条目
    return /笔误|真实是|修正|陷阱|旧的?错值|写的是|错值/.test(line);
  };
  const durClaims = [...src.matchAll(/(\d{2,3}\.\d)\s*(?:秒|s(?![a-zA-Z]))\s*(?:[*_）)]{0,2})(?=[，。、；,;]|$)/gm)]
    .filter(m => !inCode(m.index) && !isBugReport(m.index))
    .map(m => parseFloat(m[1]))
    .filter(v => v >= 40 && v <= 300);
  const badDur = durClaims.filter(v => Math.abs(v - DUR) > 0.05);
  if (badDur.length) {
    problems.push(`${d}: 疑似总时长声明与真实值 ${DUR.toFixed(1)}s 不符 → ${[...new Set(badDur)].join(', ')}`);
  } else {
    ok.push(`${d}: 总时长声明一致`);
  }

  // 2) 分镜表：只认 Markdown 表格行 | NN | a–b | 的形式，避免正文里的时间区间被误判
  const tableRows = [...src.matchAll(/^\|\s*(\d{2})\s*\|\s*(\d+\.\d)\s*[–\-]\s*(\d+\.\d)\s*\|/gm)];
  let matched = 0;
  for (const m of tableRows) {
    const a = parseFloat(m[2]), b = parseFloat(m[3]);
    const hit = T.shots.find(s => Math.abs(s.start - a) < 0.06 && Math.abs(s.end - b) < 0.06);
    if (hit) matched++;
  }
  if (tableRows.length) {
    if (matched < T.shots.length) {
      problems.push(`${d}: 分镜表只对上 ${matched}/${T.shots.length} 段（检查是否有笔误）`);
    } else {
      ok.push(`${d}: ${matched} 段分镜时间全部对得上`);
    }
  }

  // 3) 形如 "?t=xx" 的示例不能超过总时长
  const seeks = [...src.matchAll(/\?t=(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
  const badSeek = seeks.filter(v => v > DUR);
  if (badSeek.length) problems.push(`${d}: 示例 ?t= 超过总时长 → ${badSeek.join(', ')}`);
}

// 4) 时间轴自身完整性
let acc = 0, overlap = false;
for (const s of T.shots) {
  if (Math.abs(s.start - acc) > 1e-6) overlap = true;
  acc = s.end;
}
if (overlap || Math.abs(acc - DUR) > 1e-6) problems.push('时间轴存在间隙/重叠或累计时长不一致');
else ok.push('时间轴连续、累计时长自洽');

console.log('=== 通过 ===');
ok.forEach(x => console.log('  ✓ ' + x));
if (problems.length) {
  console.log('\n=== 需要修正 ===');
  problems.forEach(x => console.log('  ✗ ' + x));
  process.exitCode = 1;
} else {
  console.log('\n文档与代码一致 ✓');
}
