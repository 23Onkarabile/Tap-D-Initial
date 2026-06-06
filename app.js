// app.js — Customer-facing app
window.addEventListener("error", () => {
  const biz = document.getElementById("biz-list");
  if (biz && biz.innerHTML.includes("Loading")) {
    biz.innerHTML = '<div class="error">Failed to load app.</div>';
  }
});

import {
  getBusiness, getMenu, placeOrder,
  subscribeToOrder, subscribeToBusinesses,
  customerSignUp, customerSignIn, customerSignOut,
  resetPassword, onCustomerAuthChange, getCustomerProfile,
  sendOTP, savePhoneProfile,
  saveCart, loadCart, clearCart,
  saveActiveOrder, clearActiveOrder, getActiveOrder,
  getOrderHistory
} from "./firebase.service.js";

// ══ STATE ══
let businesses = [];
let cart = [];
let activeBiz = null;
let activeMenu = [];
const appState = {
  cart,
  activeBiz,
  activeMenu,
  currentUser,
  currentProfile,
  orderActive: false
};
let unsubscribeBusinesses = null;
let unsubscribeOrder = null;
let pendingOrderData = null;
let currentUser = null;
let currentProfile = null;
let otpConfirmation = null; // for phone OTP flow
let pendingCartAfterAuth = false; // flag to open customer modal after login

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

  // Listen to auth state
  onCustomerAuthChange(async (user) => {
    currentUser = user;
    if (user) {
      // Load profile
      currentProfile = await getCustomerProfile(user.uid);
      updateProfileUI();

      // Restore cart from Firestore
      await restoreCart();

      // Restore active order if any
      await restoreActiveOrder();

      // If was waiting to place order after auth
      if (pendingCartAfterAuth) {
        pendingCartAfterAuth = false;
        closeAuthSheet();
        openCustomerModal();
      }
    } else {
      currentUser = null;
      currentProfile = null;
      updateProfileUI();
    }
  });

  // Subscribe to businesses
  unsubscribeBusinesses = subscribeToBusinesses((data) => {
    businesses = data;
    const openCount = data.filter(b => b.isOpen).length;
    document.getElementById('open-count').textContent = openCount + ' OPEN NOW';
    renderBizCards(businesses);
  });

  const routeSlug = resolveRoute();
  if (routeSlug) await openMenu(routeSlug, false);
}

// ══ PROFILE UI ══
function updateProfileUI() {
  const btn = document.getElementById('profile-btn');
  if (currentUser && currentProfile) {
    btn.classList.add('logged-in');
    btn.title = currentProfile.name || currentUser.email;
    document.getElementById('profile-name').textContent = currentProfile.name || 'Customer';
    document.getElementById('profile-email').textContent = currentProfile.email || currentUser.phoneNumber || '—';
  } else {
    btn.classList.remove('logged-in');
    btn.title = 'Account';
    document.getElementById('profile-name').textContent = '—';
    document.getElementById('profile-email').textContent = 'Not signed in';
  }
}

// ══ CART PERSISTENCE ══
async function restoreCart() {
  if (!currentUser) return;
  try {
    const saved = await loadCart(currentUser.uid);
    if (saved && saved.cart && saved.cart.length > 0) {
      cart = saved.cart;
      updateCartCount();
    }
  } catch(e) { console.error('restoreCart:', e); }
}

async function persistCart() {
  if (!currentUser) return;
  try {
    const bizId   = cart.length ? cart[0].bizId   : null;
    const bizName = cart.length ? cart[0].bizName : null;
    await saveCart(currentUser.uid, cart, bizId, bizName);
  } catch(e) { console.error('persistCart:', e); }
}

