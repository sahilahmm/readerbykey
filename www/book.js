// Book view: every page fills the screen and a swipe turns it, with the phone's own snapping scroll.
// The finger moves the page, a quick flick carries it on, and it settles on a page every time.
export function createBook({ host, count, draw, release, onPage, onTap }) {
  host.replaceChildren();
  host.scrollLeft = 0;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "bp";
    slots.push({ el, node: null, busy: false, token: 0 });
    host.append(el);
  }
  let cur = -1;
  let raf = 0;
  let dead = false;
  let announced = false;
  const width = () => host.clientWidth || 1;

  async function fill(i) {
    const s = slots[i];
    if (s.node || s.busy) return;
    s.busy = true;
    const tok = ++s.token;
    try {
      const node = await draw(i, host.clientWidth, host.clientHeight);
      if (dead || tok !== s.token || Math.abs(i - cur) > 2) return release(node);
      s.el.replaceChildren(node);
      s.node = node;
      tilt();
    } catch {
      /* a page that fails to draw stays blank until the next swipe */
    } finally {
      s.busy = false;
    }
  }
  function drop(i) {
    const s = slots[i];
    s.token++;
    if (s.node) {
      release(s.node);
      s.node.remove();
      s.node = null;
    }
  }
  // a little depth: the page leaving swings away from its edge, the page arriving swings in
  function tilt() {
    const x = host.scrollLeft, w = width();
    for (let i = Math.max(0, cur - 1); i <= Math.min(count - 1, cur + 1); i++) {
      const n = slots[i].node;
      if (!n) continue;
      const t = Math.max(-1, Math.min(1, (i * w - x) / w)); // -1 gone left, 0 centred, 1 waiting right
      const a = Math.abs(t);
      n.style.transformOrigin = t < 0 ? "100% 50%" : "0% 50%";
      n.style.transform = a < 0.001 ? "" : `rotateY(${t * -28}deg) scale(${1 - a * 0.1})`;
      n.style.opacity = String(1 - a * 0.35);
    }
  }
  function update() {
    const idx = Math.max(0, Math.min(count - 1, Math.round(host.scrollLeft / width())));
    if (idx !== cur) {
      cur = idx;
      onPage(idx, announced);
      announced = true;
    }
    for (let i = 0; i < count; i++) {
      if (Math.abs(i - cur) <= 2) fill(i);
      else if (slots[i].node) drop(i);
    }
    tilt();
  }
  const onScroll = () => {
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
  };
  host.addEventListener("scroll", onScroll, { passive: true });
  host.addEventListener("click", onTap);
  // a short or quick swipe still turns the page: the snapping scroll alone only moves on past the halfway mark
  let t0 = null;
  const down = (e) => (t0 = e.touches.length === 1 ? { x: e.touches[0].clientX, t: Date.now(), i: Math.round(host.scrollLeft / width()) } : null);
  const up = (e) => {
    if (!t0) return;
    const dx = e.changedTouches[0].clientX - t0.x, dt = Math.max(1, Date.now() - t0.t), from = t0.i;
    t0 = null;
    const far = Math.abs(dx) > width() * 0.12, quick = Math.abs(dx) > 30 && Math.abs(dx) / dt > 0.35;
    if (far || quick) host.scrollTo({ left: Math.max(0, Math.min(count - 1, from + (dx < 0 ? 1 : -1))) * width(), behavior: "smooth" });
  };
  host.addEventListener("touchstart", down, { passive: true });
  host.addEventListener("touchend", up, { passive: true });
  host.addEventListener("touchcancel", () => (t0 = null), { passive: true });
  let lastW = host.clientWidth, lastH = host.clientHeight;
  const ro =
    typeof ResizeObserver !== "undefined" &&
    new ResizeObserver(() => {
      if (host.clientWidth === lastW && host.clientHeight === lastH) return;
      lastW = host.clientWidth;
      lastH = host.clientHeight;
      const keep = cur;
      for (let i = 0; i < count; i++) drop(i); // turned the phone: draw again at the new size
      host.scrollLeft = keep * width();
      update();
    });
  if (ro) ro.observe(host);

  return {
    index: () => Math.max(0, cur),
    goto(i, smooth) {
      i = Math.max(0, Math.min(count - 1, i));
      host.scrollTo({ left: i * width(), behavior: smooth ? "smooth" : "instant" });
      if (!smooth) update();
    },
    destroy() {
      dead = true;
      host.removeEventListener("scroll", onScroll);
      host.removeEventListener("click", onTap);
      host.removeEventListener("touchstart", down);
      host.removeEventListener("touchend", up);
      if (ro) ro.disconnect();
      for (let i = 0; i < count; i++) drop(i);
      host.replaceChildren();
    },
  };
}
