// app.js — Customer-facing app
  window.addEventListener("error", () => {
    const biz = document.getElementById("biz-list");
    if (biz && biz.innerHTML.includes("Loading")) {
      biz.innerHTML =
        '<div class="error">Failed to load app.</div>';
    }
  });


import {
  getBusinesses,
  getBusiness,
  getMenu,
  placeOrder,
  subscribeToOrder,
  subscribeToBusinesses
} from "./firebase.service.js";

// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════
let businesses = []; // loaded from Firestore
let cart = [];
let activeBiz = null; // full business object
let activeMenu = []; // fetched menu for activeBiz
let unsubscribeBusinesses = null; // real-time listener cleanup
let unsubscribeOrder = null; // real-time order tracker cleanup

// ══════════════════════════════════════════════
// ROUTING — /business/:slug
// Reads the URL slug on load and opens the right menu.
// Works for both: grub.com/ (home)
// grub.com/business/paprika
// ══════════════════════════════════════════════
function resolveRoute() {
  const path = window.location.pathname; // e.g. "/business/paprika"
  const match = path.match(/\/business\/([^/]+)/);
  return match ? match[1] : null; // returns "paprika" or null
}

function pushRoute(slug) {
  const url = slug ? `/business/${slug}` : "/";
  window.history.pushState({ slug }, "", url);
}

window.addEventListener("popstate", (e) => {
  const slug = e.state?.slug || null;
  if (slug) {
    openMenu(slug, false); // false = don't push route again
  } else {
    goHome(false);
  }
});

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════
async function init() {
  showLoading("biz-list");

  // Subscribe to businesses with real-time updates (isOpen changes, etc.)
  unsubscribeBusinesses = subscribeToBusinesses((data) => {
    businesses = data;
    const openCount = data.filter(b => b.isOpen).length;
    document.getElementById('open-count').textContent = openCount + ' OPEN NOW';
    renderBizCards(businesses);
  });

  // Handle direct URL navigation (e.g. user visits /business/paprika directly)
  const routeSlug = resolveRoute();
  if (routeSlug) {
    await openMenu(routeSlug, false);
  }
}

