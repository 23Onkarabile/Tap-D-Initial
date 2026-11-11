// profile.js: saves a customer's name and/or phone on their profile.
// Kept in its own file so firebase.service.js does not need to change.
import { db } from "./firebase.config.js";
import { doc, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Only the fields passed in are written (Account details sends name, Contact details sends phone).
// merge:true keeps everything else on the profile (cart, active order, notification devices).
// Firestore rules already allow users to edit their own profile document.
export async function saveProfile(uid, fields) {
  const data = {};
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.phone !== undefined) data.phone = fields.phone;
  await setDoc(doc(db, "users", uid), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}
