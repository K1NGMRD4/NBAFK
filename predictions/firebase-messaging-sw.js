/* Servisni delavec za push obvestila (Firebase Cloud Messaging).
   Obvestila z "notification" delom prikaže FCM sam; ob kliku odpre stran iz fcmOptions.link. */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA0G7hCz9j3oMMACvT6LWbK8r4tJoLKhQg",
  authDomain: "nbafk-predictions.firebaseapp.com",
  projectId: "nbafk-predictions",
  storageBucket: "nbafk-predictions.firebasestorage.app",
  messagingSenderId: "512474489804",
  appId: "1:512474489804:web:ef1527cb520ac97f053369"
});

firebase.messaging();

self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
