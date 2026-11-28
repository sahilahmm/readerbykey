// Read aloud: the phone's own voice reads the book from the page you are on, turning pages as it goes.
// Uses the system text-to-speech through the app (Android/iOS); a browser's speech is the fallback.
const plugin = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TextToSpeech;
const RATES = [1, 1.25, 1.5, 0.8];

const langOf = (t) => {
  const letters = (t.match(/\p{L}/gu) || []).length || 1;
  return (t.match(/[ঀ-৿]/g) || []).length / letters > 0.3 ? "bn-BD" : "en-US";
};
// short pieces: speech engines choke on very long text
function pieces(text) {
  const out = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?।])\s+/)) {
    if (cur && cur.length + s.length > 400) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? " " : "") + s;
    while (cur.length > 700) {
      const cut = cur.lastIndexOf(" ", 600) > 100 ? cur.lastIndexOf(" ", 600) : 600;
      out.push(cur.slice(0, cut));
      cur = cur.slice(cut).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

function say(text, lang, rate) {
  const tts = plugin();
  if (tts) return tts.speak({ text, lang, rate, pitch: 1, volume: 1, category: "playback", queueStrategy: 0 });
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) return reject(new Error("no voice"));
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    u.onend = () => resolve();
    u.onerror = (e) => (e.error === "canceled" || e.error === "interrupted" ? resolve() : reject(new Error(e.error)));
    speechSynthesis.speak(u);
  });
}
function hush() {
  const tts = plugin();
  if (tts) return tts.stop().catch(() => {});
  if (window.speechSynthesis) speechSynthesis.cancel();
}

// pages: the book's page reader (blocks(), pageOf(el), goto(i), index()); notify(state) -> { playing, rate }; problem(msg)
export function createReader({ pages, notify, problem }) {
  let token = 0;
  let rate = 1;
  let playing = false;
  let mark = null;
  const set = (on) => {
    playing = on;
    notify({ playing, rate });
  };
  const unmark = () => mark && (mark.classList.remove("ep-say"), (mark = null));

  async function run(from) {
    const mine = ++token;
    set(true);
    const els = pages.blocks();
    let i = from ?? els.findIndex((el) => pages.pageOf(el) >= pages.index());
    if (i < 0) i = 0;
    let warned = false;
    for (; i < els.length && mine === token; i++) {
      const el = els[i];
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!/\p{L}|\p{N}/u.test(text)) continue;
      const pg = pages.pageOf(el);
      if (pg !== pages.index()) pages.goto(pg, true);
      unmark();
      mark = el;
      el.classList.add("ep-say");
      const lang = langOf(text);
      try {
        for (const part of pieces(text)) {
          if (mine !== token) break;
          await say(part, lang, rate);
        }
      } catch {
        if (mine !== token) break;
        if (!warned) problem(lang === "bn-BD" ? "This phone has no Bangla voice. Add one in its text-to-speech settings." : "Couldn't start the voice on this phone.");
        warned = true;
        if (lang !== "bn-BD") break; // an English failure means no voice at all; Bangla pieces are skipped
      }
    }
    if (mine === token) {
      unmark();
      set(false);
    }
  }

  return {
    toggle() {
      if (playing) return this.stop();
      run();
    },
    stop() {
      token++;
      hush();
      unmark();
      set(false);
    },
    // the next speed; takes effect from the next piece
    faster() {
      rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
      notify({ playing, rate });
    },
    playing: () => playing,
  };
}
