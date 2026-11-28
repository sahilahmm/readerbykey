// A book as real pages: the text flows into screen-sized columns, a swipe turns exactly one page.
// host = the reading area; fill(flow) puts the book's content into the flow element.
export function createPages({ host, fill, start = 0, onPage, onTap }) {
  host.replaceChildren();
  const flow = document.createElement("div");
  flow.className = "ep-flow";
  host.append(flow);
  fill(flow);

  let W = 1, n = 1, cur = 0, x = 0, gl = 0, dead = false;
  const PAD = 26;

  function measure(keep) {
    W = host.clientWidth || 1;
    const cs = getComputedStyle(host);
    const H = host.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    flow.style.cssText = `width:${W}px;height:${H}px;padding:0 ${PAD}px;column-width:${W - PAD * 2}px;column-gap:${PAD * 2}px;`;
    flow.style.setProperty("--ph", `${H}px`);
    n = Math.max(1, Math.round((flow.scrollWidth + PAD) / W));
    cur = Math.max(0, Math.min(n - 1, Math.round(keep * (n - 1))));
    set(cur * W);
    announce();
  }
  const set = (v) => {
    x = v;
    flow.style.transform = `translate3d(${-v}px,0,0)`;
  };
  const announce = () => onPage(cur, n);

  function glide(to, ms = 260) {
    cancelAnimationFrame(gl);
    const from = x, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      set(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1 && !dead) gl = requestAnimationFrame(step);
      else gl = 0;
    };
    gl = requestAnimationFrame(step);
  }
  function go(i, smooth = true) {
    i = Math.max(0, Math.min(n - 1, i));
    const moved = i !== cur;
    cur = i;
    if (smooth) glide(i * W);
    else set(i * W);
    if (moved) announce();
  }

  // touch: drag the page, release turns exactly one
  let g = null;
  host.style.touchAction = "none";
  const onStart = (e) => {
    if (e.touches.length !== 1) return void (g = null);
    cancelAnimationFrame(gl);
    gl = 0;
    const t = e.touches[0];
    g = { x: t.clientX, y: t.clientY, t: Date.now(), left: x, i: cur, moved: false, trail: [[performance.now(), t.clientX]] };
  };
  const onMove = (e) => {
    if (!g || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    if (Math.abs(t.clientX - g.x) > 10 || Math.abs(t.clientY - g.y) > 10) g.moved = true;
    set(Math.max(0, Math.min((n - 1) * W, g.left - (t.clientX - g.x))));
    const now = performance.now();
    g.trail.push([now, t.clientX]);
    while (g.trail.length > 2 && now - g.trail[0][0] > 120) g.trail.shift();
  };
  const onEnd = (e) => {
    const k = g;
    g = null;
    if (!k) return;
    const c = e.changedTouches[0];
    const dx = c.clientX - k.x;
    if (!k.moved && Date.now() - k.t < 300) {
      // a tap: the edges turn the page, the middle shows or hides the toolbar
      const r = host.getBoundingClientRect(), fx = (c.clientX - r.left) / r.width;
      set(k.i * W);
      if (fx < 0.22) return go(k.i - 1);
      if (fx > 0.78) return go(k.i + 1);
      return onTap();
    }
    const tr = k.trail, span = Math.max(1, tr[tr.length - 1][0] - tr[0][0]);
    const v = (tr[tr.length - 1][1] - tr[0][1]) / span;
    const turn = Math.abs(dx) > W * 0.2 || (Math.abs(v) > 0.35 && Math.abs(dx) > 24);
    go(k.i + (turn ? (dx < 0 ? 1 : -1) : 0));
  };
  const onCancel = () => {
    g = null;
    go(cur);
  };
  host.addEventListener("touchstart", onStart, { passive: true });
  host.addEventListener("touchmove", onMove, { passive: false });
  host.addEventListener("touchend", onEnd, { passive: true });
  host.addEventListener("touchcancel", onCancel, { passive: true });
  // a click is handled by the touches above; stop the page-wide tap handler from also firing
  const onClick = (e) => e.stopImmediatePropagation();
  host.addEventListener("click", onClick, true);

  let lastW = 0, lastH = 0, pending = 0;
  const ro =
    typeof ResizeObserver !== "undefined" &&
    new ResizeObserver(() => {
      if (host.clientWidth === lastW && host.clientHeight === lastH) return;
      const first = !lastW;
      lastW = host.clientWidth;
      lastH = host.clientHeight;
      if (first) return;
      clearTimeout(pending);
      pending = setTimeout(() => !dead && measure(n > 1 ? cur / (n - 1) : 0), 80);
    });
  lastW = host.clientWidth;
  lastH = host.clientHeight;
  if (ro) ro.observe(host);

  measure(start);
  // pictures and fonts arriving later change the page count: flow again once they have
  const later = setTimeout(() => !dead && measure(n > 1 ? cur / (n - 1) : 0), 600);

  return {
    index: () => cur,
    count: () => n,
    fraction: () => (n > 1 ? cur / (n - 1) : 0),
    goto: (i, smooth) => go(i, smooth),
    refit() {
      measure(n > 1 ? cur / (n - 1) : 0);
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(gl);
      clearTimeout(later);
      clearTimeout(pending);
      host.removeEventListener("touchstart", onStart);
      host.removeEventListener("touchmove", onMove);
      host.removeEventListener("touchend", onEnd);
      host.removeEventListener("touchcancel", onCancel);
      host.removeEventListener("click", onClick, true);
      if (ro) ro.disconnect();
      host.style.touchAction = "";
      host.replaceChildren();
    },
  };
}
