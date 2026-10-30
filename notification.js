// notifications.js: lets a customer turn on "your order is ready" push alerts.
// Kept separate from firebase.service.js so that file does not need to change.
import { db } from "./firebase.config.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getMessaging, getToken, isSupported }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";
import { doc, setDoc, arrayUnion }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Public key from Firebase Console > Project settings > Cloud Messaging > Web Push certificates.
// Paste yours between the quotes (it is safe to keep in the code: it is meant to be public).
export const VAPID_KEY = "PASTE_YOUR_VAPID_PUBLIC_KEY_HERE";

// Asks permission, gets this phone's token, and saves it on the customer's profile
// so the server knows where to send the "ready" alert.
export async function enableOrderNotifications(uid) {
  if (VAPID_KEY.startsWith("PASTE")) throw new Error("Notifications are not set up yet.");
  if (!(await isSupported())) throw new Error("This browser can't receive notifications.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications are blocked. Allow them in your browser settings and try again.");
  }

  // The service worker is what shows the alert when the app is closed
  const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  const token = await getToken(getMessaging(getApp()), {
    vapidKey: VAPID_KEY,
    serviceWorkerRegistration: registration,
  });
  if (!token) throw new Error("Couldn't turn on notifications. Please try again.");

  // arrayUnion = add this phone without duplicating or removing the customer's other devices
  await setDoc(doc(db, "users", uid), { fcmTokens: arrayUnion(token) }, { merge: true });
  return token;
}
