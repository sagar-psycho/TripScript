/*
  TripSplit Firebase Core
  File: js/firebase.js

  Architecture Decision:
  Firebase is initialized in one central module only.
  All other files must import auth, db, and storage from this file.
  This prevents duplicate Firebase app instances and keeps configuration maintainable.
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";

import {
  getAuth,
  browserLocalPersistence,
  setPersistence
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  getFirestore
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  getStorage
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

/*
  Replace these values with your Firebase project configuration.

  Firebase Console:
  Project Settings → General → Your apps → Web app config
*/
 const firebaseConfig = {
    apiKey: "AIzaSyDX-Kiy3wW6tQo5rz6fI11F98xYenPtKEA",
    authDomain: "tripsplit-2658e.firebaseapp.com",
    projectId: "tripsplit-2658e",
    storageBucket: "tripsplit-2658e.firebasestorage.app",
    messagingSenderId: "130857688105",
    appId: "1:130857688105:web:bbccc893ae673f2b185038"
  };
// Ini
const app = initializeApp(firebaseConfig);

const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

/*
  Architecture Decision:
  browserLocalPersistence keeps the user logged in after refresh.
  Protected route logic will still verify authentication state before loading pages.
*/
setPersistence(auth, browserLocalPersistence).catch((error) => {
  console.error("Firebase auth persistence error:", error);
});

export { app, auth, db, storage };