// ══ ACTIVE ORDER PERSISTENCE ══
async function restoreActiveOrder() {
  if (!currentUser) return;
  try {
    const order = await getActiveOrder(currentUser.uid);
    if (!order) return;
    // Restore track screen data
    showTrackScreen(order, false); // false = don't navigate to track screen
    // Show floating button
    document.getElementById('track-float').style.display = 'flex';
    document.getElementById('track-float-num').textContent = order.orderNumber;
    // Re-subscribe to order updates
    if (unsubscribeOrder) {
  unsubscribeOrder();
  unsubscribeOrder = null;
}

unsubscribeOrder = subscribeToOrder(order.id, (updated) => { {
      updateTrackStatus(updated.status);
      // Clear active order when completed/rejected
      if (['completed','rejected'].includes(updated.status)) {
        if (currentUser) clearActiveOrder(currentUser.uid);
      }
    });
  } catch(e) { console.error('restoreActiveOrder:', e); }
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
    document.getElementById("menu-items").innerHTML =
      `<div class="error">Business not found.</div>`;
    return;
  }

  appState.activeBiz = activeBiz;

  if (pushHistory) pushRoute(bizSlug);

  document.getElementById("menu-banner").src = activeBiz.bannerUrl;
  document.getElementById("menu-biz-name").textContent = activeBiz.name;
  document.getElementById("menu-rating").textContent = activeBiz.rating;
  document.getElementById("menu-location").textContent = activeBiz.location;
  document.getElementById("menu-time").textContent =
    `${activeBiz.estimatedWaitMin}–${activeBiz.estimatedWaitMax} min`;

  activeMenu = await getMenu(bizSlug);

  appState.activeMenu = activeMenu || [];

  document.getElementById("cat-nav").innerHTML = activeMenu.map((sec, i) =>
    `<button class="cat-pill ${i === 0 ? "active" : ""}"
      onclick="scrollToSec('${sec.category}',this)">
      ${sec.category}
    </button>`
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
  appState.cart = cart;
appState.activeBiz = activeBiz;
  const ex = cart.find(c => c.id === item.id);
  if (ex) ex.qty++;
  else cart.push({ ...item, qty: 1, bizId: activeBiz.id, bizName: activeBiz.name });
  updateCartCount();
  refreshItem(item.id);
  persistCart();
  appState.cart = cart;
}

function changeQty(id, d) {
  const idx = cart.findIndex(c => c.id === id);
  appState.cart = cart;
  if (idx === -1) return;
  cart[idx].qty += d;
  if (cart[idx].qty <= 0) cart.splice(idx, 1);
  updateCartCount();
  refreshItem(id);
  persistCart();
  appState.cart = cart;
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
  persistCart();
}

function closeCartOutside(e) {
  if (e.target === document.getElementById("cart-overlay"))
    document.getElementById("cart-overlay").classList.remove("open");
}
function closeCart() {
  document.getElementById("cart-overlay").classList.remove("open");
}

// ══ ORDER PLACEMENT ══
async function submitOrder() {
  if (!cart.length) return;
  const orderBtn = document.getElementById("order-btn");
  orderBtn.disabled = true;
  orderBtn.textContent = "Almost there…";
  closeCart();

  // If not logged in, show auth sheet first
  if (!currentUser) {
    pendingCartAfterAuth = true;
    openAuthSheet();
    orderBtn.disabled = false;
    orderBtn.textContent = "PLACE ORDER · PICKUP";
    return;
  }

  openCustomerModal();
}

// ══ CUSTOMER DETAILS MODAL ══
function openCustomerModal() {
  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const items = cart.map(c => ({
    itemId: c.id, name: c.name, price: c.price,
    qty: c.qty, subtotal: +(c.price * c.qty).toFixed(2)
  }));
  pendingOrderData = {
    businessId: activeBiz ? activeBiz.id : cart[0]?.bizId,
    businessName: activeBiz ? activeBiz.name : cart[0]?.bizName,
    items, total: +total.toFixed(2),
    estimatedWait: activeBiz ? `${activeBiz.estimatedWaitMin}–${activeBiz.estimatedWaitMax} min` : '15 min',
  };

  // Pre-fill from profile
  const nameEl  = document.getElementById("customer-name");
  const phoneEl = document.getElementById("customer-phone");
  if (currentProfile) {
    nameEl.value  = currentProfile.name  || '';
    phoneEl.value = currentProfile.phone || '';
  } else {
    nameEl.value = ''; phoneEl.value = '';
  }

  document.getElementById("customer-modal-error").textContent = "";
  document.getElementById("confirm-customer-btn").disabled = false;
  document.getElementById("confirm-customer-btn").textContent = "CONFIRM & PLACE ORDER";
  document.getElementById("customer-modal").classList.add("open");
}

window.closeCustomerModal = function() {
  document.getElementById("customer-modal").classList.remove("open");
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
      customerId: currentUser ? currentUser.uid : null
    });

    // Save active order to Firestore for persistence
    if (currentUser) {
      await saveActiveOrder(currentUser.uid, order.id);
      await clearCart(currentUser.uid);
    }

    document.getElementById("customer-modal").classList.remove("open");
    document.getElementById("cart-overlay").classList.remove("open");
    cart = [];
    updateCartCount();

    showTrackScreen(order, true);
