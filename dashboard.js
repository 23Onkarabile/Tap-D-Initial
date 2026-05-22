import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, query, where,
  orderBy, onSnapshot, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ══ FIREBASE INIT ══
let app, auth, db;

try {
  const configModule = await import('./firebase.config.js');
  const firebaseConfig = configModule.firebaseConfig || configModule.default;
  app  = initializeApp(firebaseConfig, 'dashboard');
  auth = getAuth(app);
  db   = getFirestore(app);
} catch(e) {
  console.warn('Could not load firebase.config.js');
  document.getElementById('loading').style.display = 'none';
  showScreen('auth');
  showError('Firebase config not found. Ensure firebase.config.js is in the same folder.');
}

// ══ STATE ══
let currentUser   = null;
let currentBizId  = null;
let currentBizDoc = null;
let ordersUnsub   = null;
let allOrders     = [];
let historyFilter = 'all';

// ══ AUTH STATE LISTENER ══
onAuthStateChanged(auth, async user => {
  document.getElementById('loading').style.display = 'none';
  if(user){
    currentUser = user;
    try {
      const uSnap = await getDoc(doc(db, 'vendors', user.uid));
      if(uSnap.exists()){
        currentBizId = uSnap.data().businessId;
        await loadBizInfo();
        showScreen('dashboard');
        subscribeOrders();
      } else {
        showScreen('auth');
        showError('Vendor account not found. Please sign up first.');
        await signOut(auth);
      }
    } catch(e) {
      showScreen('auth');
      showError('Error loading account: ' + e.message);
    }
  } else {
    currentUser = null;
    currentBizId = null;
    if(ordersUnsub){ ordersUnsub(); ordersUnsub = null; }
    showScreen('auth');
  }
});

// ══ LOAD BIZ INFO ══
async function loadBizInfo(){
  try {
    const snap = await getDoc(doc(db, 'businesses', currentBizId));
    if(snap.exists()){
      currentBizDoc = snap.data();
      document.getElementById('dash-biz-name').textContent = currentBizDoc.name;
      updateOpenToggle(currentBizDoc.isOpen);
    }
  } catch(e){ console.error(e); }
}

// ══ OPEN/CLOSE TOGGLE ══
window.toggleOpen = async function(){
  if(!currentBizId) return;
  try {
    const newState = !currentBizDoc.isOpen;
    await updateDoc(doc(db, 'businesses', currentBizId), { isOpen: newState });
    currentBizDoc.isOpen = newState;
    updateOpenToggle(newState);
    showToast(newState ? '✅ Restaurant is now OPEN' : '🔴 Restaurant is now CLOSED');
  } catch(e){ showToast('Error: ' + e.message, true); }
}

function updateOpenToggle(isOpen){
  const el    = document.getElementById('open-toggle');
  const label = document.getElementById('toggle-label');
  el.classList.toggle('open', isOpen);
  label.textContent = isOpen ? 'OPEN' : 'CLOSED';
}

// ══ SUBSCRIBE ORDERS (real-time) ══
function subscribeOrders(){
  if(ordersUnsub) ordersUnsub();
  const q = query(
    collection(db, 'orders'),
    where('businessId', '==', currentBizId),
    orderBy('createdAt', 'desc')
  );
  ordersUnsub = onSnapshot(q, snap => {
    allOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLiveOrders();
    renderStats();
    renderHistory();
  }, err => console.error('Orders listener:', err));
}

