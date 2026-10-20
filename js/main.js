/* Phi Programs · interaction layer
   1. Deck: every section is a screen in one sticky viewport. The scroll
      position picks a screen and a step; changing them plays timed
      transitions (CSS), so the page switches screens instead of sliding.
   2. 수업 장치: inside its screen, scroll moves the card track (1:1, smoothed).
   3. 연간 구조: the chosen period expands into its detail; moving between
      periods collapses back to the overview first.
   4. Lists: hovering dims siblings and swaps the section image.
   5. Hero: accelerating 1→12 loop, two rotating pixel logos, pointer crosshair.
   6. GNB hides while scrolling down and returns when scrolling up. */
(() => {
  'use strict';

  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const wait = (ms) => new Promise((r) => setTimeout(r, reduceMotion.matches ? 0 : ms));

  /* Scroll tuning */
  const STEP_VH = 0.7;      // scroll distance per step, × viewport height
  const HERO_STEP = 0.6;    // the hero needs a shorter push to move on, × step
  const INNER_STEP = 0.55;  // moving on within the same section needs a shorter push, × step
  const YEAR_STEP = 0.4;    // 연간 구조 has twice the steps (overview between periods), so lighter still
  const LAST_DWELL = 0.35;  // hold on the last step before the footer, × step
  const TAIL = 0.3;         // pinned room after the last step, × viewport height: a swipe's
                            // overshoot lands here instead of sliding the screen toward the footer
  const HYSTERESIS = 0.06;  // a step changes only once its edge is passed by 6% of a step
  const CAROUSEL_IN = 0.25; // hold before the cards start moving, × viewport height
  const CAROUSEL_OUT = 0.12;// hold after the last card arrives, × viewport height (one swipe moves on)
  const FOLLOW_MS = 110;    // carousel follow time constant (inertia without overshoot)
  const CAROUSEL_SETTLE = 900; // ms after arriving from above in which leftover scroll is absorbed
  const CAROUSEL_SETTLE_MAX = 1600; // …extended while a fling's momentum keeps coming, up to this
  const YEAR_COLLAPSE = 620;// ms to fold a period back into the overview
  const YEAR_EXPAND = 760;  // ms for a period to open
  const TALENT_ENTER = 1440;// ms the 인재상 diagram takes to pop in
  const TALENT_HOLD = 2500; // ms it then rests before moving on by itself
  const HERO_LAG = 500;     // ms a screen waits after the hero before its content arrives (CSS --enter-lag)
  const TALENT_SHRINK = 1170;// ms of the reversed entrance before the next step

  /* ── Image slots ─────────────────────────────────────── */
  const IMG_DIR = 'assets/img/';
  const IMG_EXT = '.jpg';
  const images = new Map();

  function probe(key) {
    let rec = images.get(key);
    if (rec) return rec;
    rec = { state: 'loading', src: IMG_DIR + key + IMG_EXT, waiters: [] };
    images.set(key, rec);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { rec.state = 'ok'; flush(rec); };
    img.onerror = () => { rec.state = 'missing'; flush(rec); };
    img.src = rec.src;
    return rec;
  }
  function flush(rec) { rec.waiters.splice(0).forEach((fn) => fn()); }

  // Show `key` in an image slot. A missing file keeps whatever is showing.
  function setMedia(slot, key) {
    if (!slot || !key || slot.dataset.current === key) return;
    slot.dataset.current = key;
    const rec = probe(key);
    const apply = () => {
      if (slot.dataset.current !== key || rec.state !== 'ok') return;
      let layer = slot.querySelector(`.media__img[data-key="${key}"]`);
      if (!layer) {
        layer = document.createElement('img');
        layer.className = 'media__img';
        layer.dataset.key = key;
        layer.alt = '';
        layer.decoding = 'async';
        layer.src = rec.src;
      }
      slot.appendChild(layer); // newest layer on top, previous one fades out underneath
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (slot.dataset.current !== key) return;
        slot.querySelectorAll('.media__img').forEach((l) => l.classList.toggle('is-on', l === layer));
      }));
    };
    if (rec.state === 'loading') rec.waiters.push(apply);
    else apply();
  }

  /* ── Hover highlight ─────────────────────────────────── */
  let hoverArmed = true; // false after a screen or step change, until the mouse really moves
  function initHover() {
    document.querySelectorAll('.hl-scope').forEach((scope) => {
      const targets = [...scope.querySelectorAll('.hl')].filter((t) => t.closest('.hl-scope') === scope);
      const pane = scope.closest('.pane');
      const slot = pane ? pane.querySelector('.media[data-group]') : null;

      const activate = (t, byKeyboard) => {
        if (!hoverArmed && !byKeyboard) return; // content changed under a resting cursor
        scope.classList.add('is-hovering');
        targets.forEach((x) => x.classList.toggle('is-active', x === t));
        if (t.dataset.media) setMedia(slot, t.dataset.media);
      };
      const release = () => {
        scope.classList.remove('is-hovering');
        targets.forEach((x) => x.classList.remove('is-active'));
        // the image stays on the last hovered item
      };

      scope.addEventListener('pointerover', (e) => {
        if (e.pointerType === 'touch') return;
        const t = e.target.closest('.hl');
        if (t && targets.includes(t)) activate(t);
      });
      scope.addEventListener('pointerleave', release);
      scope.addEventListener('focusin', (e) => {
        const t = e.target.closest('.hl');
        if (t && targets.includes(t)) activate(t, true);
      });
      scope.addEventListener('focusout', (e) => {
        if (!scope.contains(e.relatedTarget)) release();
      });
      scope._release = release;
      scope._activate = (t) => { if (targets.includes(t) && !t.classList.contains('is-active')) activate(t); };
    });
  }
  /* Wheel scrolling swaps the content under a resting cursor, and the browser
     then reports a hover on whatever landed there. A highlight should answer the
     user's hand, not the scroll, so after a screen or step change nothing lights
     up until the mouse actually moves. The browser's own idea of what is under
     the cursor can stay stale after such a swap (until a click), so every real
     mouse move checks the point itself instead of waiting for pointerover. */
  const pointer = { x: -1, y: -1 };
  const ARM_PX = 3; // movement that counts as the user moving the mouse
  let hitRaf = 0;
  function onMove(e) {
    if (e.pointerType === 'touch') return;
    const moved = pointer.x < 0 || Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) >= ARM_PX;
    if (!moved) return; // synthetic re-hover after a scroll reports the same position
    pointer.x = e.clientX; pointer.y = e.clientY;
    hoverArmed = true;
    if (!hitRaf) hitRaf = requestAnimationFrame(() => { hitRaf = 0; syncHover(); });
  }
  document.addEventListener('pointermove', onMove, { capture: true, passive: true });
  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  window.addEventListener('wheel', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer.x = -1; pointer.y = -1; });
  function syncHover() {
    if (pointer.x < 0 || !hoverArmed) return;
    const el = document.elementFromPoint(pointer.x, pointer.y);
    // scopes the cursor has left let go; the one it is in lights the item under it
    document.querySelectorAll('.hl-scope.is-hovering').forEach((sc) => {
      if (!el || !sc.contains(el)) sc._release();
    });
    const t = el && el.closest('.hl');
    const scope = t && t.closest('.hl-scope');
    if (scope && scope._activate) scope._activate(t);
  }
  function disarmHover() {
    hoverArmed = false;
    document.querySelectorAll('.hl-scope').forEach((sc) => sc._release && sc._release());
  }

  const releaseIn = (el) => {
    if (el._release) el._release();
    el.querySelectorAll('.hl-scope').forEach((s) => s._release && s._release());
  };

  /* ── Programmatic scroll (buttons, diagram nodes) ────── */
  let scrollRaf = 0;
  let programmaticUntil = 0; // buttons and circles scroll on their own; stops don't apply
  const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  function cancelScroll() {
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
  }
  function smoothScrollTo(y) {
    const maxY = root.scrollHeight - window.innerHeight;
    const to = clamp(Math.round(y), 0, maxY);
    cancelScroll();
    const from = window.scrollY;
    const dy = to - from;
    if (Math.abs(dy) < 2) return;
    if (reduceMotion.matches) { window.scrollTo(0, to); return; }
    const duration = clamp(Math.abs(dy) * 0.5, 600, 900);
    programmaticUntil = performance.now() + duration + 120;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      window.scrollTo(0, from + dy * easeInOutCubic(p));
      scrollRaf = p < 1 ? requestAnimationFrame(step) : 0;
    };
    scrollRaf = requestAnimationFrame(step);
  }
  ['wheel', 'touchstart', 'keydown'].forEach((type) => {
    window.addEventListener(type, cancelScroll, { passive: true });
  });

  /* ── Screens ─────────────────────────────────────────── */
  function createSteps(el) {
    const panes = [...el.querySelectorAll('.pane')];
    return {
      setStep(k) {
        panes.forEach((p, i) => {
          const active = i === k;
          p.dataset.pos = active ? 'active' : (i < k ? 'before' : 'after');
          p.inert = !active;
          if (!active) releaseIn(p);
          // entering (or leaving) a step resets its image to the group image
          p.querySelectorAll('.media[data-group]').forEach((slot) => setMedia(slot, slot.dataset.group));
        });
      },
    };
  }

  function createCarousel(el) {
    const track = el.querySelector('.track');
    const rail = el.querySelector('.rail');
    const cards = [...track.children];
    const prev = el.querySelector('[data-dir="-1"]');
    const next = el.querySelector('[data-dir="1"]');
    const self = { holdIn: 0, travel: 1, holdOut: 0, segStart: 0 };
    let maxShift = 0;
    let pitch = 1;
    let x = 0;
    let target = 0;
    let raf = 0;
    let last = 0;

    function tick(t) {
      raf = 0;
      const dt = last ? Math.min(64, t - last) : 16.7;
      last = t;
      if (reduceMotion.matches || root.classList.contains('is-booting')) x = target;
      else x += (target - x) * (1 - Math.exp(-dt / FOLLOW_MS));
      if (Math.abs(target - x) < 0.25) x = target;
      track.style.transform = `translate3d(${(-x).toFixed(2)}px, 0, 0)`;
      if (x !== target) raf = requestAnimationFrame(tick);
    }

    self.measure = (vh) => {
      pitch = cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : 1;
      maxShift = Math.max(0, track.scrollWidth - rail.clientWidth);
      self.holdIn = vh * CAROUSEL_IN;
      self.travel = Math.max(1, maxShift); // 1px of scroll moves the cards 1px
      self.holdOut = vh * CAROUSEL_OUT;
    };
    self.scrub = (local) => {
      const to = clamp((local - self.holdIn) / self.travel, 0, 1) * maxShift;
      // cards sliding under a resting cursor are not a hover; wait for the mouse to move
      if (Math.abs(to - target) > 0.5) disarmHover();
      target = to;
      prev.disabled = target <= 1;
      next.disabled = target >= maxShift - 1;
      if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
    };
    self.setStep = () => {};

    /* Arriving from above, the cards start from their resting position (left
       margin intact). The rest of the swipe that switched the screen, and its
       momentum, is absorbed, so only a new scroll starts moving them.
       The same happens when the last card arrives: the swipe stops there, and
       only a new scroll goes on to the next screen. */
    let settleUntil = 0;
    let settleCap = 0;
    let endUntil = 0;
    let endCap = 0;
    let atEnd = false;
    let lastLocal = 0;
    self.arrive = () => {
      const now = performance.now();
      settleUntil = now + CAROUSEL_SETTLE;
      settleCap = now + CAROUSEL_SETTLE_MAX;
      x = target = 0;
      track.style.transform = 'translate3d(0, 0, 0)';
    };
    let lastAbs = 0;
    let lastT = 0;
    window.addEventListener('wheel', (e) => {
      const now = performance.now();
      const abs = Math.abs(e.deltaY);
      // momentum only fades; a delta that grows again is the user's next swipe
      const prev = now - lastT > 200 ? 0 : lastAbs;
      const newSwipe = prev > 0 && abs > prev * 1.5 + 6;
      lastAbs = abs; lastT = now;
      if (newSwipe) { settleUntil = 0; endUntil = 0; return; }
      if (now < settleUntil) settleUntil = Math.min(settleCap, Math.max(settleUntil, now + 140));
      if (now < endUntil) endUntil = Math.min(endCap, Math.max(endUntil, now + 140));
    }, { passive: true });
    const pin = (local) => {
      window.scrollTo({ top: deckTop() + self.segStart + local, behavior: 'instant' });
      return local;
    };
    self.settle = (local) => {
      const now = performance.now();
      const down = local > lastLocal;
      const rest = self.holdIn * 0.5;
      const end = self.holdIn + self.travel;
      if (now < settleUntil && local > rest) local = pin(rest);
      if (local < end - 2) atEnd = false;
      else if (!atEnd && down && local > end) {
        atEnd = true;
        endUntil = now + CAROUSEL_SETTLE;
        endCap = now + CAROUSEL_SETTLE_MAX;
      }
      if (now < endUntil && local > end) local = pin(end);
      lastLocal = local;
      return local;
    };

    function jump(dir) {
      const idx = target / pitch;
      let to = dir > 0 ? (Math.floor(idx + 0.02) + 1) * pitch : (Math.ceil(idx - 0.02) - 1) * pitch;
      to = clamp(to, 0, maxShift);
      if (dir > 0 && maxShift - to < pitch * 0.5) to = maxShift;
      smoothScrollTo(deckTop() + self.segStart + self.holdIn + (maxShift ? (to / maxShift) * self.travel : 0));
    }
    prev.addEventListener('click', () => jump(-1));
    next.addEventListener('click', () => jump(1));
    return self;
  }

  function createYear(el) {
    const list = el.querySelector('.periods');
    const items = [...list.children];
    let shown = 0;
    let target = 0;
    let running = false;

    function apply(k) {
      list.classList.toggle('is-open', k > 0);
      items.forEach((it, i) => {
        const open = i + 1 === k;
        it.classList.toggle('is-open', open);
        const slot = it.querySelector('.media');
        setMedia(slot, open ? it.dataset.openMedia : slot.dataset.group);
        it.querySelector('.period__detail').inert = !open;
        it.querySelector('.period__btn').tabIndex = k > 0 ? -1 : 0;
      });
      releaseIn(list);
      disarmHover();
    }
    async function run() {
      if (running) return;
      running = true;
      while (shown !== target) {
        if (shown !== 0) {           // fold back to the overview first
          apply(0);
          shown = 0;
          await wait(YEAR_COLLAPSE);
          continue;
        }
        const k = target;
        apply(k);
        shown = k;
        await wait(YEAR_EXPAND);
      }
      running = false;
    }
    apply(0);
    let leaveTimer = 0;
    return {
      // leaving the screen with a period open (fast scroll, scrollbar, Home key):
      // once it has faded out, fold back to the overview so it returns clean
      onActive(on) {
        clearTimeout(leaveTimer);
        if (on) return;
        leaveTimer = setTimeout(() => {
          if (el.dataset.pos === 'active') return;
          target = 0;
          if (!running) { apply(0); shown = 0; }
        }, 520);
      },
      // steps alternate overview / period: 0 overview, 1 1학기, 2 overview, 3 방학 & 캠프 …
      // so moving on from an open period always stops on the overview first
      setStep(k) { target = k % 2 ? (k + 1) / 2 : 0; run(); },
      resize() {
        const w = list.clientWidth;
        el.style.setProperty('--detail-w', `${Math.max(0, w - 467)}px`);
      },
    };
  }

  /* ── Hero ────────────────────────────────────────────── */
  function createHero(el) {
    const hero = el.querySelector('.hero');
    const nums = [...hero.querySelectorAll('.hero__num img')];
    const logos = [...hero.querySelectorAll('.hero__logo')].map((wrap) => ({
      wrap,
      canvas: wrap.querySelector('canvas'),
      ctx: wrap.querySelector('canvas').getContext('2d'),
      offset: wrap.classList.contains('hero__logo--low') ? 78 : 0, // half a turn apart: both ease and speed up together, in opposite shapes
    }));
    const cross = hero.querySelector('.hero__cross');
    const crossV = cross.querySelector('.cross-v');
    const crossH = cross.querySelector('.cross-h');
    const crossLabel = cross.querySelector('.cross-label');

    let active = false;
    let raf = 0;
    let last = 0;

    /* 1 → 12: every stage, 12 included, runs at one pace (120 ms),
       so the count loops continuously. */
    const NUM_STEP = 120;
    const NUM_DUR = nums.map(() => NUM_STEP);
    const NUM_CYCLE = NUM_DUR.reduce((a, b) => a + b, 0);
    const NUM_LEAD = 520; // "1" waits while the hero fades in
    let numIdx = nums.length - 1;
    let numT = 0;
    let numReady = false;
    Promise.all(nums.map((im) => (im.decode ? im.decode().catch(() => {}) : null))).then(() => {
      numReady = true;
      kick();
    });
    function showNum(i) {
      if (i === numIdx) return;
      nums[numIdx].classList.remove('is-on');
      nums[i].classList.add('is-on');
      numIdx = i;
    }

    /* Rotating pixel logos: 155 frames @ 30 fps drawn to canvas */
    const LOGO_FPS = 30;
    let frames = null;
    let frameIdx = -1;
    let logoT = 0;
    function loadLogo() {
      if (reduceMotion.matches) return;
      const s = document.createElement('script');
      s.src = 'assets/motion/phi-logo-data.js';
      s.async = true;
      s.onload = decodeLogo;
      document.body.appendChild(s);
    }
    function decodeLogo() {
      const d = window.PHI_LOGO;
      if (!d) return;
      const bin = atob(d.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      frames = [];
      let o = 0;
      d.counts.forEach((count) => {
        const arr = new Float32Array(count * 3);
        for (let j = 0; j < count; j += 1) {
          const cell = bytes[o] | (bytes[o + 1] << 8);
          const size = bytes[o + 2] * d.q;
          o += 3;
          const c = cell % d.cols;
          const r = (cell / d.cols) | 0;
          arr[j * 3] = d.ox + c * d.step - size / 2;
          arr[j * 3 + 1] = d.oy + r * d.step - size / 2;
          arr[j * 3 + 2] = size;
        }
        frames.push(arr);
      });
      delete window.PHI_LOGO;
      sizeCanvas();
      logos.forEach((l) => l.wrap.classList.add('is-live'));
      kick();
    }
    function sizeCanvas() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      logos.forEach(({ canvas }) => {
        const r = canvas.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(r.width * dpr));
        canvas.height = Math.max(1, Math.round(r.height * dpr));
      });
      if (frames) drawLogos(Math.max(0, frameIdx));
    }
    function drawLogos(f) {
      logos.forEach(({ canvas, ctx, offset }) => {
        const a = frames[(f + offset) % frames.length];
        const k = canvas.width / 1080;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#FAFAFC';
        ctx.beginPath();
        for (let j = 0; j < a.length; j += 3) {
          const s = a[j + 2] * k;
          ctx.rect(a[j] * k, a[j + 1] * k, s, s);
        }
        ctx.fill();
      });
    }

    /* Crosshair: follows the pointer on a spring (slight overshoot, then settles) */
    const STIFFNESS = 240;
    const DAMPING = 2 * Math.sqrt(STIFFNESS) * 0.74; // damping ratio 0.74
    const sp = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, on: false };
    let heroW = 1;
    let heroH = 1;
    hero.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const r = hero.getBoundingClientRect();
      heroW = r.width;
      heroH = r.height;
      sp.tx = e.clientX - r.left;
      sp.ty = e.clientY - r.top;
      if (!sp.on) {
        // the first event only sets a reference point: browsers report the resting
        // cursor on load and on screen changes, so wait for a real movement
        if (!sp.armed) { sp.armed = true; sp.ax = sp.tx; sp.ay = sp.ty; return; }
        if (Math.hypot(sp.tx - sp.ax, sp.ty - sp.ay) < 6) return;
        sp.on = true;
        sp.x = sp.tx; sp.y = sp.ty; sp.vx = 0; sp.vy = 0;
        renderCross();
        cross.classList.add('is-on');
      }
      kick();
    });
    hero.addEventListener('pointerleave', () => {
      sp.on = false;
      sp.armed = false;
      cross.classList.remove('is-on');
    });
    /* The crosshair wears the φ grid's own colour and lights up only while it
       sits exactly on one of the grid lines (per axis). */
    const HIT_PX = 1;
    let gridX = [];
    let gridY = [];
    let gridFor = '';
    function measureGrid() {
      const key = `${heroW}x${heroH}`;
      if (key === gridFor) return;
      const r = hero.getBoundingClientRect();
      // exact sub-pixel positions (the entrance scale only stretches lines along their own length)
      gridX = [...hero.querySelectorAll('.gl--v')].map((g) => g.getBoundingClientRect().left - r.left);
      gridY = [...hero.querySelectorAll('.gl--h')].map((g) => g.getBoundingClientRect().top - r.top);
      gridFor = key;
    }
    function renderCross() {
      crossV.style.transform = `translate3d(${sp.x.toFixed(1)}px, 0, 0)`;
      crossH.style.transform = `translate3d(0, ${sp.y.toFixed(1)}px, 0)`;
      measureGrid();
      crossV.classList.toggle('is-hit', gridX.some((gx) => Math.abs(sp.x - gx) < HIT_PX));
      crossH.classList.toggle('is-hit', gridY.some((gy) => Math.abs(sp.y - gy) < HIT_PX));
      const bw = Math.min(heroW, 1920);
      const bl = (heroW - bw) / 2;
      const fx = Math.round(((sp.x - bl) / bw) * 1920);
      const fy = Math.round((sp.y / heroH) * 1080);
      crossLabel.textContent = `(${fx}, ${fy})`;
      const flip = sp.x > heroW - 120;
      const lx = flip ? sp.x - 10 - crossLabel.offsetWidth : sp.x + 10;
      crossLabel.style.transform = `translate3d(${lx.toFixed(1)}px, ${(sp.y + 10).toFixed(1)}px, 0)`;
    }

    function tick(t) {
      raf = 0;
      const dt = last ? Math.min(50, t - last) : 16.7;
      last = t;
      let busy = false;

      if (!reduceMotion.matches) {
        if (numReady) {
          numT += dt;
          if (numT >= 0) {
            numT %= NUM_CYCLE;
            let acc = 0;
            let i = 0;
            while (i < nums.length - 1 && numT >= acc + NUM_DUR[i]) { acc += NUM_DUR[i]; i += 1; }
            showNum(i);
          }
          busy = true;
        }
        if (frames) {
          logoT += dt;
          const f = Math.floor(logoT / (1000 / LOGO_FPS)) % frames.length;
          if (f !== frameIdx) { frameIdx = f; drawLogos(f); }
          busy = true;
        }
      }

      if (sp.on) {
        if (reduceMotion.matches) {
          sp.x = sp.tx; sp.y = sp.ty; sp.vx = 0; sp.vy = 0;
        } else {
          let remain = dt / 1000;
          while (remain > 0) {
            const h = Math.min(remain, 1 / 120);
            remain -= h;
            sp.vx += (-STIFFNESS * (sp.x - sp.tx) - DAMPING * sp.vx) * h;
            sp.vy += (-STIFFNESS * (sp.y - sp.ty) - DAMPING * sp.vy) * h;
            sp.x += sp.vx * h;
            sp.y += sp.vy * h;
          }
        }
        renderCross();
        if (Math.abs(sp.x - sp.tx) + Math.abs(sp.y - sp.ty) + Math.abs(sp.vx) + Math.abs(sp.vy) > 0.05) busy = true;
      }

      if (busy && active) raf = requestAnimationFrame(tick);
      else last = 0;
    }
    function kick() {
      if (!raf && active) { last = 0; raf = requestAnimationFrame(tick); }
    }

    if (document.readyState === 'complete') loadLogo();
    else window.addEventListener('load', loadLogo, { once: true });

    return {
      setStep() {},
      resize: sizeCanvas,
      onActive(on) {
        if (on === active) return;
        active = on;
        if (on) {
          sp.on = false;        // the crosshair waits for the mouse to move again
          sp.armed = false;
          cross.classList.remove('is-on');
          showNum(0);           // restart the count from 1 every time the hero appears
          numT = -NUM_LEAD;
          kick();
        } else {
          sp.on = false;
          sp.armed = false;
          cross.classList.remove('is-on');
        }
      },
    };
  }

  /* ── Deck ────────────────────────────────────────────── */
  const deck = document.querySelector('.deck');
  const gnb = document.querySelector('.gnb');
  const deckTop = () => deck.getBoundingClientRect().top + window.scrollY;

  const screens = [...deck.querySelectorAll('.screen')].map((el) => {
    const kind = el.dataset.screen;
    let s;
    if (kind === 'hero') s = createHero(el);
    else if (kind === 'carousel') s = createCarousel(el);
    else if (kind === 'year') s = createYear(el);
    else s = createSteps(el);
    s.el = el;
    s.kind = kind;
    s.steps = Number(el.dataset.steps || 1);
    return s;
  });

  let segs = [];
  let cur = -1;
  let stepPx = 1;

  function layout() {
    const vh = window.innerHeight;
    stepPx = vh * STEP_VH;
    segs = [];
    let y = 0;
    screens.forEach((s, si) => {
      if (s.resize) s.resize();
      if (s.kind === 'carousel') {
        s.measure(vh);
        s.segStart = y;
        const len = s.holdIn + s.travel + s.holdOut;
        segs.push({ si, step: 0, start: y, len });
        y += len;
        return;
      }
      for (let k = 0; k < s.steps; k += 1) {
        let len = stepPx;
        if (s.kind === 'hero') len = stepPx * HERO_STEP;
        else if (k < s.steps - 1) len = stepPx * (s.kind === 'year' ? YEAR_STEP : INNER_STEP); // the next step is in this section
        if (si === screens.length - 1 && k === s.steps - 1) len = stepPx * LAST_DWELL;
        segs.push({ si, step: k, start: y, len });
        y += len;
      }
    });
    deck.style.height = `${Math.round(vh + y + vh * TAIL)}px`;
  }

  function setScreenPos(s, pos) {
    if (s.el.dataset.pos === pos) return;
    s.el.dataset.pos = pos;
    s.el.inert = pos !== 'active';
    if (pos !== 'active') releaseIn(s.el);
    if (s.onActive) s.onActive(pos === 'active');
  }

  /* 인재상 overview: arriving from above, the diagram rests, plays its
     entrance in reverse and hands over to the first list by itself. Any
     scroll takes over at once — downward finishes the switch, upward brings
     the circles back. */
  const talent = screens.find((s) => s.el.id === 'talent');
  const diagram = talent && talent.el.querySelector('.diagram');
  const autoT = { hold: 0, shrink: 0, phase: '' };
  function stopAuto(keepShrunk) {
    clearTimeout(autoT.hold); clearTimeout(autoT.shrink);
    if (!keepShrunk && diagram) diagram.classList.remove('is-leaving');
    autoT.phase = '';
  }
  function jumpToStep(si, step) {
    const g = segs.find((x) => x.si === si && x.step === step);
    if (!g) return;
    cancelScroll();
    window.scrollTo({ top: deckTop() + g.start + Math.min(g.len * 0.35, stepPx * 0.35), behavior: 'instant' });
  }
  function startAuto() {
    stopAuto();
    if (!diagram || reduceMotion.matches) return;
    const si = screens.indexOf(talent);
    autoT.phase = 'hold';
    autoT.hold = setTimeout(() => {
      autoT.phase = 'shrink';
      diagram.classList.add('is-leaving');
      autoT.shrink = setTimeout(() => { stopAuto(true); jumpToStep(si, 1); }, TALENT_SHRINK);
    }, TALENT_ENTER + TALENT_HOLD + (talent.el.dataset.from === 'hero' ? HERO_LAG : 0));
  }
  function userIntent(dir) {
    if (!autoT.phase) return;
    if (autoT.phase === 'shrink' && dir > 0) { stopAuto(true); jumpToStep(screens.indexOf(talent), 1); return; }
    stopAuto(); // resting: the user drives from here; shrinking upward: circles pop back
  }
  window.addEventListener('wheel', (e) => userIntent(Math.sign(e.deltaY)), { passive: true });
  window.addEventListener('touchstart', () => userIntent(0), { passive: true });
  window.addEventListener('keydown', (e) => {
    const down = ['ArrowDown', 'PageDown', ' ', 'End'].includes(e.key);
    const up = ['ArrowUp', 'PageUp', 'Home'].includes(e.key);
    if (down || up) userIntent(down ? 1 : -1);
  });

  function goTo(n) {
    const prev = cur;
    cur = n;
    const g = segs[n];
    const prevSi = prev >= 0 ? segs[prev].si : -1;
    const entered = screens[g.si].el;
    if (prevSi !== g.si) {
      if (prevSi >= 0 && screens[prevSi].kind === 'hero') entered.dataset.from = 'hero';
      else delete entered.dataset.from;
    } else delete entered.dataset.from; // later steps on the same screen keep the usual timing
    if (talent && screens[g.si] === talent && g.step === 0) {
      if (prev < n) startAuto(); else stopAuto();
    } else if (autoT.phase) stopAuto(autoT.phase === 'shrink'); // a shrunk diagram stays shrunk while it fades out
    screens.forEach((s, i) => setScreenPos(s, i === g.si ? 'active' : (i < g.si ? 'before' : 'after')));
    screens[g.si].setStep(g.step);
    disarmHover();
  }

  /* One swipe, one step: however fast the wheel or trackpad goes, the swipe
     that changes a step ends on that step. Its remaining momentum is absorbed
     (extended while momentum keeps arriving, up to STOP_MAX), so the next
     step takes a new scroll. 연간 구조 therefore always stops on the overview
     between periods, in both directions. The 수업 장치 carousel handles its
     own arrival and last card. */
  const STOP_MS = 700;
  const STOP_MAX = 1200;
  const stop = { seg: -1, until: 0, cap: 0, lastAbs: 0, lastT: 0 };
  window.addEventListener('wheel', (e) => {
    const now = performance.now();
    const abs = Math.abs(e.deltaY);
    // momentum only fades; a delta that grows again is the user's next swipe
    const fresh = now - stop.lastT > 200 ? 0 : stop.lastAbs;
    const newSwipe = fresh > 0 && abs > fresh * 1.5 + 6;
    stop.lastAbs = abs; stop.lastT = now;
    if (now >= stop.until) return;
    if (newSwipe) { stop.until = 0; return; }
    stop.until = Math.min(stop.cap, Math.max(stop.until, now + 140));
  }, { passive: true });
  function holdStop(y) {
    const now = performance.now();
    if (stop.seg < 0 || now >= stop.until || now < programmaticUntil || !segs[stop.seg]) return y;
    const g = segs[stop.seg];
    const held = clamp(y, g.start, g.start + g.len);
    if (held !== y) window.scrollTo({ top: deckTop() + held, behavior: 'instant' });
    return held;
  }

  function update() {
    if (!segs.length) return;
    const y = holdStop(window.scrollY - deckTop());
    let n = segs.findIndex((g) => y < g.start + g.len);
    if (n < 0) n = segs.length - 1;
    if (cur >= 0 && n !== cur) {
      const g = segs[cur];
      const h = HYSTERESIS * stepPx;
      if (n > cur && y < g.start + g.len + h) n = cur;
      else if (n < cur && y > g.start - h) n = cur;
    }
    if (n !== cur) {
      const from = cur >= 0 ? segs[cur].si : -1;
      const now = performance.now();
      const ns = screens[segs[n].si];
      if (ns.kind !== 'carousel' && cur >= 0 && now > programmaticUntil) {
        Object.assign(stop, { seg: n, until: now + STOP_MS, cap: now + STOP_MAX });
      } else stop.seg = -1;
      goTo(n);
      const s = screens[segs[n].si];
      if (s.arrive && from >= 0 && from < segs[n].si) s.arrive();
    }
    screens.forEach((s, si) => {
      if (s.kind !== 'carousel') return;
      let local = y - s.segStart;
      if (segs[cur] && segs[cur].si === si) local = s.settle(local);
      s.scrub(local);
    });
  }

  // Clickable shortcuts: diagram circles, period cards. They jump straight to
  // the target step: a smooth scroll would pass through the steps in between
  // (e.g. open 1학기 and fold it again on the way to 방학 & 캠프).
  deck.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-goto]');
    if (!btn) return;
    const si = screens.findIndex((s) => s.el.contains(btn));
    if (si >= 0) jumpToStep(si, Number(btn.dataset.goto));
  });

  // "+" buttons point to detail pages that do not exist yet
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.more');
    if (a && a.getAttribute('href') === '#') e.preventDefault();
  });

  /* GNB: hide while scrolling down, return on scroll up (kept on the hero) */
  let lastY = window.scrollY;
  function updateGnb() {
    const y = window.scrollY;
    const onHero = cur <= 0 || (segs[cur] && screens[segs[cur].si].kind === 'hero');
    if (onHero || y < 40) {
      gnb.classList.remove('is-hidden');
      lastY = y;
      return;
    }
    const dy = y - lastY;
    if (Math.abs(dy) < 6) return;
    gnb.classList.toggle('is-hidden', dy > 0);
    lastY = y;
  }
  gnb.addEventListener('focusin', () => gnb.classList.remove('is-hidden'));

  let scheduled = false;
  window.addEventListener('scroll', () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
      updateGnb();
    });
  }, { passive: true });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { layout(); update(); }, 100);
  });

  // Warm the image cache once the page is idle
  function warmImages() {
    document.querySelectorAll('[data-group], [data-media], [data-open-media]').forEach((el) => {
      probe(el.dataset.group || el.dataset.media || el.dataset.openMedia);
    });
  }

  function boot() {
    initHover();
    layout();
    // let the first frame render with everything hidden, then play the entrance
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.classList.remove('is-booting');
      requestAnimationFrame(update);
    }));
    if ('requestIdleCallback' in window) window.requestIdleCallback(warmImages, { timeout: 2500 });
    else setTimeout(warmImages, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { layout(); update(); });
})();