// ══════════════════════════════════════════════
// HOME
// ══════════════════════════════════════════════
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
    </div>
  `).join("");
}

function filterBiz() {
  const q = document.getElementById("search-input").value.toLowerCase().trim();
  if (!q) { renderBizCards(businesses); return; }
  const filtered = businesses.filter(b =>
    b.name.toLowerCase().includes(q) ||
    b.tags.some(t => t.toLowerCase().includes(q))
    // Note: searching menu items requires fetching all menus, skip for MVP
  );
  renderBizCards(filtered);
}

// ══════════════════════════════════════════════
// MENU
// ══════════════════════════════════════════════
async function openMenu(bizSlug, pushHistory = true) {
  showLoading("menu-items");
  showScreen("menu");

  // Fetch business data
  activeBiz = await getBusiness(bizSlug);
  if (!activeBiz) {
    document.getElementById("menu-items").innerHTML = `<div class="error">Business not found.</div>`;
    return;
  }

  // Update route
  if (pushHistory) pushRoute(bizSlug);

  // Populate header
  document.getElementById("menu-banner").src = activeBiz.bannerUrl;
  document.getElementById("menu-biz-name").textContent = activeBiz.name;
  document.getElementById("menu-rating").textContent = activeBiz.rating;
  document.getElementById("menu-location").textContent = activeBiz.location;
  document.getElementById("menu-time").textContent =
    `${activeBiz.estimatedWaitMin}–${activeBiz.estimatedWaitMax} min`;

  // Fetch menu
  activeMenu = await getMenu(bizSlug);

  // Render category pills
  document.getElementById("cat-nav").innerHTML =
    activeMenu.map((sec, i) =>
      `<button class="cat-pill ${i === 0 ? "active" : ""}" onclick="scrollToSec('${sec.category}',this)">${sec.category}</button>`
    ).join("");

  renderMenuItems();
  window.scrollTo(0, 0);
}

function renderMenuItems() {
  document.getElementById("menu-items").innerHTML =
    activeMenu.map((sec, si) =>
      `<div id="sec-${sec.category}">
        <div class="menu-sec-title">${sec.category}</div>
        ${sec.items.map((item, ii) => renderItemHTML(item, si * 10 + ii)).join("")}
      </div>`
    ).join("");
}

// ── Unchanged from original ──
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

// ══════════════════════════════════════════════
// CART — Unchanged from original
// ══════════════════════════════════════════════
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
    const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
    totalEl.textContent = `$${total.toFixed(2)}`;
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

// ══════════════════════════════════════════════
// ORDER PLACEMENT — Now writes to Firestore
// ══════════════════════════════════════════════
async function submitOrder() {
  if (!cart.length) return;

  const orderBtn = document.getElementById("order-btn");
  orderBtn.disabled = true;
  orderBtn.textContent = "Placing order…";

  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const items = cart.map(c => ({
    itemId: c.id,
    name: c.name,
    price: c.price,
    qty: c.qty,
    subtotal: +(c.price * c.qty).toFixed(2)
  }));

  try {
    const order = await placeOrder({
      businessId: activeBiz.id,
      businessName: activeBiz.name,
      items,
      total: +total.toFixed(2),
      estimatedWait: `${activeBiz.estimatedWaitMin}–${activeBiz.estimatedWaitMax} min`,
      customerId: null, // replace with auth.currentUser?.uid for logged-in users
      customerName: "Guest"
    });

    // Show confirmation screen
    document.getElementById("confirm-order-num").textContent = `#${order.orderNumber}`;
    document.getElementById("confirm-detail").innerHTML = `
      <div class="confirm-row"><span class="label">Order</span><span class="val">${order.orderNumber}</span></div>
      <div class="confirm-row"><span class="label">From</span><span class="val">${activeBiz.name}</span></div>
      <div class="confirm-row"><span class="label">Items</span><span class="val" style="font-size:12px;color:#888;">${items.map(i => `${i.qty}× ${i.name}`).join(" · ")}</span></div>
      <div class="confirm-row"><span class="label">Pickup in</span><span class="val">${order.estimatedWait}</span></div>
      <div class="confirm-row"><span class="label">Total</span><span class="val lime">$${total.toFixed(2)}</span></div>
      <div class="confirm-row" id="order-status-row"><span class="label">Status</span><span class="val status-badge pending">⏳ Pending</span></div>
    `;

    document.getElementById("cart-overlay").classList.remove("open");
    cart = [];
    updateCartCount();
    showScreen("confirm");
    window.scrollTo(0, 0);

    // Subscribe to real-time order status updates
    if (unsubscribeOrder) unsubscribeOrder();
    unsubscribeOrder = subscribeToOrder(order.id, (updated) => {
      updateStatusBadge(updated.status);
    });

  } catch (err) {
    console.error("Order failed:", err);
    orderBtn.disabled = false;
    orderBtn.textContent = "Place Order";
    alert("Something went wrong. Please try again.");
  }
}

const STATUS_LABELS = {
  pending: "⏳ Pending",
  accepted: "✅ Accepted",
  ready: "🔔 Ready for Pickup",
  completed: "🎉 Completed",
  rejected: "❌ Rejected"
};

function updateStatusBadge(status) {
  const badge = document.querySelector(".status-badge");
  if (!badge) return;
  badge.textContent = STATUS_LABELS[status] || status;
  badge.className = `val status-badge ${status}`;
}

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════
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
  activeBiz = null;
  activeMenu = [];
  cart = [];
  updateCartCount();
  document.getElementById("search-input").value = "";
  goHome();
}

// ══════════════════════════════════════════════
// EXPOSE to HTML onclick attributes
// (Only needed because you're not using a framework)
// ══════════════════════════════════════════════
window.openMenu = openMenu;
window.filterBiz = filterBiz;
window.openCart = openCart;
window.closeCartOutside = closeCartOutside;
window.removeFromCart = removeFromCart;
window.addItem = addItem;
window.changeQty = changeQty;
window.scrollToSec = scrollToSec;
window.placeOrder = submitOrder; // HTML calls placeOrder(), maps to submitOrder()
window.goHome = goHome;
window.resetApp = resetApp;

// ══════════════════════════════════════════════
// START
// ══════════════════════════════════════════════
init();
