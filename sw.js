'use strict';
var CACHE = 'jarvis-command-v6';
var ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './app.js',
  './combined-app.js',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './sound/granted.mp3',
  './sound/scan.mp3',
  './sound/sent.mp3'
];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(ASSETS);
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Handle Web Share Target POST requests
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // Share target: receive shared files via POST
  if (e.request.method === 'POST' && url.pathname === url.pathname.replace(/[^/]*$/, 'index.html')) {
    e.respondWith(
      e.request.formData().then(function (formData) {
        var files = formData.getAll('shared-files');
        if (!files || files.length === 0) {
          return Response.redirect('./index.html', 303);
        }
        // Store files in a temporary cache for the app to pick up
        return caches.open('jarvis-shared-files').then(function (cache) {
          var promises = files.map(function (file, i) {
            var name = file.name || ('shared-file-' + i);
            var headers = new Headers();
            headers.set('Content-Type', file.type || 'application/octet-stream');
            headers.set('X-File-Name', name);
            headers.set('X-File-Size', file.size);
            return file.arrayBuffer().then(function (buf) {
              return cache.put(
                new Request('./shared/' + name),
                new Response(buf, { headers: headers })
              );
            });
          });
          return Promise.all(promises).then(function () {
            // Notify all open clients about the shared files
            return self.clients.matchAll().then(function (clients) {
              clients.forEach(function (client) {
                client.postMessage({
                  type: 'shared-files',
                  count: files.length,
                  names: files.map(function (f) { return f.name; })
                });
              });
              return Response.redirect('./index.html?shared=' + files.length, 303);
            });
          });
        });
      }).catch(function () {
        return Response.redirect('./index.html', 303);
      })
    );
    return;
  }

  // Normal GET requests: cache-first
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () { return hit || new Response('Offline', { status: 503 }); });
    })
  );
});
