
// app.js — Customer-facing app
window.addEventListener("error", () => {
  const biz = document.getElementById("biz-list");
  if (biz && biz.innerHTML.includes("Loading")) {
    biz.innerHTML = '<div class="error">Failed to load app.</div>';
  }
});

import {
  getBusiness, getMenu, placeOrder,
  subscribeToOrder, subscribeToBusinesses
} from "./firebase.service.js";

// ══ STATE ══
let businesses = [];
let cart = [];
let activeBiz = null;
let activeMenu = [];
let unsubscribeBusinesses = null;
let unsubscribeOrder = null;
let pendingOrderData = null; // holds order payload while customer modal is open

// ══ ROUTING ══
function resolveRoute() {
  const match = window.location.pathname.match(/\/business\/([^/]+)/);
  return match ? match[1] : null;
}
function pushRoute(slug) {
  window.history.pushState({ slug }, "", slug ? `/business/${slug}` : "/");
}
window.addEventListener("popstate", (e) => {
  const slug = e.state?.slug || null;
  slug ? openMenu(slug, false) : goHome(false);
});

// ══ INIT ══
async function init() {
  showLoading("biz-list");
  unsubscribeBusinesses = subscribeToBusinesses((data) => {
    businesses = data;
    const openCount = data.filter(b => b.isOpen).length;
    document.getElementById('open-count').textContent = openCount + ' OPEN NOW';
    renderBizCards(businesses);
  });
  const routeSlug = resolveRoute();
  if (routeSlug) await openMenu(routeSlug, false);
}

// ══ HOME ══
function renderBizCards(list) {
  const el = document.getElementById("biz-list");
  if (!list.length) {
    el.innerHTML = `<div class="no-results"><strong>No results found</strong>Try a different search term.</div>`;
    return;
  }
  el.innerHTML = list.map((b, i) => `
    <div class="biz-card" onclick="openMenu('${b.slug || b.id}')" style="animation-delay:${i * 0.12}s">
      <div class="biz-img-wrap">
        <img src="${b.bannerUrl}" alt="${b.name}" loading="lazy">
        <div class="biz-img-gradient"></div>
        <div class="biz-status">
          <div class="status-dot ${b.isOpen ? '' : 'closed'}"></div>
          ${b.isOpen ? "OPEN" : "CLOSED"}
        </div>
        <div class="biz-rating-badge">⭐ ${b.rating}</div>
      </div>
      <div class="biz-body">
        <div class="biz-top">
          <div class="biz-name">${b.name}</div>
          <div class="biz-arrow">→</div>
        </div>
        <div class="biz-tags">${b.tags.map(t => `<span class="biz-tag">${t}</span>`).join("")}</div>
        <div class="biz-meta-row">
          <div class="biz-meta-item"><strong>${b.location}</strong>Location</div>
          <div class="biz-meta-item"><strong>${b.estimatedWaitMin}–${b.estimatedWaitMax} min</strong>Wait time</div>
          <div class="biz-meta-item"><strong>${b.reviewCount}</strong>Reviews</div>
        </div>
      </div>
    </div>`).join("");
}

function filterBiz() {
  const q = document.getElementById("search-input").value.toLowerCase().trim();
  if (!q) { renderBizCards(businesses); return; }
  renderBizCards(businesses.filter(b =>
    b.name.toLowerCase().includes(q) || b.tags.some(t => t.toLowerCase().includes(q))
  ));
}

// ══ MENU ══
async function openMenu(bizSlug, pushHistory = true) {
  showLoading("menu-items");
  showScreen("menu");
  activeBiz = await getBusiness(bizSlug);
  if (!activeBiz) {
    document.getElementById("menu-items").innerHTML = `<div class="error">Business not found.</div>`;
    return;
  }
  if (pushHistory) pushRoute(bizSlug);
  document.getElementById("menu-banner").src = activeBiz.bannerUrl;
  document.getElementById("menu-biz-name").textContent = activeBiz.name;
  document.getElementById("menu-rating").textContent = activeBiz.rating;
  document.getElementById("menu-location").textContent = activeBiz.location;
  document.getElementById("menu-time").textContent = `${activeBiz.estimatedWaitMin}–${activeBiz.estimatedWaitMax} min`;
  activeMenu = await getMenu(bizSlug);
  document.getElementById("cat-nav").innerHTML = activeMenu.map((sec, i) =>
    `<button class="cat-pill ${i === 0 ? "active" : ""}" onclick="scrollToSec('${sec.category}',this)">${sec.category}</button>`
  ).join("");
  renderMenuItems();
  window.scrollTo(0, 0);
}

