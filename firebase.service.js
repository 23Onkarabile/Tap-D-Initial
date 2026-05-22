// firebase.service.js
// All Firestore read/write operations live here.
import { db, auth } from "./firebase.config.js";

import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  Timestamp,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";


// BUSINESSES

/**
 * Fetch all businesses (for home screen listing).
 * @returns {Promise<Array>}
 */
export async function getBusinesses() {
  const snap = await getDocs(collection(db, "businesses"));
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

/**
 * Fetch a single business by slug/id.
 * @param {string} businessId
 * @returns {Promise<Object|null>}
 */
export async function getBusiness(businessId) {
  const snap = await getDoc(doc(db, "businesses", businessId));
  return snap.exists() ? { ...snap.data(), id: snap.id } : null;
}

/**
 * Real-time listener on all businesses (e.g. isOpen status updates).
 * @param {Function} callback  — called with updated businesses array
 * @returns unsubscribe function
 */
export function subscribeToBusinesses(callback) {
  return onSnapshot(collection(db, "businesses"), snap => {
    const businesses = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    callback(businesses);
  });
}

// ─────────────────────────────────────────────
// MENUS
// ─────────────────────────────────────────────

/**
 * Fetch full menu for a business.
 * Returns array shaped like the original static data:
 *   [{ category: "Starters", items: [...] }, ...]
 * @param {string} businessId
 * @returns {Promise<Array>}
 */
export async function getMenu(businessId) {
  const catSnap = await getDocs(
    query(
      collection(db, "menus", businessId, "categories"),
      orderBy("sortOrder")
    )
  );

  const sections = await Promise.all(
    catSnap.docs.map(async catDoc => {
      const itemSnap = await getDocs(
        query(
          collection(db, "menus", businessId, "categories", catDoc.id, "items"),
          orderBy("sortOrder")
        )
      );
      return {
        category: catDoc.data().name,
        items: itemSnap.docs
          .map(d => ({ ...d.data(), id: d.id }))
          .filter(item => item.isAvailable)
      };
    })
  );

  return sections;
}

// ─────────────────────────────────────────────
// ORDERS  —  Customer side
// ─────────────────────────────────────────────

/**
 * Place a new order. Returns the created order document.
 * @param {Object} orderData
 * @returns {Promise<Object>}
 */
export async function placeOrder(orderData) {
  const orderNum = `GRB-${Math.floor(Math.random() * 9000) + 1000}`;
  const payload = {
    ...orderData,
    orderNumber: orderNum,
    status: "pending",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  const ref = await addDoc(collection(db, "orders"), payload);
  return { id: ref.id, ...payload, orderNumber: orderNum };
}

/**
 * Real-time listener for a single order (customer order tracking).
 * @param {string} orderId
 * @param {Function} callback
 * @returns unsubscribe function
 */
export function subscribeToOrder(orderId, callback) {
  return onSnapshot(doc(db, "orders", orderId), snap => {
    if (snap.exists()) callback({ id: snap.id, ...snap.data() });
  });
}

// ─────────────────────────────────────────────
// ORDERS  —  Vendor dashboard side
// ─────────────────────────────────────────────

/**
 * Real-time listener for all orders belonging to a business.
 * Vendor ONLY sees their own orders (filtered by businessId).
 * @param {string} businessId
 * @param {Function} callback
 * @returns unsubscribe function
 */
export function subscribeToVendorOrders(businessId, callback) {
  const q = query(
    collection(db, "orders"),
    where("businessId", "==", businessId),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, snap => {
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(orders);
  });
}

/**
 * Update order status (vendor action).
 * Valid statuses: "pending" | "accepted" | "ready" | "completed" | "rejected"
 * @param {string} orderId
 * @param {string} status
 */
export async function updateOrderStatus(orderId, status) {
  await updateDoc(doc(db, "orders", orderId), {
    status,
    updatedAt: serverTimestamp()
  });
}

// AUTH
/**
 * Sign up a new user and create their profile doc.
 * @param {string} email
 * @param {string} password
 * @param {string} name
 * @param {string} role  — "customer" | "vendor"
 * @returns {Promise<Object>}
 */
export async function signUp(email, password, name, role = "customer", businessId = null) {
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  await setDoc(doc(db, "users", user.uid), {
    name,
    email,
    role,
    ...(businessId && { businessId }),
    createdAt: serverTimestamp()
  });
  return user;
}

/**
 * Sign in existing user.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<Object>}
 */
export async function signIn(email, password) {
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  return user;
}

/**
 * Sign out current user.
 */
export async function logOut() {
  await signOut(auth);
}

/**
 * Listen to auth state changes (logged in / logged out).
 * Call this once when your app loads.
 * @param {Function} callback  — called with user object or null
 * @returns unsubscribe function
 */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}
/**
 * Fetch user profile doc (role, businessId, etc.)
 * @param {string} uid
 * @returns {Promise<Object|null>}
 */
export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