// ══ RENDER LIVE ORDERS ══
function renderLiveOrders(){
  const live   = allOrders.filter(o => ['pending','preparing','ready'].includes(o.status));
  const grid   = document.getElementById('orders-grid');
  const badge  = document.getElementById('pending-badge');
  const pending = live.filter(o => o.status === 'pending').length;

  badge.textContent = pending;
  badge.style.display = pending > 0 ? 'inline-flex' : 'none';

  if(!live.length){
    grid.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🍽</span>
        <div class="empty-title">NO ACTIVE ORDERS</div>
        <div class="empty-sub">New orders will appear here in real-time</div>
      </div>`;
    return;
  }

  grid.innerHTML = live.map((o, i) => {
    const time = o.createdAt ? formatTime(o.createdAt.toDate()) : '—';
    const itemsHtml = (o.items||[]).map(it => `
      <div class="order-item-line">
        <span class="order-item-name">${it.name}</span>
        <span class="order-item-qty">×${it.qty}</span>
        <span class="order-item-price">$${((it.price||0)*it.qty).toFixed(2)}</span>
      </div>`).join('');

    return `
      <div class="order-card status-${o.status}" style="animation-delay:${i*0.06}s">
        <div class="order-head">
          <div>
            <div class="order-num">${o.orderNumber || o.id.slice(0,8).toUpperCase()}</div>
            <div class="order-time">${time}</div>
          </div>
          <div class="order-status-badge badge-${o.status}">${o.status}</div>
        </div>
        <div class="order-body">
          <div class="order-customer">
            Customer: <strong>${o.customerName || 'Guest'}</strong>
            ${o.estimatedWait ? ' · Est. ' + o.estimatedWait : ''}
          </div>
          <div class="order-items">${itemsHtml}</div>
          <div class="order-foot">
            <div class="order-total">$${(o.total||0).toFixed(2)}</div>
            <div class="order-actions">${getActions(o)}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

function getActions(o){
  if(o.status === 'pending')   return `<button type="button" class="action-btn btn-prepare" onclick="updateStatus('${o.id}','preparing')">PREPARING</button>`;
  if(o.status === 'preparing') return `<button type="button" class="action-btn btn-ready"   onclick="updateStatus('${o.id}','ready')">MARK READY</button>`;
  if(o.status === 'ready')     return `<button type="button" class="action-btn btn-complete" onclick="updateStatus('${o.id}','completed')">COLLECTED</button>`;
  return '';
}

// ══ UPDATE ORDER STATUS ══
window.updateStatus = async function(orderId, newStatus){
  try {
    await updateDoc(doc(db, 'orders', orderId), {
      status: newStatus,
      updatedAt: serverTimestamp()
    });
    const labels = {
      preparing: '👨‍🍳 Order is now Preparing',
      ready:     '✅ Order Ready for Pickup',
      completed: '🎉 Order Collected'
    };
    showToast(labels[newStatus] || 'Updated');
  } catch(e){ showToast('Error: ' + e.message, true); }
}

// ══ STATS ══
function renderStats(){
  const today = new Date(); today.setHours(0,0,0,0);
  const todayOrders = allOrders.filter(o => o.createdAt && o.createdAt.toDate() >= today);
  const revenue = todayOrders
    .filter(o => o.status === 'completed')
    .reduce((s,o) => s + (o.total||0), 0);

  document.getElementById('stat-pending').textContent   = allOrders.filter(o=>o.status==='pending').length;
  document.getElementById('stat-preparing').textContent = allOrders.filter(o=>o.status==='preparing').length;
  document.getElementById('stat-ready').textContent     = allOrders.filter(o=>o.status==='ready').length;
  document.getElementById('stat-revenue').textContent   = '$' + revenue.toFixed(0);
}

// ══ HISTORY ══
function renderHistory(){
  const filtered = historyFilter === 'all'
    ? allOrders
    : allOrders.filter(o => o.status === historyFilter);

  document.getElementById('history-meta').textContent = `${filtered.length} orders`;

  if(!filtered.length){
    document.getElementById('history-body').innerHTML = `
      <div class="empty-state" style="padding:40px">
        <span class="empty-icon">📭</span>
        <div class="empty-title">NO ORDERS</div>
        <div class="empty-sub">Nothing to show for this filter</div>
      </div>`;
    return;
  }

  document.getElementById('history-body').innerHTML = filtered.map(o => {
    const itemSummary = (o.items||[]).map(i=>`${i.qty}× ${i.name}`).join(', ');
    const time = o.createdAt ? formatTime(o.createdAt.toDate()) : '—';
    return `
      <div class="history-row">
        <div class="h-order">${o.orderNumber || o.id.slice(0,6).toUpperCase()}</div>
        <div style="font-size:12px;color:var(--grey);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${itemSummary}</div>
        <div class="h-total">$${(o.total||0).toFixed(2)}</div>
        <div><span class="order-status-badge badge-${o.status}">${o.status}</span></div>
        <div class="h-wait" style="font-size:12px;color:var(--grey)">${time}</div>
      </div>`;
  }).join('');
}

window.filterHistory = function(f, btn){
  historyFilter = f;
  document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  renderHistory();
}

// ══ AUTH HANDLERS ══
window.handleLogin = async function(){
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  if(!email || !pass){ showError('Please fill in all fields.'); return; }
  setLoading('login-btn', true);
  clearError();
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch(e){
    showError(friendlyAuthError(e.code));
    setLoading('login-btn', false);
  }
}

window.handleSignup = async function(){
  const bizId   = document.getElementById('signup-biz').value;
  const email   = document.getElementById('signup-email').value.trim();
  const pass    = document.getElementById('signup-password').value;
  const confirm = document.getElementById('signup-confirm').value;

  if(!bizId)           { showError('Please select your restaurant.'); return; }
  if(!email)           { showError('Please enter your email.'); return; }
  if(pass.length < 6)  { showError('Password must be at least 6 characters.'); return; }
  if(pass !== confirm) { showError('Passwords do not match.'); return; }

  setLoading('signup-btn', true);
  clearError();
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await setDoc(doc(db, 'vendors', cred.user.uid), {
      businessId: bizId,
      email: email,
      createdAt: serverTimestamp()
    });
  } catch(e){
    showError(friendlyAuthError(e.code));
    setLoading('signup-btn', false);
  }
}

window.handleLogout = async function(){
  if(ordersUnsub){ ordersUnsub(); ordersUnsub = null; }
  await signOut(auth);
}

// ══ UI HELPERS ══
window.switchAuthTab = function(tab){
  document.getElementById('login-form').style.display  = tab === 'login'  ? 'block' : 'none';
  document.getElementById('signup-form').style.display = tab === 'signup' ? 'block' : 'none';
  document.querySelectorAll('.auth-tab').forEach((t,i) =>
    t.classList.toggle('active', (i===0 && tab==='login') || (i===1 && tab==='signup')));
  clearError();
}

window.switchTab = function(tab){
  document.querySelectorAll('.dash-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('nav-' + tab).classList.add('active');
}

function showScreen(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showError(msg){
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.add('show');
}
function clearError(){
  document.getElementById('auth-error').classList.remove('show');
}

let toastTimer;
function showToast(msg, isError=false){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function setLoading(btnId, loading){
  const btn = document.getElementById(btnId);
  if(loading){
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div>';
  } else {
    btn.disabled = false;
    btn.innerHTML = btnId === 'login-btn' ? '<span>LOGIN</span>' : '<span>CREATE ACCOUNT</span>';
  }
}

function formatTime(date){
  return date.toLocaleTimeString('en-ZA', { hour:'2-digit', minute:'2-digit' });
}

function friendlyAuthError(code){
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

setTimeout(() => {
  document.getElementById('loading').style.display = 'none';
}, 1500);
