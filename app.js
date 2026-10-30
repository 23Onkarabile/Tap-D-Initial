// app.js: Customer-facing TapDish app
//  - sentence-case copy to match the new design
//  - friendly status labels (STATUS_LABELS / statusLabel)
//  - unpaid orders (payment_initiated) 

// Show a simple error if something crashes while the list is still loading
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
  getOrderHistory,
  callTapDishFunction
} from "./firebase.service.js";
import { enableOrderNotifications } from "./notifications.js";

// ══ STATE ══
let businesses = [];
let cart = [];
let activeBiz = null;
let activeMenu = [];
let unsubscribeBusinesses = null;
let unsubscribeOrder = null;
let pendingOrderData = null;
let pendingOrderId = null;        // set once the order is saved, so a payment retry reuses it
let currentUser = null;
let currentProfile = null;
let otpConfirmation = null;
let currentActiveOrder = null;
let pendingCartAfterAuth = false;

// Raw status codes in Firestore -> text shown to customers
const STATUS_LABELS = {
  payment_initiated: "Unpaid",
  pending: "Pending",
  preparing: "Preparing",
  ready: "Ready",
  completed: "Collected",
  rejected: "Rejected"
};
const statusLabel = (s) => STATUS_LABELS[s] || s;

// ══ ROUTING ══
function resolveRoute() {
  const match = window.location.pathname.match(/\/business\/([^/]+)/);
  return match ? match[1] : null;
}
function resolveOrderStatusRoute() {
  if (window.location.pathname !== "/order-status") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("reference");
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

  // Keep the signed-in user, their profile, cart and active order in sync
  onCustomerAuthChange(async (user) => {
    currentUser = user;
    if (user) {
      currentProfile = await getCustomerProfile(user.uid);
      updateProfileUI();
      await restoreCart();
      await restoreActiveOrder();
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

  // Live list of restaurants
  unsubscribeBusinesses = subscribeToBusinesses((data) => {
    businesses = data;
    const openCount = data.filter(b => b.isOpen).length;
    document.getElementById("open-count").textContent = openCount + " open now";
    filterBiz();
    renderPopular();
  });

  const orderReference = resolveOrderStatusRoute();
  if (orderReference) {
    await showOrderStatusByReference(orderReference);
    return;
  }

  const routeSlug = resolveRoute();
  if (routeSlug) await openMenu(routeSlug, false);
}

// ══ PROFILE UI ══
function updateProfileUI() {
  // #profile-btn is optional: the profile now opens from the bottom nav
  const btn = document.getElementById("profile-btn");
  const nameEl = document.getElementById("profile-name");
  const emailEl = document.getElementById("profile-email");
  const signedIn = currentUser && currentProfile;

  if (btn) {
    btn.classList.toggle("logged-in", !!signedIn);
    btn.title = signedIn ? (currentProfile.name || currentUser.email) : "Account";
  }
  if (nameEl) nameEl.textContent = signedIn ? (currentProfile.name || "Customer") : "—";
  if (emailEl) {
    emailEl.textContent = signedIn
      ? (currentProfile.email || currentUser.phoneNumber || "—")
      : "Not signed in";
  }
  updateGreeting();
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
  } catch (e) { console.error("restoreCart:", e); }
}

async function persistCart() {
  if (!currentUser) return;
  try {
    const bizId = cart.length ? cart[0].bizId : null;
    const bizName = cart.length ? cart[0].bizName : null;
    await saveCart(currentUser.uid, cart, bizId, bizName);
  } catch (e) { console.error("persistCart:", e); }
}

// ══ ACTIVE ORDER PERSISTENCE ══
async function restoreActiveOrder() {
  if (!currentUser) return;
  try {
    const order = await getActiveOrder(currentUser.uid);
    if (!order) return;
    currentActiveOrder = order;
    updateOrdersBadge();
    if (unsubscribeOrder) { unsubscribeOrder(); unsubscribeOrder = null; }
    // Listen for live status changes (pending -> preparing -> ready)
    unsubscribeOrder = subscribeToOrder(order.id, (updated) => {
      currentActiveOrder = { ...currentActiveOrder, status: updated.status };
      updateOrdersBadge();
      updateActiveOrderCard();
      if (["completed", "rejected"].includes(updated.status)) {
        if (currentUser) clearActiveOrder(currentUser.uid);
        setTimeout(() => {
          currentActiveOrder = null;
          updateOrdersBadge();
          updateActiveOrderCard();
        }, 5000);
      }
    });
  } catch (e) { console.error("restoreActiveOrder:", e); }
}

// ══ HOME ══
function renderBizCards(list) {
  const el = document.getElementById("biz-list");
  if (!list.length) {
    el.innerHTML = `<div class="no-results"><strong>No results found</strong>Try a different search term.</div>`;
    return;
  }
  // Small line icons for the stats row (pickup only: no distance, just where to collect)
  const ico = {
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12,7 12,12 15,14"/></svg>',
    star:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12,3 14.8,9 21,9.7 16.4,14 17.7,20.5 12,17.2 6.3,20.5 7.6,14 3,9.7 9.2,9"/></svg>',
    pin:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>'
  };
  el.innerHTML = list.map((b) => `
    <div class="biz-card ${b.isOpen ? "" : "is-closed"}" onclick="openMenu('${b.slug || b.id}')">
      <div class="biz-img-wrap">
        <img src="${b.bannerUrl}" alt="${b.name}" loading="lazy">
        <div class="biz-img-gradient"></div>
        ${favBtn(b)}
        <div class="biz-status">
          <div class="status-dot ${b.isOpen ? "" : "closed"}"></div>
          ${b.isOpen ? "Open" : "Closed"}
        </div>
        <div class="biz-title">
          <div class="biz-name">${b.name}</div>
          <div class="biz-cuisine">${(b.tags || []).join(" · ")}</div>
        </div>
      </div>
      <div class="biz-stats">
        <span class="stat">${ico.clock}${b.estimatedWaitMin}–${b.estimatedWaitMax} min</span>
        <span class="stat">${ico.star}${b.rating}${b.reviewCount ? ` <small>(${b.reviewCount})</small>` : ""}</span>
        <span class="stat">${ico.pin}${b.location}</span>
      </div>
    </div>`).join("");
}

function filterBiz() {
  const q = document.getElementById("search-input").value.toLowerCase().trim();
  let list = businesses;
  if (openOnly) list = list.filter(b => b.isOpen);
  if (q) {
    list = list.filter(b =>
      b.name.toLowerCase().includes(q) || (b.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }
  renderBizCards(list);
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
  document.getElementById("menu-items").innerHTML = activeMenu.map((sec) =>
    `<div id="sec-${sec.category}">
      <div class="menu-sec-title">${sec.category}</div>
      ${sec.items.map((item) => renderItemHTML(item)).join("")}
    </div>`
  ).join("");
}

function renderItemHTML(item) {
  const inCart = cart.find(c => c.id === item.id);
  const qty = inCart ? inCart.qty : 0;
  return `
    <div class="menu-item" id="item-${item.id}">
      <img class="item-img" src="${item.imgUrl}" alt="${item.name}" loading="lazy">
      <div class="item-body">
        <div class="item-name">${item.name}</div>
        <div class="item-desc">${item.desc}</div>
        <div class="item-footer">
          <div class="item-price">$${item.price.toFixed(2)}</div>
          ${qty === 0
            ? `<button class="add-btn" aria-label="Add ${item.name}" onclick='addItem(${JSON.stringify(item).replace(/'/g, "&#39;")})'>+</button>`
            : `<div class="item-qty">
                <button class="qty-btn" aria-label="Remove one" onclick='changeQty("${item.id}",-1)'>−</button>
                <span class="qty-num">${qty}</span>
                <button class="qty-btn" aria-label="Add one" onclick='changeQty("${item.id}",1)'>+</button>
              </div>`
          }
        </div>
      </div>
    </div>`;
}

// Re-draw just one menu item (so the whole menu doesn't flicker)
function refreshItem(itemId) {
  let data = null;
  for (const sec of activeMenu) {
    const f = sec.items.find(i => i.id === itemId);
    if (f) { data = f; break; }
  }
  if (!data) return;
  const el = document.getElementById(`item-${itemId}`);
  if (el) {
    const t = document.createElement("div");
    t.innerHTML = renderItemHTML(data);
    el.replaceWith(t.firstElementChild);
  }
}

function scrollToSec(cat, btn) {
  document.querySelectorAll(".cat-pill").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  const el = document.getElementById(`sec-${cat}`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ══ CART ══
function addItem(item) {
  // Cart already has items from a different restaurant -> ask before switching
  if (cart.length > 0 && cart[0].bizId !== activeBiz.id) {
    window._pendingItem = item;
    window._pendingBizSlug = activeBiz.slug || activeBiz.id;
    document.getElementById("conflict-from").textContent = cart[0].bizName || "another restaurant";
    document.getElementById("conflict-to").textContent = activeBiz.name || "this restaurant";
    document.getElementById("conflict-overlay").classList.add("open");
    return;
  }
  const ex = cart.find(c => c.id === item.id);
  if (ex) ex.qty++;
  else cart.push({ ...item, qty: 1, bizId: activeBiz.id, bizName: activeBiz.name });
  updateCartCount();
  refreshItem(item.id);
  persistCart();
}

function changeQty(id, d) {
  const idx = cart.findIndex(c => c.id === id);
  if (idx === -1) return;
  cart[idx].qty += d;
  if (cart[idx].qty <= 0) cart.splice(idx, 1);
  updateCartCount();
  refreshItem(id);
  persistCart();
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
        <button class="remove-btn" aria-label="Remove ${c.name}" onclick='removeFromCart("${c.id}")'>✕</button>
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
  // Guests must sign in first; the confirm step opens right after they do
  if (!currentUser) {
    pendingCartAfterAuth = true;
    openAuthSheet();
    orderBtn.disabled = false;
    orderBtn.textContent = "Place order for pickup";
    return;
  }
  openCustomerModal();
}

// ══ CONFIRM ORDER MODAL ══
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
    estimatedWait: activeBiz ? `${activeBiz.estimatedWaitMin}–${activeBiz.estimatedWaitMax} min` : "15 min",
  };
  pendingOrderId = null; // brand-new checkout: forget any earlier order

  const nameEl = document.getElementById("customer-name");
  const phoneEl = document.getElementById("customer-phone");
  if (currentProfile) {
    nameEl.value = currentProfile.name || "";
    phoneEl.value = currentProfile.phone || "";
  } else {
    nameEl.value = ""; phoneEl.value = "";
  }
  document.getElementById("customer-modal-error").textContent = "";
  document.getElementById("confirm-customer-btn").disabled = false;
  document.getElementById("confirm-customer-btn").textContent = "Confirm and place order";
  document.getElementById("customer-modal").classList.add("open");
}

window.closeCustomerModal = function () {
  document.getElementById("customer-modal").classList.remove("open");
  const btn = document.getElementById("order-btn");
  btn.disabled = false;
  btn.textContent = "Place order for pickup";
};

window.confirmCustomerDetails = async function () {
  const name = document.getElementById("customer-name").value.trim();
  const phone = document.getElementById("customer-phone").value.trim();
  const errEl = document.getElementById("customer-modal-error");
  const confirmBtn = document.getElementById("confirm-customer-btn");
  if (!name) { errEl.textContent = "Please enter your name."; return; }
  if (!phone) { errEl.textContent = "Please enter your phone number."; return; }
  if (!/^[0-9+\s]{7,15}$/.test(phone)) { errEl.textContent = "Please enter a valid phone number."; return; }
  errEl.textContent = "";
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Placing order…";
  try {
    // Only save the order once. If payment fails and the customer taps again,
    // we reuse this order instead of creating a duplicate.
    if (!pendingOrderId) {
      const order = await placeOrder({
        ...pendingOrderData,
        customerName: name,
        customerPhone: phone,
        customerId: currentUser ? currentUser.uid : null
      });
      pendingOrderId = order.id;

      if (currentUser) {
        await saveActiveOrder(currentUser.uid, order.id);
        await clearCart(currentUser.uid);
      }
      cart = [];
      updateCartCount();
    }

    // Create the Stitch payment session and send the customer to pay
    confirmBtn.textContent = "Redirecting to payment…";
    const paymentResult = await callTapDishFunction("createPaymentSession", { orderId: pendingOrderId });
    window.location.href = paymentResult.checkoutUrl;

  } catch (err) {
    errEl.textContent = "Error: " + err.message;
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Confirm and place order";
  }
};

// Opened from the payment provider's redirect (/order-status?reference=...)
async function showOrderStatusByReference(orderNumber) {
  showScreen("home");
  document.getElementById("track-order-num").textContent = orderNumber;
  document.getElementById("track-status-badge").textContent = "⏳ Checking your order…";
  document.getElementById("track-status-sub").textContent = "Just a moment while we fetch your latest status.";
  document.getElementById("track-overlay").classList.add("open");

  onCustomerAuthChange(async (user) => {
    if (!user) return;
    try {
      const orders = await getOrderHistory(user.uid);
      const order = orders.find(o => o.orderNumber === orderNumber);
      if (!order) {
        document.getElementById("track-status-sub").textContent = "We couldn't find that order on your account.";
        return;
      }
      showTrackScreen(order, false);
      if (unsubscribeOrder) { unsubscribeOrder(); unsubscribeOrder = null; }
      unsubscribeOrder = subscribeToOrder(order.id, (updated) => {
        updateTrackStatus(updated.status);
      });
    } catch (e) {
      console.error("showOrderStatusByReference:", e);
      document.getElementById("track-status-sub").textContent = "Error loading order status.";
    }
  });
}

// ══ TRACK ORDER SHEET ══
function showTrackScreen(order, navigate = true) {
  document.getElementById("track-order-num").textContent = order.orderNumber;
  document.getElementById("track-biz-name").textContent = order.businessName;
  document.getElementById("track-customer-name").textContent = order.customerName || "—";
  document.getElementById("track-phone").textContent = order.customerPhone || "—";
  document.getElementById("track-wait").textContent = order.estimatedWait || "—";
  document.getElementById("track-total").textContent = `$${(order.total || 0).toFixed(2)}`;
  document.getElementById("track-items").textContent =
    (order.items || []).map(i => `${i.qty}× ${i.name}`).join(" · ");
  updateTrackStatus(order.status || "pending");
  updateNotifyButton(order.status);
  if (navigate) document.getElementById("track-overlay").classList.add("open");
}

// Text and step position for each order status
const STATUS_CONFIG = {
  payment_initiated: { label: "⚠️ Payment not completed", sub: "Your payment wasn't finished. Please try again to place this order.", class: "rejected", step: 0 },
  pending:   { label: "⏳ Pending",            sub: "Your order has been received. Hang tight!",           class: "pending",   step: 1 },
  preparing: { label: "👨‍🍳 Being prepared",     sub: "The kitchen is working on your order right now.",    class: "preparing", step: 2 },
  ready:     { label: "🔔 Ready for pickup",   sub: "Your order is ready. Come collect it now!",          class: "ready",     step: 3 },
  completed: { label: "🎉 Collected",          sub: "Thanks for ordering with TapDish. Enjoy your meal!", class: "completed", step: 4 },
  rejected:  { label: "❌ Rejected",           sub: "Sorry, your order could not be fulfilled.",           class: "rejected",  step: 0 },
};

function updateTrackStatus(status) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  const badgeEl = document.getElementById("track-status-badge");
  const subEl = document.getElementById("track-status-sub");
  if (!badgeEl || !subEl) return;
  badgeEl.textContent = cfg.label;
  badgeEl.className = `track-status-badge ${cfg.class}`;
  subEl.textContent = cfg.sub;
  [1, 2, 3].forEach(step => {
    const el = document.getElementById(`step-${step}`);
    if (!el) return;
    el.classList.remove("active", "done");
    if (cfg.step === step) el.classList.add("active");
    if (cfg.step > step) el.classList.add("done");
  });
  if (status === "ready") triggerReadyAlert();
}

// Flash, chime and banner when the order is ready
function triggerReadyAlert() {
  const sheet = document.getElementById("track-overlay");
  if (sheet) { sheet.classList.add("ready-flash"); setTimeout(() => sheet.classList.remove("ready-flash"), 2000); }
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
  } catch (e) { console.log("Audio not available:", e); }
  const banner = document.getElementById("ready-banner");
  if (banner) { banner.classList.add("show"); setTimeout(() => banner.classList.remove("show"), 6000); }
}

// ══ SIGN IN SHEET ══
function openAuthSheet() { document.getElementById("auth-overlay").classList.add("open"); }
function closeAuthSheet() { document.getElementById("auth-overlay").classList.remove("open"); }
window.closeAuthOutside = function (e) {
  if (e.target === document.getElementById("auth-overlay")) closeAuthSheet();
};
window.switchAuthMethod = function (method) {
  document.getElementById("auth-email-section").style.display = method === "email" ? "block" : "none";
  document.getElementById("auth-phone-section").style.display = method === "phone" ? "block" : "none";
  document.getElementById("method-email").classList.toggle("active", method === "email");
  document.getElementById("method-phone").classList.toggle("active", method === "phone");
};
window.switchEmailTab = function (tab) {
  document.getElementById("email-login-form").style.display = tab === "login" ? "block" : "none";
  document.getElementById("email-signup-form").style.display = tab === "signup" ? "block" : "none";
  document.getElementById("etab-login").classList.toggle("active", tab === "login");
  document.getElementById("etab-signup").classList.toggle("active", tab === "signup");
};
window.handleEmailLogin = async function () {
  const email = document.getElementById("el-email").value.trim();
  const pass = document.getElementById("el-password").value;
  const errEl = document.getElementById("el-error");
  errEl.style.color = "";
  if (!email || !pass) { errEl.textContent = "Please fill in all fields."; return; }
  setAuthLoading("el-btn", true); errEl.textContent = "";
  try { await customerSignIn(email, pass); closeAuthSheet(); }
  catch (e) { errEl.textContent = friendlyAuthError(e.code); setAuthLoading("el-btn", false); }
};
window.handleEmailSignup = async function () {
  const name = document.getElementById("es-name").value.trim();
  const phone = document.getElementById("es-phone").value.trim();
  const email = document.getElementById("es-email").value.trim();
  const pass = document.getElementById("es-password").value;
  const errEl = document.getElementById("es-error");
  if (!name) { errEl.textContent = "Please enter your name."; return; }
  if (!phone) { errEl.textContent = "Please enter your phone number."; return; }
  if (!email) { errEl.textContent = "Please enter your email."; return; }
  if (pass.length < 6) { errEl.textContent = "Password must be at least 6 characters."; return; }
  setAuthLoading("es-btn", true); errEl.textContent = "";
  try { await customerSignUp(email, pass, name, phone); closeAuthSheet(); }
  catch (e) { errEl.textContent = friendlyAuthError(e.code); setAuthLoading("es-btn", false); }
};
window.handleAuthForgotPassword = async function () {
  const email = document.getElementById("el-email").value.trim();
  const errEl = document.getElementById("el-error");
  if (!email) { errEl.style.color = ""; errEl.textContent = "Enter your email above first."; return; }
  try {
    await resetPassword(email);
    errEl.style.color = "var(--green)";
    errEl.textContent = "✅ Reset email sent. Check your inbox.";
  } catch (e) { errEl.style.color = ""; errEl.textContent = friendlyAuthError(e.code); }
};
window.handleSendOTP = async function () {
  const phone = document.getElementById("ph-number").value.trim();
  const errEl = document.getElementById("ph-error");
  if (!phone) { errEl.textContent = "Please enter your phone number."; return; }
  setAuthLoading("ph-btn", true); errEl.textContent = "";
  try {
    otpConfirmation = await sendOTP(phone, "recaptcha-container");
    document.getElementById("phone-step-1").style.display = "none";
    document.getElementById("phone-step-2").style.display = "block";
  } catch (e) { errEl.textContent = "Error sending code: " + e.message; setAuthLoading("ph-btn", false); }
};
window.handleVerifyOTP = async function () {
  const otp = document.getElementById("ph-otp").value.trim();
  const name = document.getElementById("ph-name").value.trim();
  const errEl = document.getElementById("ph-otp-error");
  if (!otp) { errEl.textContent = "Please enter the code."; return; }
  if (!name) { errEl.textContent = "Please enter your name."; return; }
  setAuthLoading("ph-otp-btn", true); errEl.textContent = "";
  try {
    const result = await otpConfirmation.confirm(otp);
    const phone = document.getElementById("ph-number").value.trim();
    await savePhoneProfile(result.user.uid, name, phone);
    closeAuthSheet();
  } catch (e) { errEl.textContent = "That code isn't right. Please try again."; setAuthLoading("ph-otp-btn", false); }
};

// ══ PROFILE SHEET ══
window.openProfileSheet = function () {
  if (!currentUser) { openAuthSheet(); return; }
  document.getElementById("profile-overlay").classList.add("open");
};
window.closeProfileOutside = function (e) {
  if (e.target === document.getElementById("profile-overlay"))
    document.getElementById("profile-overlay").classList.remove("open");
};
window.handleSignOut = async function () {
  await customerSignOut();
  document.getElementById("profile-overlay").classList.remove("open");
};

// ══ ORDER HISTORY ══
window.openOrderHistory = async function () {
  document.getElementById("profile-overlay").classList.remove("open");
  document.getElementById("history-overlay").classList.add("open");
  const listEl = document.getElementById("history-list");
  const subEl = document.getElementById("history-sheet-sub");
  listEl.innerHTML = `<div class="history-loading">Loading your orders…</div>`;
  try {
    const orders = await getOrderHistory(currentUser.uid);
    subEl.textContent = `${orders.length} order${orders.length !== 1 ? "s" : ""}`;

    // Hide the order that is still active (it shows under My orders)
    const filteredOrders = orders.filter(o =>
      !currentActiveOrder || o.id !== currentActiveOrder.id
    );
    if (!filteredOrders.length) {
      listEl.innerHTML = '<div class="history-empty"><span class="history-empty-icon">🧾</span><p>No past orders yet.</p></div>';
      return;
    }
    listEl.innerHTML = filteredOrders.map((o) => {
      const date = o.createdAt ? formatDate(o.createdAt.toDate()) : "—";
      const items = (o.items || []).map(it => `${it.qty}× ${it.name}`).join(", ");
      return `<div class="history-order-card">
          <div class="hoc-head">
            <span class="hoc-num">${o.orderNumber || o.id.slice(0, 8).toUpperCase()}</span>
            <span class="hoc-date">${date}</span>
          </div>
          <div class="hoc-biz">${o.businessName || "—"}</div>
          <div class="hoc-items">${items}</div>
          <div class="hoc-foot">
            <span class="hoc-total">$${(o.total || 0).toFixed(2)}</span>
            <span class="hoc-status ${o.status}">${statusLabel(o.status)}</span>
          </div>
        </div>`;
    }).join("");
  } catch (e) {
    // Firestore tells you the URL to create a missing index: offer it to the developer
    const url = e.message.match(/https:\/\/\S+/)?.[0];
    if (url) prompt("Copy this URL to create the index:", url);
    listEl.innerHTML = `<div class="history-empty"><p>Error loading orders.<br>${e.message}</p></div>`;
  }
};
window.closeHistoryOutside = function (e) {
  if (e.target === document.getElementById("history-overlay"))
    document.getElementById("history-overlay").classList.remove("open");
};

// ══ HELPERS ══
function showLoading(containerId) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = `<div class="loading-state">Loading…</div>`;
}
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  updateBottomNav(id);
}
function goHome(pushHistory = true) {
  if (pushHistory) pushRoute(null);
  showScreen("home");
  window.scrollTo(0, 0);
}
async function startOver() {
  if (unsubscribeOrder) { unsubscribeOrder(); unsubscribeOrder = null; }
  activeBiz = null; activeMenu = []; cart = [];
  updateCartCount();
  if (currentUser) await clearCart(currentUser.uid);
  const input = document.getElementById("search-input");
  if (input) input.value = "";
  showScreen("home");
  window.scrollTo(0, 0);
}
function resetApp() { goHome(); }

// Spinner while signing in; restores the button text afterwards
function setAuthLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }
  else {
    btn.disabled = false;
    const labels = { "el-btn": "Log in", "es-btn": "Create account", "ph-btn": "Send code", "ph-otp-btn": "Verify and continue" };
    btn.innerHTML = `<span>${labels[btnId] || "Continue"}</span>`;
  }
}
function friendlyAuthError(code) {
  const map = {
    "auth/user-not-found": "No account found with this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-email": "Invalid email address.",
    "auth/email-already-in-use": "An account with this email already exists.",
    "auth/weak-password": "Password is too weak.",
    "auth/invalid-credential": "Invalid email or password.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
  };
  return map[code] || "Something went wrong. Please try again.";
}
function formatDate(date) {
  return date.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ══ EXPOSE TO index.html (inline onclick handlers) ══
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

window.confirmClearCart = async function () {
  cart = [];
  updateCartCount();
  if (currentUser) await clearCart(currentUser.uid);
  document.getElementById("conflict-overlay").classList.remove("open");
  if (window._pendingItem) {
    const item = window._pendingItem;
    window._pendingItem = null;
    addItem(item);
  }
};
window.cancelConflict = function () {
  document.getElementById("conflict-overlay").classList.remove("open");
  window._pendingItem = null;
  window._pendingBizSlug = null;
};

// ══ BOTTOM NAV ══
window.bottomNav = function (tab) {
  document.querySelectorAll(".bottom-nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("bnav-" + tab).classList.add("active");
  if (tab === "home") {
    document.getElementById("orders-overlay").classList.remove("open");
    document.getElementById("fav-overlay").classList.remove("open");
    goHome();
  } else if (tab === "favs") {
    document.getElementById("orders-overlay").classList.remove("open");
    openFavSheet();
  } else if (tab === "orders") {
    document.getElementById("fav-overlay").classList.remove("open");
    openOrdersSheet();
  } else if (tab === "profile") {
    document.getElementById("orders-overlay").classList.remove("open");
    document.getElementById("fav-overlay").classList.remove("open");
    if (!currentUser) { openAuthSheet(); return; }
    document.getElementById("profile-overlay").classList.add("open");
  }
};

function updateBottomNav() {
  // Home tab is always visible so the bar keeps all three items
  const homeBtn = document.getElementById("bnav-home");
  if (homeBtn) homeBtn.style.display = "";
}

function updateOrdersBadge() {
  const badge = document.getElementById("bnav-orders-badge");
  if (!badge) return;
  const live = currentActiveOrder && !["completed", "rejected"].includes(currentActiveOrder.status);
  badge.style.display = live ? "block" : "none";
}

function updateActiveOrderCard() {
  const section = document.getElementById("active-order-section");
  if (!section) return;
  if (!currentActiveOrder || ["completed", "rejected"].includes(currentActiveOrder.status)) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  document.getElementById("aoc-num").textContent = currentActiveOrder.orderNumber || "—";
  document.getElementById("aoc-biz").textContent = currentActiveOrder.businessName || "—";
  document.getElementById("aoc-items").textContent = (currentActiveOrder.items || [])
    .map(i => `${i.qty}× ${i.name}`).join(" · ");
  document.getElementById("aoc-total").textContent = `$${(currentActiveOrder.total || 0).toFixed(2)}`;
  const statusEl = document.getElementById("aoc-status");
  statusEl.textContent = statusLabel(currentActiveOrder.status);
  statusEl.className = "aoc-status-badge " + (currentActiveOrder.status || "pending");
}

window.viewActiveOrder = function () {
  document.getElementById("orders-overlay").classList.remove("open");
  if (currentActiveOrder) {
    showTrackScreen(currentActiveOrder, false);
    document.getElementById("track-overlay").classList.add("open");
  }
};

window.closeOrdersOutside = function (e) {
  if (e.target === document.getElementById("orders-overlay"))
    document.getElementById("orders-overlay").classList.remove("open");
};

// ══ ORDERS SHEET (Processing / Past orders) ══
let currentOrdersTab = "processing";
let cachedOrders = [];

async function openOrdersSheet() {
  document.getElementById("orders-overlay").classList.add("open");
  updateActiveOrderCard();
  if (!currentUser) {
    document.getElementById("orders-history-list").innerHTML = '<div class="history-empty"><span class="history-empty-icon">🔒</span><p>Sign in to see your orders.</p></div>';
    return;
  }
  document.getElementById("orders-history-list").innerHTML = '<div class="history-loading">Loading your orders…</div>';
  try {
    cachedOrders = await getOrderHistory(currentUser.uid);
    renderOrdersTab(currentOrdersTab);
  } catch (e) {
    document.getElementById("orders-history-list").innerHTML = `<div class="history-empty"><p>Error loading orders.<br>${e.message}</p></div>`;
  }
}

window.switchOrdersTab = function (tab) {
  currentOrdersTab = tab;
  document.getElementById("otab-processing").classList.toggle("active", tab === "processing");
  document.getElementById("otab-past").classList.toggle("active", tab === "past");
  renderOrdersTab(tab);
};

function renderOrdersTab(tab) {
  const listEl = document.getElementById("orders-history-list");
  const subEl = document.getElementById("orders-sheet-sub");

  // Unpaid orders now show here too, so customers can see them
  const processing = cachedOrders.filter(o =>
    ["payment_initiated", "pending", "preparing", "ready"].includes(o.status) &&
    (!currentActiveOrder || o.id !== currentActiveOrder.id)
  );
  const completed = cachedOrders.filter(o =>
    ["completed", "rejected"].includes(o.status)
  );

  if (tab === "processing") {
    subEl.textContent = `${processing.length} order${processing.length !== 1 ? "s" : ""}`;
    if (!processing.length) {
      listEl.innerHTML = '<div class="history-empty"><span class="history-empty-icon">⏳</span><p>No orders in progress.</p></div>';
      return;
    }
    listEl.innerHTML = processing.map((o) => {
      const items = (o.items || []).map(it => `${it.qty}× ${it.name}`).join(", ");
      return `<div class="history-order-card" style="border-color:var(--accent-line)">
        <div class="hoc-head">
          <span class="hoc-num">${o.orderNumber || o.id.slice(0, 8).toUpperCase()}</span>
          <span class="hoc-status ${o.status}">${statusLabel(o.status)}</span>
        </div>
        <div class="hoc-biz">${o.businessName || "—"}</div>
        <div class="hoc-items">${items}</div>
        <div class="hoc-foot">
          <span class="hoc-total">$${(o.total || 0).toFixed(2)}</span>
        </div>
      </div>`;
    }).join("");
  } else {
    subEl.textContent = `${completed.length} order${completed.length !== 1 ? "s" : ""}`;
    if (!completed.length) {
      listEl.innerHTML = '<div class="history-empty"><span class="history-empty-icon">🧾</span><p>No past orders yet.</p></div>';
      return;
    }
    listEl.innerHTML = completed.map((o) => {
      const date = o.createdAt ? formatDate(o.createdAt.toDate()) : "—";
      const items = (o.items || []).map(it => `${it.qty}× ${it.name}`).join(", ");
      return `<div class="history-order-card">
        <div class="hoc-head">
          <span class="hoc-num">${o.orderNumber || o.id.slice(0, 8).toUpperCase()}</span>
          <span class="hoc-date">${date}</span>
        </div>
        <div class="hoc-biz">${o.businessName || "—"}</div>
        <div class="hoc-items">${items}</div>
        <div class="hoc-foot">
          <span class="hoc-total">$${(o.total || 0).toFixed(2)}</span>
          <span class="hoc-status ${o.status}">${statusLabel(o.status)}</span>
        </div>
      </div>`;
    }).join("");
  }
}

// ══ PROFILE ACTIONS (placeholders) ══
window.openEditProfile = function () {
  document.getElementById("profile-overlay").classList.remove("open");
  alert("Edit profile is coming soon.");
};
window.openMyAddress = function () {
  document.getElementById("profile-overlay").classList.remove("open");
  alert("My address is coming soon.");
};
window.openPayment = function () {
  document.getElementById("profile-overlay").classList.remove("open");
  alert("Payment settings are coming soon.");
};

// ══ HOME: greeting, categories, open-only filter, popular row ══
let openOnly = false;

// "Good morning, Name!" based on the phone's clock
function updateGreeting() {
  const hiEl = document.getElementById("greet-hi");
  const nameEl = document.getElementById("greet-name");
  if (!hiEl || !nameEl) return;
  const h = new Date().getHours();
  hiEl.textContent = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const first = ((currentProfile && currentProfile.name) || "").split(" ")[0];
  nameEl.textContent = first ? first + "!" : "Hungry?";
}

// "Open now" pill: show only restaurants that are open
window.toggleOpenOnly = function () {
  openOnly = !openOnly;
  const btn = document.getElementById("filter-open");
  btn.classList.toggle("on", openOnly);
  btn.setAttribute("aria-pressed", openOnly);
  filterBiz();
};

// Category tile: fills the search box with a keyword that matches restaurant names or tags
window.pickCategory = function (term, btn) {
  document.querySelectorAll(".cat-tile").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("search-input").value = term;
  filterBiz();
  scrollToList();
};

window.scrollToList = function () {
  const el = document.getElementById("all-restaurants");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
};

// Top 5 rated restaurants in a sideways-scrolling row
function renderPopular() {
  const row = document.getElementById("pop-row");
  if (!row) return;
  const top = [...businesses].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 5);
  row.innerHTML = top.map(b => `
    <div class="pop-card" onclick="openMenu('${b.slug || b.id}')">
      <img src="${b.bannerUrl}" alt="${b.name}" loading="lazy">
      <div class="pop-body">
        <div class="pop-name">${b.name}</div>
        <div class="pop-meta">⭐ ${b.rating} · ${b.estimatedWaitMin}–${b.estimatedWaitMax} min</div>
      </div>
    </div>`).join("");
}

// ══ FAVOURITES (saved on this device) ══
const FAV_KEY = "tapdish_favs";
function getFavs() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch (e) { return []; }
}
function setFavs(list) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (e) { /* storage blocked: ignore */ }
}
function favBtn(b) {
  const on = getFavs().includes(b.id);
  return `<button type="button" class="fav-btn ${on ? "on" : ""}" aria-label="${on ? "Remove from" : "Add to"} favourites" onclick="toggleFav(event,'${b.id}')">${on ? "♥" : "♡"}</button>`;
}
window.toggleFav = function (e, id) {
  e.stopPropagation(); // don't open the menu when the heart is tapped
  const favs = getFavs();
  const i = favs.indexOf(id);
  if (i > -1) favs.splice(i, 1); else favs.push(id);
  setFavs(favs);
  filterBiz();
  renderFavList();
};
function renderFavList() {
  const listEl = document.getElementById("fav-list");
  const subEl = document.getElementById("fav-sub");
  if (!listEl) return;
  const favs = getFavs();
  const mine = businesses.filter(b => favs.includes(b.id));
  subEl.textContent = `${mine.length} saved`;
  if (!mine.length) {
    listEl.innerHTML = '<div class="history-empty"><span class="history-empty-icon">♡</span><p>No favourites yet.<br>Tap the heart on a restaurant to save it.</p></div>';
    return;
  }
  listEl.innerHTML = mine.map(b => `
    <div class="history-order-card" onclick="closeFav();openMenu('${b.slug || b.id}')">
      <div class="hoc-head"><span class="hoc-num">${b.name}</span><span class="hoc-date">${b.isOpen ? "Open" : "Closed"}</span></div>
      <div class="hoc-items">⭐ ${b.rating} · ${b.estimatedWaitMin}–${b.estimatedWaitMax} min · ${b.location}</div>
    </div>`).join("");
}
function openFavSheet() {
  renderFavList();
  document.getElementById("fav-overlay").classList.add("open");
}
window.closeFav = function () { document.getElementById("fav-overlay").classList.remove("open"); };
window.closeFavOutside = function (e) {
  if (e.target === document.getElementById("fav-overlay")) closeFav();
};

// ══ PUSH NOTIFICATIONS ("your order is ready") ══
const IS_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const IS_INSTALLED = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;

// Show the "Notify me" button only while the order is still being made,
// and only on devices that can receive alerts (iPhones need the home-screen install first)
function updateNotifyButton(status) {
  const btn = document.getElementById("notify-btn");
  if (!btn) return;
  const canNotify = "Notification" in window && "serviceWorker" in navigator;
  const waiting = ["pending", "preparing"].includes(status);
  btn.style.display = waiting && (canNotify || IS_IOS) ? "block" : "none";
  btn.disabled = false;
  btn.textContent = "🔔 Notify me when it's ready";
}

window.enableNotifications = async function () {
  const btn = document.getElementById("notify-btn");
  if (IS_IOS && !IS_INSTALLED) {
    alert("On iPhone: tap the Share button, choose Add to Home Screen, then open TapDish from your home screen and tap this button again.");
    return;
  }
  if (!currentUser) { openAuthSheet(); return; }
  btn.disabled = true;
  btn.textContent = "Turning on…";
  try {
    await enableOrderNotifications(currentUser.uid);
    btn.textContent = "✅ You'll get an alert when it's ready";
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "🔔 Notify me when it's ready";
    alert(e.message);
  }
};

updateGreeting();
init();
