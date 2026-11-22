// GetPDF360 service worker: makes the site installable as an app.
// It deliberately caches nothing, so files and pages are never stored by it.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
