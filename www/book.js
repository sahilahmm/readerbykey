// Book view: every page fills the screen and a swipe turns it, with the phone's own snapping scroll.
// The finger moves the page, a quick flick carries it on, and it settles on a page every time.
// Pinch (or double-tap) zooms the page that is showing; while zoomed, one finger moves the page around.
const MAX_ZOOM = 4;

export function createBook({ host, count, draw, release, onPage, onTap }) {
  host.replaceChildren();
  host.scrollLeft = 0;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "bp";
    slots.push({ el, node: null, busy: false, token: 0, sharp: 1 });
    host.append(el);
  }
  let cur = -1;
  let raf = 0;
  let dead = false;
  let announced = false;
  let moving = 0; // time of the last scroll event: pages are drawn after the swipe has settled, never during it
  let idle = 0;
  const width = () => host.clientWidth || 1;

  // zoom of the page on screen
  const zm = { z: 1, x: 0, y: 0 };
  const node = () => (cur >= 0 ? slots[cur].node : null);

  async function fill(i, z = 1) {
    const s = slots[i];
    if (s.busy || (s.node && s.sharp >= z)) return;
    s.busy = true;
    const tok = ++s.token;
    try {
      const n = await draw(i, host.clientWidth, host.clientHeight, z);
      if (dead || tok !== s.token || Math.abs(i - cur) > 2) return release(n);
      const old = s.node;
      s.el.replaceChildren(n);
      s.node = n;
      s.sharp = z;
      if (old) release(old);
      if (i === cur && zm.z > 1) place();
      else tilt();
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
      s.sharp = 1;
    }
  }
  // a little depth: the page leaving swings away from its edge, the page arriving swings in
  function tilt() {
    const x = host.scrollLeft, w = width();
    for (let i = Math.max(0, cur - 1); i <= Math.min(count - 1, cur + 1); i++) {
      const n = slots[i].node;
      if (!n || (i === cur && zm.z > 1)) continue;
      const t = Math.max(-1, Math.min(1, (i * w - x) / w)); // -1 gone left, 0 centred, 1 waiting right
      const a = Math.abs(t);
      n.style.transformOrigin = t < 0 ? "100% 50%" : "0% 50%";
      n.style.transform = a < 0.001 ? "" : `rotateY(${t * -28}deg) scale(${1 - a * 0.1})`;
    }
  }
  // fill the page being looked at first, then its neighbours, and only while nothing is moving
  function settle() {
    if (dead) return;
    if (performance.now() - moving < 90) return void (idle = setTimeout(settle, 100));
    const order = [cur, cur + 1, cur - 1, cur + 2, cur - 2].filter((i) => i >= 0 && i < count);
    for (const i of order) fill(i);
    for (let i = 0; i < count; i++) if (Math.abs(i - cur) > 2 && slots[i].node) drop(i);
  }
  function update() {
    const idx = Math.max(0, Math.min(count - 1, Math.round(host.scrollLeft / width())));
    if (idx !== cur) {
      if (zm.z > 1) resetZoom(false);
      cur = idx;
      onPage(idx, announced);
      announced = true;
    }
    tilt();
    clearTimeout(idle);
    idle = setTimeout(settle, 100);
  }
  const onScroll = () => {
    moving = performance.now();
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
  };
  host.addEventListener("scroll", onScroll, { passive: true });

  /* ----- zoom ----- */
  function place() {
    const n = node();
    if (!n) return;
    n.style.transformOrigin = "50% 50%";
    n.style.transform = zm.z > 1.001 ? `translate(${zm.x}px, ${zm.y}px) scale(${zm.z})` : "";
  }
  function limit() {
    const n = node();
    const w = n ? n.offsetWidth : width(), h = n ? n.offsetHeight : host.clientHeight;
    const mx = Math.max(0, (w * zm.z - host.clientWidth) / 2), my = Math.max(0, (h * zm.z - host.clientHeight) / 2);
    zm.x = Math.max(-mx, Math.min(mx, zm.x));
    zm.y = Math.max(-my, Math.min(my, zm.y));
  }
  function freeze(on) {
    host.style.touchAction = on ? "none" : "";
    host.style.overflowX = on ? "hidden" : "";
  }
  function resetZoom(animate) {
    zm.z = 1;
    zm.x = zm.y = 0;
    freeze(false);
    const n = node();
    if (n && animate) {
      n.style.transition = "transform 0.2s ease-out";
      setTimeout(() => n && (n.style.transition = ""), 220);
    }
    place();
  }
  // sharper pixels once the zoom has settled
  let sharpen = 0;
  function crisp() {
    clearTimeout(sharpen);
    sharpen = setTimeout(() => zm.z > 1.2 && cur >= 0 && fill(cur, Math.min(zm.z, MAX_ZOOM)), 250);
  }
  // keep the point under the fingers where it was
  function zoomTo(z, cx, cy, from) {
    const n = node();
    if (!n) return;
    const r = host.getBoundingClientRect();
    const px = cx - r.left - r.width / 2, py = cy - r.top - r.height / 2; // fingers, from the screen centre
    const ax = (px - from.x) / from.z, ay = (py - from.y) / from.z; // the page point under them
    zm.z = Math.max(1, Math.min(MAX_ZOOM, z));
    zm.x = px - zm.z * ax;
    zm.y = py - zm.z * ay;
    limit();
    freeze(zm.z > 1.001);
    place();
  }

  /* ----- touches: pinch, pan while zoomed, double-tap, single tap, short swipe ----- */
  let g = null; // the gesture in progress
  let lastTap = 0;
  let tapTimer = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];

  const onStart =
    (e) => {
      if (e.touches.length === 2) {
        const [cx, cy] = mid(e.touches);
        g = { kind: "pinch", d: dist(e.touches), from: { ...zm }, cx, cy, moved: true };
        clearTimeout(tapTimer);
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        g = { kind: zm.z > 1 ? "pan" : "swipe", x: t.clientX, y: t.clientY, t: Date.now(), from: { ...zm }, i: Math.round(host.scrollLeft / width()), moved: false };
      } else g = null;
    };
  const onMove =
    (e) => {
      if (!g) return;
      if (g.kind === "pinch" && e.touches.length === 2) {
        e.preventDefault();
        const [cx, cy] = mid(e.touches);
        zoomTo(g.from.z * (dist(e.touches) / g.d), cx, cy, g.from);
        // the fingers may drift: follow them
        g.from = { ...zm };
        g.d = dist(e.touches);
        g.cx = cx;
        g.cy = cy;
      } else if (g.kind === "pan" && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        zm.x = g.from.x + (t.clientX - g.x);
        zm.y = g.from.y + (t.clientY - g.y);
        limit();
        place();
        g.moved = true;
      } else if (g.kind === "swipe") {
        const t = e.touches[0];
        if (Math.abs(t.clientX - g.x) > 10 || Math.abs(t.clientY - g.y) > 10) g.moved = true;
      }
    };
  const onEnd =
    (e) => {
      const k = g;
      if (!k) return;
      if (k.kind === "pinch") {
        if (zm.z < 1.05) resetZoom(true);
        else crisp();
        g = e.touches.length ? { kind: "pan", x: e.touches[0].clientX, y: e.touches[0].clientY, from: { ...zm }, moved: true } : null;
        return;
      }
      g = null;
      const c = e.changedTouches[0];
      if (k.kind === "pan") {
        if (!k.moved && Date.now() - k.t < 300) tap(c, true);
        else crisp();
        return;
      }
      // swipe or tap on a page that is not zoomed
      const dx = c.clientX - k.x, dt = Math.max(1, Date.now() - k.t);
      if (!k.moved && dt < 300) return tap(c, false);
      // a short or quick swipe still turns the page; the snapping scroll alone only moves on past the halfway mark
      const far = Math.abs(dx) > width() * 0.12, quick = Math.abs(dx) > 30 && Math.abs(dx) / dt > 0.35;
      const gone = host.scrollLeft / width() - k.i; // how far the page has already been dragged
      if ((far || quick) && Math.abs(gone) < 0.5) {
        const to = Math.max(0, Math.min(count - 1, k.i + (dx < 0 ? 1 : -1)));
        host.scrollTo({ left: to * width(), behavior: "smooth" });
      }
    };
  const onCancel = () => (g = null);
  host.addEventListener("touchstart", onStart, { passive: true });
  host.addEventListener("touchmove", onMove, { passive: false });
  host.addEventListener("touchend", onEnd, { passive: true });
  host.addEventListener("touchcancel", onCancel, { passive: true });
  // one tap shows or hides the toolbar; two taps zoom in or back out
  function tap(c, zoomed) {
    const now = Date.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      clearTimeout(tapTimer);
      const from = { ...zm };
      if (zm.z > 1.2) resetZoom(true);
      else {
        const n = node();
        if (n) n.style.transition = "transform 0.2s ease-out";
        zoomTo(2.5, c.clientX, c.clientY, from);
        setTimeout(() => n && (n.style.transition = ""), 220);
        crisp();
      }
      return;
    }
    lastTap = now;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => onTap(), 280);
  }
  let lastW = host.clientWidth, lastH = host.clientHeight;
  const ro =
    typeof ResizeObserver !== "undefined" &&
    new ResizeObserver(() => {
      if (host.clientWidth === lastW && host.clientHeight === lastH) return;
      lastW = host.clientWidth;
      lastH = host.clientHeight;
      const keep = cur;
      resetZoom(false);
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
      clearTimeout(idle);
      clearTimeout(tapTimer);
      clearTimeout(sharpen);
      host.removeEventListener("scroll", onScroll);
      host.removeEventListener("touchstart", onStart);
      host.removeEventListener("touchmove", onMove);
      host.removeEventListener("touchend", onEnd);
      host.removeEventListener("touchcancel", onCancel);
      if (ro) ro.disconnect();
      freeze(false);
      for (let i = 0; i < count; i++) drop(i);
      host.replaceChildren();
    },
  };
}
