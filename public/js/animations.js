(function () {
  'use strict';

  // ─── 1. Animated Canvas Lines (Framer-style flowing lines) ───
  const canvas = document.createElement('canvas');
  canvas.id = 'ambient-canvas';
  canvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;opacity:0.5;';
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  let w, h, lines = [];

  function resizeCanvas() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  class FlowLine {
    constructor() {
      this.reset();
    }
    reset() {
      this.y = Math.random() * h;
      this.x = -60;
      this.length = 80 + Math.random() * 200;
      this.speed = 0.15 + Math.random() * 0.35;
      this.amplitude = 15 + Math.random() * 40;
      this.frequency = 0.005 + Math.random() * 0.015;
      this.phase = Math.random() * Math.PI * 2;
      this.hue = 240 + Math.random() * 30;
      this.alpha = 0.06 + Math.random() * 0.08;
    }
    update() {
      this.x += this.speed;
      this.y += Math.sin(this.x * this.frequency + this.phase) * 0.15;
      if (this.x > w + 60) this.reset();
    }
    draw() {
      ctx.beginPath();
      for (let i = 0; i < this.length; i += 2) {
        const px = this.x + i;
        const py = this.y + Math.sin((this.x + i) * this.frequency + this.phase) * this.amplitude;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = `hsla(${this.hue}, 70%, 60%, ${this.alpha})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  const lineCount = Math.min(25, Math.floor((w * h) / 40000));
  for (let i = 0; i < lineCount; i++) lines.push(new FlowLine());

  function animateLines() {
    ctx.clearRect(0, 0, w, h);
    lines.forEach((l) => { l.update(); l.draw(); });
    requestAnimationFrame(animateLines);
  }
  animateLines();

  // ─── 2. Floating Ambient Particles ───
  const particleContainer = document.createElement('div');
  particleContainer.id = 'ambient-particles';
  particleContainer.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;overflow:hidden;';
  document.body.prepend(particleContainer);

  const particleCount = 20;
  for (let i = 0; i < particleCount; i++) {
    const dot = document.createElement('div');
    const size = 2 + Math.random() * 4;
    dot.style.cssText = `
      position:absolute;
      width:${size}px;height:${size}px;
      border-radius:50%;
      background:hsla(${210 + Math.random() * 30}, 70%, 60%, ${0.08 + Math.random() * 0.12});
      left:${Math.random() * 100}%;
      top:${Math.random() * 100}%;
      animation: particleFloat ${8 + Math.random() * 12}s ease-in-out infinite;
      animation-delay:${Math.random() * -10}s;
    `;
    particleContainer.appendChild(dot);
  }

  // ─── 3. Cursor Glow (Desktop only) ───
  if (!('ontouchstart' in window) && window.innerWidth >= 1024) {
    const glow = document.createElement('div');
    glow.id = 'cursor-glow';
    glow.style.cssText =
      'position:fixed;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,rgba(99,102,241,0.06) 0%,transparent 70%);pointer-events:none;z-index:1;transform:translate(-50%,-50%);transition:opacity 0.3s;';
    document.body.prepend(glow);
    let mx = -999, my = -999;
    document.addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; glow.style.opacity = '1'; });
    document.addEventListener('mouseleave', () => { glow.style.opacity = '0'; });
    function moveGlow() {
      glow.style.transform = `translate(${mx - 150}px, ${my - 150}px)`;
      requestAnimationFrame(moveGlow);
    }
    moveGlow();
  }

  // ─── 4. Ripple Effect on Buttons ───
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('.btn, .glass-card, .sidebar-link, .nav-link');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    const size = Math.max(rect.width, rect.height);
    ripple.style.cssText = `
      position:absolute;top:${e.clientY - rect.top - size / 2}px;
      left:${e.clientX - rect.left - size / 2}px;
      width:${size}px;height:${size}px;
      border-radius:50%;background:rgba(99,102,241,0.15);
      transform:scale(0);animation:rippleAnim 0.6s ease-out forwards;
      pointer-events:none;
    `;
    btn.style.position = 'relative';
    btn.style.overflow = 'hidden';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 700);
  });

  // ─── 5. Animated Number Counter ───
  function animateCounter(el) {
    const target = parseFloat(el.dataset.count || el.dataset.value || el.textContent.replace(/[^0-9.]/g, ''));
    if (isNaN(target)) return;
    const duration = 1200 + Math.random() * 800;
    const start = performance.now();
    const suffix = el.dataset.suffix || '';
    function tick(now) {
      const p = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.floor(ease * target) + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = target + suffix;
    }
    requestAnimationFrame(tick);
  }

  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        counterObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });
  document.querySelectorAll('.stat-val, [data-count]').forEach((el) => counterObserver.observe(el));

  // ─── 6. Enhanced Scroll Reveal with Stagger ───
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          const delay = parseFloat(entry.target.dataset.staggerDelay) || 0;
          if (delay) entry.target.style.transitionDelay = delay + 's';
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08, rootMargin: '0px 0px -40px 0px' }
  );

  function observeReveals() {
    document.querySelectorAll('.reveal, .reveal-scale, .reveal-left, .reveal-right, .glass-card, .stat-card, .premium-card, .challenge-hub').forEach((el) => {
      if (!el.classList.contains('visible')) revealObserver.observe(el);
    });
  }
  observeReveals();

  // Stagger parent children
  document.querySelectorAll('.stagger-grid, .clean-dashboard-grid, .features-grid').forEach((grid) => {
    Array.from(grid.children).forEach((child, i) => {
      child.style.setProperty('--stagger-i', i);
    });
  });

  // ─── 7. Smooth Page Transition ───
  (function pageTransition() {
    const overlay = document.createElement('div');
    overlay.id = 'page-transition';
    overlay.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;background:var(--bg,#f8fafc);z-index:99999;pointer-events:none;opacity:0;transition:opacity 0.4s ease;';
    document.body.appendChild(overlay);

    document.querySelectorAll('a[href]:not([target="_blank"]):not([href^="#"]):not([href^="javascript"])').forEach((a) => {
      a.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        const href = this.getAttribute('href');
        if (href && href.startsWith('/') && !href.startsWith('//')) {
          e.preventDefault();
          overlay.style.opacity = '1';
          setTimeout(() => { window.location.href = href; }, 350);
        }
      });
    });

    window.addEventListener('pageshow', () => { overlay.style.opacity = '0'; });
  })();

  // ─── 8. Active Nav Link Highlight ───
  const currentPath = window.location.pathname;
  document.querySelectorAll('.sidebar-link, .nav-link').forEach((link) => {
    const href = link.getAttribute('href');
    if (href && href !== '#' && currentPath.startsWith(href)) link.classList.add('active');
  });

  // ─── 9. Dynamic Mutation Watcher ───
  const mutationObs = new MutationObserver(() => {
    requestAnimationFrame(observeReveals);
  });
  if (document.body) mutationObs.observe(document.body, { childList: true, subtree: true });

  // ─── 10. Touch feedback class for mobile ───
  if ('ontouchstart' in window) {
    document.addEventListener('touchstart', () => document.body.classList.add('is-touching'), { passive: true });
  }

  // ─── 11. Inactivity fade for canvas (performance) ───
  let idleTimer;
  function resetIdle() {
    canvas.style.opacity = '0.5';
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { canvas.style.opacity = '0.08'; }, 5000);
  }
  ['mousemove', 'touchstart', 'scroll', 'click'].forEach((ev) =>
    document.addEventListener(ev, resetIdle, { passive: true })
  );
  resetIdle();

})();