document.getElementById('track-float').style.display = 'flex';
document.getElementById('track-float-num').textContent = order.orderNumber;

    if (unsubscribeOrder) unsubscribeOrder();
    unsubscribeOrder = subscribeToOrder(order.id, async (updated) => {
      updateTrackStatus(updated.status);
      if (['completed','rejected'].includes(updated.status)) {
        if (currentUser) await clearActiveOrder(currentUser.uid);
      }
    });

  } catch(err) {
    errEl.textContent = "Error: " + err.message;
    document.getElementById("confirm-customer-btn").disabled = false;
    document.getElementById("confirm-customer-btn").textContent = "CONFIRM & PLACE ORDER";
  }
}

// ══ TRACK ORDER SCREEN ══
function showTrackScreen(order, navigate = true) {
  document.getElementById("track-order-num").textContent = order.orderNumber;
  document.getElementById("track-biz-name").textContent = order.businessName;
  document.getElementById("track-customer-name").textContent = order.customerName || "—";
  document.getElementById("track-phone").textContent = order.customerPhone || "—";
  document.getElementById("track-wait").textContent = order.estimatedWait || "—";
  document.getElementById("track-total").textContent = `$${(order.total||0).toFixed(2)}`;
  document.getElementById("track-items").textContent =
    (order.items||[]).map(i => `${i.qty}× ${i.name}`).join(" · ");

  updateTrackStatus(order.status || "pending");

  const float = document.getElementById('track-float');
if (order.status !== "completed" && order.status !== "rejected") {
  float.style.display = 'flex';
  float.dataset.active = "true";
} else {
  float.style.display = 'none';
  float.dataset.active = "false";
}
  document.getElementById('track-float-num').textContent = order.orderNumber;

  if (navigate) {
    showScreen("track");
    window.scrollTo(0, 0);
  }
}

const STATUS_CONFIG = {
  pending:   { label: "⏳ Pending",           sub: "Your order has been received. Hang tight!",           class: "pending",   step: 1 },
  preparing: { label: "👨‍🍳 Being Prepared",   sub: "The kitchen is working on your order right now.",    class: "preparing", step: 2 },
  ready:     { label: "🔔 Ready for Pickup!", sub: "Your order is ready — come collect it now!",          class: "ready",     step: 3 },
  completed: { label: "🎉 Collected",          sub: "Thanks for ordering with TapDish. Enjoy your meal!", class: "completed", step: 4 },
  rejected:  { label: "❌ Rejected",           sub: "Sorry, your order could not be fulfilled.",           class: "rejected",  step: 0 },
};

function updateTrackStatus(status) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  const badgeEl = document.getElementById("track-status-badge");
  const subEl   = document.getElementById("track-status-sub");
  badgeEl.textContent = cfg.label;
  badgeEl.className   = `track-status-badge ${cfg.class}`;
  subEl.textContent   = cfg.sub;
  [1,2,3].forEach(step => {
    const el = document.getElementById(`step-${step}`);
    if (!el) return;
    el.classList.remove("active", "done");
    if (cfg.step === step) el.classList.add("active");
    if (cfg.step > step)  el.classList.add("done");
  });
  if (status === "ready") triggerReadyAlert();
  if (['completed','rejected'].includes(status)) {
    setTimeout(() => {
      document.getElementById('track-float').style.display = 'none';
    }, 5000);
  }
}

function triggerReadyAlert() {
  const screen = document.getElementById("track");
  screen.classList.add("ready-flash");
  setTimeout(() => screen.classList.remove("ready-flash"), 2000);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine"; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.4, ctx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.4);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.4);
    });
  } catch(e) { console.log("Audio not available:", e); }
  const banner = document.getElementById("ready-banner");
  if (banner) { banner.classList.add("show"); setTimeout(() => banner.classList.remove("show"), 6000); }
}

// ══ AUTH SHEET ══
function openAuthSheet() {
  document.getElementById('auth-overlay').classList.add('open');
}
function closeAuthSheet() {
  document.getElementById('auth-overlay').classList.remove('open');
}
window.closeAuthOutside = function(e) {
  if (e.target === document.getElementById('auth-overlay')) closeAuthSheet();
}

window.switchAuthMethod = function(method) {
  document.getElementById('auth-email-section').style.display = method === 'email' ? 'block' : 'none';
  document.getElementById('auth-phone-section').style.display = method === 'phone' ? 'block' : 'none';
  document.getElementById('method-email').classList.toggle('active', method === 'email');
  document.getElementById('method-phone').classList.toggle('active', method === 'phone');
}

