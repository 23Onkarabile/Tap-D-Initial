// firebase.config.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCkW2q9vcHp0P6SnKO9KdSLRwZAx94Ox8Y",
  authDomain: "grub-app-database.firebaseapp.com",
  projectId: "grub-app-database",
  storageBucket: "grub-app-database.firebasestorage.app",
  messagingSenderId: "887035111030",
  appId: "1:887035111030:web:78e2880f284ff4e2c6e157"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);