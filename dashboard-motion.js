// dashboard-motion.js - GSAP animations for the vendor dashboard.
// Load GSAP with a normal <script> tag BEFORE the module scripts, so window.gsap exists.
// Design rule: motion only answers something that happened (new order, status change,
// tab switch). Nothing animates on its own, and nothing animates for people who
// ask their device to reduce motion.

const g = window.gsap;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const canAnimate = !!g && !reduceMotion; // if GSAP fails to load, the dashboard still works

// Remembers which order cards each list has already shown, so a re-render (which happens on
// every Firestore update) only animates cards that are genuinely new in that list.
const seen = {};   // { listKey: Set of order ids }
const primed = {}; // { listKey: true } after the first render of that list

// Call after you set a list's innerHTML. Cards need a data-id="<order id>" attribute.
// Returns true if at least one card is new (never true on the first render).
export function revealNew(listKey, root) {
  const cards = [...root.querySelectorAll("[data-id]")];
  seen[listKey] ??= new Set();
  const fresh = cards.filter((c) => !seen[listKey].has(c.dataset.id));
  cards.forEach((c) => seen[listKey].add(c.dataset.id));

  // First render = orders that already existed, so show them instantly.
  if (!primed[listKey]) { primed[listKey] = true; return false; }
  if (!fresh.length || !canAnimate) return fresh.length > 0;

  // Slide in from the side and flash the border, so a new order is hard to miss.
  g.fromTo(fresh, { opacity: 0, x: 24 },
    { opacity: 1, x: 0, duration: 0.45, ease: "power3.out", stagger: 0.07, clearProps: "transform,opacity" });
  g.fromTo(fresh, { boxShadow: "0 0 0 2px rgba(200,241,53,.9)" },
    { boxShadow: "0 0 0 0 rgba(200,241,53,0)", duration: 1.4, ease: "power2.out", clearProps: "boxShadow" });
  return true;
}

// Number that counts up/down to its new value instead of jumping.
export function countTo(el, value, prefix = "") {
  if (!el) return;
  const from = Number(el.dataset.v ?? 0);
  el.dataset.v = value;
  if (!canAnimate || from === value) { el.textContent = prefix + value; return; }
  const o = { v: from };
  g.to(o, { v: value, duration: 0.6, ease: "power2.out",
    onUpdate: () => { el.textContent = prefix + Math.round(o.v); } });
}

// Short fade/rise when switching tabs.
export function swapTab(el) {
  if (!canAnimate) return;
  g.fromTo(el, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.25, ease: "power2.out", clearProps: "all" });
}

// Pop the red "pending" badges (sidebar + bottom nav) when a new order lands.
export function bumpBadges() {
  if (!canAnimate) return;
  g.fromTo(".sidebar-badge, .bnav-badge", { scale: 1.6 }, { scale: 1, duration: 0.5, ease: "back.out(3)" });
}

// Chime for a new order. Kitchens are noisy and screens are not watched, so sound matters here.
// Browsers only allow audio after the vendor has tapped something, which they always have by then.
export function newOrderChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [659, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      osc.connect(gain); gain.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.2;
      gain.gain.setValueAtTime(0.35, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t); osc.stop(t + 0.35);
    });
  } catch (e) { /* audio blocked: the visual alert still shows */ }
}

