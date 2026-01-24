// FUNDVISA - Firebase init (Modular SDK v10)
// Cargar como ES Module: <script type="module" src="js/firebase.js"></script>

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

export const firebaseConfig = {
  apiKey: "AIzaSyAo5W10MQ6C-iEKB7hdmJF65CjMTuEkpRQ",
  authDomain: "fundvisa-d18de.firebaseapp.com",
  projectId: "fundvisa-d18de",
  storageBucket: "fundvisa-d18de.firebasestorage.app",
  messagingSenderId: "217607050138",
  appId: "1:217607050138:web:eb961a59d4e5c49352e023",
  measurementId: "G-33QSX7K03M"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
