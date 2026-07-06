// firebase.service.js
import { db, auth } from "./firebase.config.js";

import {
  collection, doc, getDoc, getDocs, addDoc, setDoc,
  updateDoc, onSnapshot, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  RecaptchaVerifier,
  signInWithPhoneNumber
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// ══ RENDER BACKEND ══
const RENDER_BASE_URL = 'https://tap-d-initial-backend.onrender.com';

export async function callTapDishFunction(functionName, data, user) {
  const idToken = await user.getIdToken();
  const res = await fetch(`${RENDER_BASE_URL}/${functionName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ data }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || 'Request failed.');
  return body.result;
}
// ─────────────────────────────────────────────
// BUSINESSES
// ─────────────────────────────────────────────
export async function getBusinesses() {
  const snap = await getDocs(collection(db, "businesses"));
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

export async function getBusiness(businessId) {
  const snap = await getDoc(doc(db, "businesses", businessId));
  return snap.exists() ? { ...snap.data(), id: snap.id } : null;
}

export function subscribeToBusinesses(callback) {
  return onSnapshot(collection(db, "businesses"), snap => {
    callback(snap.docs.map(d => ({ ...d.data(), id: d.id })));
  });
}

// ─────────────────────────────────────────────
// MENUS
// ─────────────────────────────────────────────
export async function getMenu(businessId) {
  const catSnap = await getDocs(
    query(collection(db, "menus", businessId, "categories"), orderBy("sortOrder"))
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
        items: itemSnap.docs.map(d => ({ ...d.data(), id: d.id })).filter(i => i.isAvailable)
      };
    })
  );
  return sections;
}

// ─────────────────────────────────────────────
// ORDERS — Customer side
// ─────────────────────────────────────────────
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

export function subscribeToOrder(orderId, callback) {
  return onSnapshot(doc(db, "orders", orderId), snap => {
    if (snap.exists()) callback({ id: snap.id, ...snap.data() });
  });
}

/**
 * Get all orders for a customer by their UID.
 */
export async function getOrderHistory(customerId) {
  const q = query(
    collection(db, "orders"),
    where("customerId", "==", customerId),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─────────────────────────────────────────────
// ORDERS — Vendor dashboard side
// ─────────────────────────────────────────────
export function subscribeToVendorOrders(businessId, callback) {
  const q = query(
    collection(db, "orders"),
    where("businessId", "==", businessId),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function updateOrderStatus(orderId, status) {
  await updateDoc(doc(db, "orders", orderId), {
    status,
    updatedAt: serverTimestamp()
  });
}

// ─────────────────────────────────────────────
// CUSTOMER AUTH
// ─────────────────────────────────────────────

/**
 * Sign up customer with email + password.
 * Creates a user doc in /users/{uid} with name, phone, email, role.
 */
export async function customerSignUp(email, password, name, phone) {
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  await setDoc(doc(db, "users", user.uid), {
    name,
    phone,
    email,
    role: "customer",
    createdAt: serverTimestamp()
  });
  return user;
}

/**
 * Sign in customer with email + password.
 */
export async function customerSignIn(email, password) {
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  return user;
}

/**
 * Sign out current customer.
 */
export async function customerSignOut() {
  await signOut(auth);
}

/**
 * Send password reset email.
 */
export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

/**
 * Listen to customer auth state changes.
 */
export function onCustomerAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

/**
 * Get customer profile from Firestore.
 */
export async function getCustomerProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// ─────────────────────────────────────────────
// PHONE AUTH (OTP)
// ─────────────────────────────────────────────

/**
 * Set up invisible reCAPTCHA and send OTP to phone number.
 * containerId = id of a div in the DOM for reCAPTCHA to mount to.
 */
export async function sendOTP(phoneNumber, containerId) {
  const recaptcha = new RecaptchaVerifier(auth, containerId, { size: 'invisible' });
  const confirmation = await signInWithPhoneNumber(auth, phoneNumber, recaptcha);
  return confirmation; // call confirmation.confirm(otp) to verify
}

/**
 * After OTP verified, save profile if new user.
 */
export async function savePhoneProfile(uid, name, phone, email = null) {
  const existing = await getDoc(doc(db, "users", uid));
  if (!existing.exists()) {
    await setDoc(doc(db, "users", uid), {
      name,
      phone,
      email: email || null,
      role: "customer",
      createdAt: serverTimestamp()
    });
  }
}

// ─────────────────────────────────────────────
// CART PERSISTENCE
// ─────────────────────────────────────────────

/**
 * Save cart to Firestore under /carts/{uid}
 */
export async function saveCart(uid, cart, bizId, bizName) {
  await setDoc(doc(db, "carts", uid), {
    cart,
    bizId: bizId || null,
    bizName: bizName || null,
    updatedAt: serverTimestamp()
  });
}

/**
 * Load saved cart from Firestore.
 */
export async function loadCart(uid) {
  const snap = await getDoc(doc(db, "carts", uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * Clear cart from Firestore.
 */
export async function clearCart(uid) {
  await setDoc(doc(db, "carts", uid), {
    cart: [],
    bizId: null,
    bizName: null,
    updatedAt: serverTimestamp()
  });
}

// ─────────────────────────────────────────────
// ACTIVE ORDER PERSISTENCE
// ─────────────────────────────────────────────

/**
 * Save active order ID to customer profile so it
 * can be restored after refresh/login.
 */
export async function saveActiveOrder(uid, orderId) {
  await setDoc(doc(db, "users", uid), { activeOrderId: orderId }, { merge: true });
}
/**
 * Clear active order from customer profile.
 */
export async function clearActiveOrder(uid) {
  await setDoc(doc(db, "users", uid), { activeOrderId: null }, { merge: true });
}

/**
 * Get active order document if it exists and is not completed/rejected.
 */
export async function getActiveOrder(uid) {
  const profile = await getCustomerProfile(uid);
  if (!profile?.activeOrderId) return null;
  const snap = await getDoc(doc(db, "orders", profile.activeOrderId));
  if (!snap.exists()) return null;
  const order = { id: snap.id, ...snap.data() };
  // If order is in a final state, clear it
  if (['completed', 'rejected'].includes(order.status)) {
    await clearActiveOrder(uid);
    return null;
  }
  return order;
}

// ─────────────────────────────────────────────
// VENDOR AUTH (existing — unchanged)
// ─────────────────────────────────────────────
export async function signUp(email, password, name, role = "customer", businessId = null) {
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  await setDoc(doc(db, "users", user.uid), {
    name, email, role,
    ...(businessId && { businessId }),
    createdAt: serverTimestamp()
  });
  return user;
}

export async function signIn(email, password) {
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  return user;
}

export async function logOut() {
  await signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