window.switchEmailTab = function(tab) {
  document.getElementById('email-login-form').style.display  = tab === 'login'  ? 'block' : 'none';
  document.getElementById('email-signup-form').style.display = tab === 'signup' ? 'block' : 'none';
  document.getElementById('etab-login').classList.toggle('active', tab === 'login');
  document.getElementById('etab-signup').classList.toggle('active', tab === 'signup');
}

// EMAIL LOGIN
window.handleEmailLogin = async function() {
  const email = document.getElementById('el-email').value.trim();
  const pass  = document.getElementById('el-password').value;
  const errEl = document.getElementById('el-error');
  if (!email || !pass) { errEl.textContent = 'Please fill in all fields.'; return; }
  setAuthLoading('el-btn', true);
  errEl.textContent = '';
  try {
    await customerSignIn(email, pass);
    closeAuthSheet();
  } catch(e) {
    errEl.textContent = friendlyAuthError(e.code);
    setAuthLoading('el-btn', false);
  }
}

// EMAIL SIGNUP
window.handleEmailSignup = async function() {
  const name  = document.getElementById('es-name').value.trim();
  const phone = document.getElementById('es-phone').value.trim();
  const email = document.getElementById('es-email').value.trim();
  const pass  = document.getElementById('es-password').value;
  const errEl = document.getElementById('es-error');
  if (!name)         { errEl.textContent = 'Please enter your name.'; return; }
  if (!phone)        { errEl.textContent = 'Please enter your phone number.'; return; }
  if (!email)        { errEl.textContent = 'Please enter your email.'; return; }
  if (pass.length<6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
  setAuthLoading('es-btn', true);
  errEl.textContent = '';
  try {
    await customerSignUp(email, pass, name, phone);
    closeAuthSheet();
  } catch(e) {
    errEl.textContent = friendlyAuthError(e.code);
    setAuthLoading('es-btn', false);
  }
}

// FORGOT PASSWORD
window.handleAuthForgotPassword = async function() {
  const email = document.getElementById('el-email').value.trim();
  const errEl = document.getElementById('el-error');
  if (!email) { errEl.textContent = 'Enter your email above first.'; return; }
  try {
    await resetPassword(email);
    errEl.style.color = 'var(--lime)';
    errEl.textContent = '✅ Reset email sent — check your inbox.';
  } catch(e) {
    errEl.style.color = '';
    errEl.textContent = friendlyAuthError(e.code);
  }
}

// PHONE OTP
window.handleSendOTP = async function() {
  const phone = document.getElementById('ph-number').value.trim();
  const errEl = document.getElementById('ph-error');
  if (!phone) { errEl.textContent = 'Please enter your phone number.'; return; }
  setAuthLoading('ph-btn', true);
  errEl.textContent = '';
  try {
    otpConfirmation = await sendOTP(phone, 'recaptcha-container');
    document.getElementById('phone-step-1').style.display = 'none';
    document.getElementById('phone-step-2').style.display = 'block';
  } catch(e) {
    errEl.textContent = 'Error sending OTP: ' + e.message;
    setAuthLoading('ph-btn', false);
  }
}

window.handleVerifyOTP = async function() {
  const otp  = document.getElementById('ph-otp').value.trim();
  const name = document.getElementById('ph-name').value.trim();
  const errEl = document.getElementById('ph-otp-error');
  if (!otp)  { errEl.textContent = 'Please enter the OTP.'; return; }
  if (!name) { errEl.textContent = 'Please enter your name.'; return; }
  setAuthLoading('ph-otp-btn', true);
  errEl.textContent = '';
  try {
    const result = await otpConfirmation.confirm(otp);
    const phone = document.getElementById('ph-number').value.trim();
    await savePhoneProfile(result.user.uid, name, phone);
    closeAuthSheet();
  } catch(e) {
    errEl.textContent = 'Invalid OTP. Please try again.';
    setAuthLoading('ph-otp-btn', false);
  }
}

// ══ PROFILE SHEET ══
window.openProfileSheet = function() {
  if (!currentUser) {
    openAuthSheet();
    return;
  }
  document.getElementById('profile-overlay').classList.add('open');
}
window.closeProfileOutside = function(e) {
  if (e.target === document.getElementById('profile-overlay'))
    document.getElementById('profile-overlay').classList.remove('open');
}
window.handleSignOut = async function() {
  await customerSignOut();
  document.getElementById('profile-overlay').classList.remove('open');
}

// ══ ORDER HISTORY ══
window.openOrderHistory = async function() {
  document.getElementById('profile-overlay').classList.remove('open');
  document.getElementById('history-overlay').classList.add('open');
  const listEl = document.getElementById('history-list');
  const subEl  = document.getElementById('history-sheet-sub');
  listEl.innerHTML = `<div class="history-loading">Loading your orders…</div>`;
  try {
    const orders = await getOrderHistory(currentUser.uid);
    subEl.textContent = `${orders.length} order${orders.length !== 1 ? 's' : ''}`;
    if (!orders.length) {
      listEl.innerHTML = `<div class="history-empty">
        <span class="history-empty-icon">🧾</span>
        <p>No orders yet.<br>Place your first order!</p></div>`;
      return;
    }
    listEl.innerHTML = orders.map((o, i) => {
      const date = o.createdAt ? formatDate(o.createdAt.toDate()) : '—';
      const items = (o.items||[]).map(it => `${it.qty}× ${it.name}`).join(', ');
      return `
        <div class="history-order-card" style="animation-delay:${i*0.05}s">
          <div class="hoc-head">
            <span class="hoc-num">${o.orderNumber || o.id.slice(0,8).toUpperCase()}</span>
            <span class="hoc-date">${date}</span>
          </div>
          <div class="hoc-biz">${o.businessName || '—'}</div>
          <div class="hoc-items">${items}</div>
          <div class="hoc-foot">
            <span class="hoc-total">$${(o.total||0).toFixed(2)}</span>
            <span class="hoc-status ${o.status}">${o.status}</span>
          </div>
        </div>`;
    }).join('');
  } catch(e) {
    const url = e.message.match(/https:\/\/\S+/)?.[0];
    if(url) prompt('Copy this URL to create the index:', url);
    listEl.innerHTML = `<div class="history-empty"><p>Error loading orders.<br>${e.message}</p></div>`;
  }
}

window.closeHistoryOutside = function(e) {
  if (e.target === document.getElementById('history-overlay'))
    document.getElementById('history-overlay').classList.remove('open');
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
  showScreen("home");
  activeBiz = null;
  activeMenu = [];
  const float = document.getElementById('track-float');
  if (float && float.style.display === 'flex') {
    float.style.display = 'flex';
  } else {
    float.style.display = 'none';
  }
  window.scrollTo(0, 0);
}

async function startOver() {
  // 🛑 stop live order listener
  if (unsubscribeOrder) {
    unsubscribeOrder();
    unsubscribeOrder = null;
  }

  // 🧹 reset app state
  activeBiz = null;
  activeMenu = [];
  cart = [];

  updateCartCount();

  // ☁️ clear cart in DB
  if (currentUser) {
    await clearCart(currentUser.uid);
  }

  // 🔍 clear search
  const input = document.getElementById("search-input");
  if (input) input.value = "";

  // 🧾 reset tracking UI
  const float = document.getElementById("track-float");
  if (float) float.style.display = "none";

  showScreen("home");
  window.scrollTo(0, 0);
}
}
// Safe navigation home — does NOT clear cart
function resetApp() {
  goHome();
}