function renderMenuItems() {
  document.getElementById("menu-items").innerHTML = activeMenu.map((sec, si) =>
    `<div id="sec-${sec.category}">
      <div class="menu-sec-title">${sec.category}</div>
      ${sec.items.map((item, ii) => renderItemHTML(item, si * 10 + ii)).join("")}
    </div>`
  ).join("");
}

function renderItemHTML(item, delay) {
  const inCart = cart.find(c => c.id === item.id);
  const qty = inCart ? inCart.qty : 0;
  return `
    <div class="menu-item" id="item-${item.id}" style="animation-delay:${(delay || 0) * 0.06}s">
      <img class="item-img" src="${item.imgUrl}" alt="${item.name}" loading="lazy">
      <div class="item-body">
        <div class="item-name">${item.name}</div>
        <div class="item-desc">${item.desc}</div>
        <div class="item-footer">
          <div class="item-price">$${item.price.toFixed(2)}</div>
          ${qty === 0
            ? `<button class="add-btn" onclick='addItem(${JSON.stringify(item).replace(/'/g, "&#39;")})'>+</button>`
            : `<div class="item-qty">
                <button class="qty-btn" onclick='changeQty("${item.id}",-1)'>−</button>
                <span class="qty-num">${qty}</span>
                <button class="qty-btn" onclick='changeQty("${item.id}",1)'>+</button>
              </div>`
          }
        </div>
      </div>
    </div>`;
}

function refreshItem(itemId) {
  let data = null;
  for (const sec of activeMenu) {
    const f = sec.items.find(i => i.id === itemId);
    if (f) { data = f; break; }
  }
  if (!data) return;
  const el = document.getElementById(`item-${itemId}`);
  if (el) { const t = document.createElement("div"); t.innerHTML = renderItemHTML(data); el.replaceWith(t.firstElementChild); }
}

function scrollToSec(cat, btn) {
  document.querySelectorAll(".cat-pill").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  const el = document.getElementById(`sec-${cat}`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ══ CART ══
function addItem(item) {
  const ex = cart.find(c => c.id === item.id);
  if (ex) ex.qty++;
  else cart.push({ ...item, qty: 1, bizId: activeBiz.id, bizName: activeBiz.name });
  updateCartCount();
  refreshItem(item.id);
}

function changeQty(id, d) {
  const idx = cart.findIndex(c => c.id === id);
  if (idx === -1) return;
  cart[idx].qty += d;
  if (cart[idx].qty <= 0) cart.splice(idx, 1);
  updateCartCount();
  refreshItem(id);
}

function updateCartCount() {
  const n = cart.reduce((s, c) => s + c.qty, 0);
  document.getElementById("cart-count").textContent = n;
  document.getElementById("cart-count-2").textContent = n;
  document.getElementById("order-btn").disabled = n === 0;
}

function openCart() {
  const listEl = document.getElementById("cart-items-list");
  const totalEl = document.getElementById("cart-total");
  const bizEl = document.getElementById("cart-biz-name");
  const orderBtn = document.getElementById("order-btn");
  if (cart.length === 0) {
    listEl.innerHTML = `<div class="empty-cart"><span class="emoji">🍽</span><p>Your order is empty.<br>Add something good.</p></div>`;
    totalEl.textContent = "$0.00";
    bizEl.innerHTML = "—";
    orderBtn.disabled = true;
  } else {
    bizEl.innerHTML = `From <span>${cart[0].bizName}</span>`;
    listEl.innerHTML = cart.map(c => `
      <div class="cart-line">
        <div class="cart-line-left">
          <div class="cart-line-name">${c.qty}× ${c.name}</div>
          <div class="cart-line-price">$${(c.price * c.qty).toFixed(2)}</div>
        </div>
        <button class="remove-btn" onclick='removeFromCart("${c.id}")'>✕</button>
      </div>`).join("");
    totalEl.textContent = `$${cart.reduce((s, c) => s + c.price * c.qty, 0).toFixed(2)}`;
    orderBtn.disabled = false;
  }
  document.getElementById("cart-overlay").classList.add("open");
}

function removeFromCart(id) {
  cart = cart.filter(c => c.id !== id);
  updateCartCount();
  openCart();
  if (activeBiz) refreshItem(id);
}

function closeCartOutside(e) {
  if (e.target === document.getElementById("cart-overlay"))
    document.getElementById("cart-overlay").classList.remove("open");
}
function closeCart() {
  document.getElementById("cart-overlay").classList.remove("open");
}

// ══ CUSTOMER DETAILS MODAL ══
function openCustomerModal() {
  // Build order payload first, store it
  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const items = cart.map(c => ({
    itemId: c.id, name: c.name, price: c.price,
    qty: c.qty, subtotal: +(c.price * c.qty).toFixed(2)
  }));
  pendingOrderData = {
    businessId: activeBiz.id,
    businessName: activeBiz.name,
    items, total: +total.toFixed(2),
    estimatedWait: `${activeBiz.estimatedWaitMin}–${activeBiz.estimatedWaitMax} min`,
  };
  // Clear fields
  document.getElementById("customer-name").value = "";
  document.getElementById("customer-phone").value = "";
  document.getElementById("customer-modal-error").textContent = "";
  document.getElementById("customer-modal").classList.add("open");
}

window.closeCustomerModal = function() {
  document.getElementById("customer-modal").classList.remove("open");
  // re-enable place order btn
  const btn = document.getElementById("order-btn");
  btn.disabled = false;
  btn.textContent = "PLACE ORDER · PICKUP";
}

window.confirmCustomerDetails = async function() {
  const name  = document.getElementById("customer-name").value.trim();
  const phone = document.getElementById("customer-phone").value.trim();
  const errEl = document.getElementById("customer-modal-error");

  if (!name)  { errEl.textContent = "Please enter your name."; return; }
  if (!phone) { errEl.textContent = "Please enter your phone number."; return; }
  if (!/^[0-9+\s]{7,15}$/.test(phone)) { errEl.textContent = "Please enter a valid phone number."; return; }

  errEl.textContent = "";
  document.getElementById("confirm-customer-btn").disabled = true;
  document.getElementById("confirm-customer-btn").textContent = "Placing order…";

  try {
    const order = await placeOrder({
      ...pendingOrderData,
      customerName: name,
      customerPhone: phone,
      customerId: null
    });

    document.getElementById("customer-modal").classList.remove("open");
    document.getElementById("cart-overlay").classList.remove("open");
    cart = [];
    updateCartCount();

    // Show track screen
    showTrackScreen(order);

    // Subscribe to real-time status
    if (unsubscribeOrder) unsubscribeOrder();
    unsubscribeOrder = subscribeToOrder(order.id, (updated) => {
      updateTrackStatus(updated.status);
    });

  } catch(err) {
    errEl.textContent = "Error: " + err.message;
    document.getElementById("confirm-customer-btn").disabled = false;
    document.getElementById("confirm-customer-btn").textContent = "CONFIRM & PLACE ORDER";
  }
}

// ══ TRACK ORDER SCREEN ══
function showTrackScreen(order) {
  document.getElementById("track-order-num").textContent = order.orderNumber;
  document.getElementById("track-biz-name").textContent = order.businessName;
  document.getElementById("track-customer-name").textContent = order.customerName || "—";
  document.getElementById("track-phone").textContent = order.customerPhone || "—";
  document.getElementById("track-wait").textContent = order.estimatedWait || "—";
  document.getElementById("track-total").textContent = `$${(order.total||0).toFixed(2)}`;
  document.getElementById("track-items").textContent =
    (order.items||[]).map(i => `${i.qty}× ${i.name}`).join(" · ");

  updateTrackStatus(order.status || "pending");
  // Show floating track button on home screen
document.getElementById('track-float').style.display = 'flex';
document.getElementById('track-float-num').textContent = order.orderNumber;
  showScreen("track");
  window.scrollTo(0, 0);
}

const STATUS_CONFIG = {
  pending:   { label: "⏳ Pending",            sub: "Your order has been received. Hang tight!",          class: "pending",   step: 1 },
  preparing: { label: "👨‍🍳 Being Prepared",    sub: "The kitchen is working on your order right now.",   class: "preparing", step: 2 },
  ready:     { label: "🔔 Ready for Pickup!",  sub: "Your order is ready — come collect it now!",         class: "ready",     step: 3 },
  completed: { label: "🎉 Collected",           sub: "Thanks for ordering with TapDish. Enjoy your meal!", class: "completed", step: 4 },
  rejected:  { label: "❌ Rejected",            sub: "Sorry, your order could not be fulfilled.",          class: "rejected",  step: 0 },
};

function updateTrackStatus(status) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  const badgeEl = document.getElementById("track-status-badge");
  const subEl   = document.getElementById("track-status-sub");

  badgeEl.textContent = cfg.label;
  badgeEl.className   = `track-status-badge ${cfg.class}`;
  subEl.textContent   = cfg.sub;

  // Update step indicators
  [1,2,3].forEach(step => {
    const el = document.getElementById(`step-${step}`);
    if (!el) return;
    el.classList.remove("active", "done");
    if (cfg.step === step) el.classList.add("active");
    if (cfg.step > step)  el.classList.add("done");
  });

  // READY alert — flash + sound
  if (status === "ready") {
    triggerReadyAlert();
  }
}

function triggerReadyAlert() {
  // Flash the track screen
  const screen = document.getElementById("track");
  screen.classList.add("ready-flash");
  setTimeout(() => screen.classList.remove("ready-flash"), 2000);

  // Play chime sound using Web Audio API
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.4, ctx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.4);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.4);
    });
  } catch(e) { console.log("Audio not available:", e); }

  // Show ready banner
  const banner = document.getElementById("ready-banner");
  if (banner) {
    banner.classList.add("show");
    setTimeout(() => banner.classList.remove("show"), 6000);
  }
}

// ══ ORDER PLACEMENT (called from cart PLACE ORDER button) ══
async function submitOrder() {
  if (!cart.length) return;
  const orderBtn = document.getElementById("order-btn");
  orderBtn.disabled = true;
  orderBtn.textContent = "Almost there…";
  closeCart();
  openCustomerModal();
}

// ══ HELPERS ══
function showLoading(containerId) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = `<div class="loading-state">Loading…</div>`;
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function goHome(pushHistory = true) {
  if (pushHistory) pushRoute(null);
  if (unsubscribeOrder) { unsubscribeOrder(); unsubscribeOrder = null; }
  showScreen("home");
  window.scrollTo(0, 0);
}

function resetApp() {
  activeBiz = null; activeMenu = []; cart = [];
  updateCartCount();
  document.getElementById("search-input").value = "";
  document.getElementById('track-float').style.display = 'none';
  goHome();
}
function showTrackFromFloat(){
  if(unsubscribeOrder === null) return;
  showScreen('track');
  window.scrollTo(0,0);
}
// ══ EXPOSE ══
window.openMenu = openMenu;
window.filterBiz = filterBiz;
window.openCart = openCart;
window.closeCartOutside = closeCartOutside;
window.closeCart = closeCart;
window.removeFromCart = removeFromCart;
window.addItem = addItem;
window.changeQty = changeQty;
window.scrollToSec = scrollToSec;
window.placeOrder = submitOrder;
window.goHome = goHome;
window.resetApp = resetApp;
window.showTrackFromFloat = showTrackFromFloat;

init();
