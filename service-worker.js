"use strict";

const CACHE_NAME = "dastarkhwan-static-v12";
const APP_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./admin.css",
  "./app.js",
  "./admin.js",
  "./menu-data.js",
  "./admin.html",
  "./privacy.html",
  "./manifest.webmanifest",
  "./app-icon.png",
  "./app-icon-maskable.png",
  "./images/pakistani-feast.jpg",
  "./images/menu/chicken-karahi.jpg",
  "./images/menu/chicken-tikka.jpg",
  "./images/menu/malai-boti.jpg",
  "./images/menu/chapli-kabab.jpg",
  "./images/menu/mutton-pulao.jpg",
  "./images/menu/chicken-biryani.jpg",
  "./images/menu/beef-seekh-kabab.jpg",
  "./images/menu/indian-thali.jpg",
  "./images/menu/restaurant-interior.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("dastarkhwan-static-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname === "/api/menu") {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const copy = response.clone();
            await (await caches.open(CACHE_NAME)).put(request, copy);
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          return new Response(JSON.stringify({ error: "The menu is not available offline." }), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        })
    );
    return;
  }

  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/uploads/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
