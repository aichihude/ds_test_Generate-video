/* ==========================================================================
   main.js — 播放控制 / 主循环 / 逐帧校验钩子
   ========================================================================== */
(function (global) {
  'use strict';
  const U = global.MGU, BG = global.BG, SCENE = global.SCENE;

  const canvas = document.getElementById('screen');
  const { ctx } = U.initCanvas(canvas);

  const veil = document.getElementById('veil');
  const btnStart = document.getElementById('btnStart');
  const btnPlay = document.getElementById('btnPlay');
  const btnReplay = document.getElementById('btnReplay');
  const bar = document.querySelector('#bar i');
  const barWrap = document.getElementById('bar');
  const tc = document.getElementById('tc');
  const wb = document.getElementById('wb');
  const grainEl = document.getElementById('grain');

  /* ------------------------------ 胶片颗粒贴图 ------------------------------ */
  (function makeGrain() {
    const n = 180;
    const c = document.createElement('canvas'); c.width = c.height = n;
    const x = c.getContext('2d');
    const img = x.createImageData(n, n);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 118 + (Math.random() * 74 - 37);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    grainEl.style.backgroundImage = `url(${c.toDataURL('image/png')})`;
    grainEl.style.backgroundSize = '180px 180px';
  })();

  /* ------------------------------ 播放状态 ------------------------------ */
  const DUR = SCENE.TIMELINE.duration;
  const qs = new URLSearchParams(location.search);
  const freezeT = qs.has('t') ? parseFloat(qs.get('t')) : null;

  const st = {
    t: freezeT != null ? freezeT : 0,
    playing: freezeT == null,
    last: performance.now(),
    started: false
  };

  function setTime(t) {
    st.t = Math.max(0, Math.min(DUR - 1e-3, t));
  }

  function play() { st.playing = true; st.last = performance.now(); syncBtn(); }
  function pause() { st.playing = false; syncBtn(); }
  function toggle() { st.playing ? pause() : play(); }
  function syncBtn() { btnPlay.textContent = st.playing ? '❚❚' : '▶'; }
  syncBtn();

  function begin() {
    if (st.started) return;
    st.started = true;
    veil.classList.add('hide');
    setTimeout(() => { veil.style.display = 'none'; }, 620);
    setTime(0);
    play();
    if (qs.get('hud') === '1') document.getElementById('hud').classList.add('on');
  }

  btnStart.addEventListener('click', begin);
  btnPlay.addEventListener('click', toggle);
  btnReplay.addEventListener('click', () => { setTime(0); play(); });
  window.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    if (e.code === 'ArrowRight') { pause(); setTime(st.t + 1); }
    if (e.code === 'ArrowLeft') { pause(); setTime(st.t - 1); }
    if (e.code === 'KeyR') { setTime(0); play(); }
  });
  barWrap.addEventListener('click', e => {
    const r = barWrap.getBoundingClientRect();
    setTime((e.clientX - r.left) / r.width * DUR);
  });

  // 窗口尺寸变化时只需重新计算 DPR 变换
  window.addEventListener('resize', () => U.initCanvas(canvas));

  /* ------------------------------ 主循环 ------------------------------ */
  let flashAmt = 0;
  function frame(now) {
    const dt = Math.min(.05, (now - st.last) / 1000);
    st.last = now;
    if (st.playing) {
      st.t += dt;
      if (st.t >= DUR) { st.t = 0; }        // 无缝循环
    }

    const info = SCENE.render(ctx, st.t);

    // DOM 白闪（跨镜头切点的曝光呼吸）
    const lt = info.lt;
    const cut = (1 - U.ease.out2(U.span(lt, 0, .18)));
    const target = cut * .18;
    flashAmt += (target - flashAmt) * .35;
    wb.style.opacity = flashAmt.toFixed(3);

    bar.style.width = (st.t / DUR * 100).toFixed(2) + '%';
    tc.textContent = `${BG.fmtTC(st.t)} / ${BG.fmtTC(DUR)}`;

    requestAnimationFrame(frame);
  }

  if (freezeT != null) {
    // ?t=12.5 —— 逐帧校验：只渲染一帧并停住
    SCENE.render(ctx, st.t);
    bar.style.width = (st.t / DUR * 100) + '%';
    tc.textContent = `${BG.fmtTC(st.t)} / ${BG.fmtTC(DUR)}`;
    st.playing = false;
    document.getElementById('hud').classList.add('on');
    if (qs.get('veil') !== '1') { veil.style.display = 'none'; }
  } else {
    if (qs.get('auto') === '1') begin();
    requestAnimationFrame(frame);
  }

  // 调试 / 截帧接口
  global.__dsh = {
    render: t => SCENE.render(ctx, t),
    seek: t => { setTime(t); SCENE.render(ctx, st.t); },
    play, pause, duration: DUR,
    state: st
  };
})(window);
