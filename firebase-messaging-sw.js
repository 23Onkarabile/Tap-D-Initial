// firebase-messaging-sw.js: runs in the background and shows the "order ready" alert
// even when TapDish is closed. Must sit in the site ROOT (next to index.html).
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

// Same public web config as firebase.config.js
firebase.initializeApp({
  apiKey: "AIzaSyCkW2q9vcHp0P6SnKO9KdSLRwZAx94Ox8Y",
  authDomain: "grub-app-database.firebaseapp.com",
  projectId: "grub-app-database",
  storageBucket: "grub-app-database.firebasestorage.app",
  messagingSenderId: "887035111030",
  appId: "1:887035111030:web:78e2880f284ff4e2c6e157"
});

// Starting messaging is enough: the server sends a ready-made notification (title + text),
// the browser shows it, and tapping it opens the link the server attached.
firebase.messaging();