function showTrackFromFloat() {
  showScreen('track');
  window.scrollTo(0, 0);
}

function setAuthLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }
  else {
    btn.disabled = false;
    const labels = {
      'el-btn': 'LOGIN', 'es-btn': 'CREATE ACCOUNT',
      'ph-btn': 'SEND OTP', 'ph-otp-btn': 'VERIFY & CONTINUE'
    };
    btn.innerHTML = `<span>${labels[btnId] || 'CONTINUE'}</span>`;
  }
}

function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found':       'No account found with this email.',
    'auth/wrong-password':       'Incorrect password.',
    'auth/invalid-email':        'Invalid email address.',
    'auth/email-already-in-use': 'An account with this email already exists.',
    'auth/weak-password':        'Password is too weak.',
    'auth/invalid-credential':   'Invalid email or password.',
    'auth/too-many-requests':    'Too many attempts. Please try again later.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

function formatDate(date) {
  return date.toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
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
window.startOver = startOver;
window.showTrackFromFloat = showTrackFromFloat;
window.confirmClearCart = function() {
  cart = [];
  updateCartCount();
  persistCart();
  document.getElementById('conflict-overlay').classList.remove('open');
  if (window._pendingBizSlug) { openMenu(window._pendingBizSlug); window._pendingBizSlug = null; }
}
window.cancelConflict = function() {
  document.getElementById('conflict-overlay').classList.remove('open');
  window._pendingBizSlug = null;
}

init();

