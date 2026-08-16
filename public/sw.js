const CACHE = 'hliq-v2-assets-v12'

// ─── PUSH NOTIFICATIONS ───────────────────────────────────────────────────────

self.addEventListener('push', event => {
  const data = event.data?.json?.() ?? {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Insolvent Trade', {
      body:  data.body  || '',
      tag:   data.tag   || 'hliq-notif',
      icon:  '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      // Action buttons show on Android/desktop; iOS ignores them
      actions: [{ action: 'mute-24h', title: '🔕 Mute 24h' }],
    })
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  if (event.action === 'mute-24h') {
    event.waitUntil(
      self.registration.pushManager.getSubscription().then(sub => {
        if (!sub) return
        return fetch('/notify/mute', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ endpoint: sub.endpoint, minutes: 1440 }),
        })
      }).catch(() => {})
    )
    return
  }
  event.waitUntil(clients.openWindow('/'))
})

// Cache-first for Vite hashed assets (/assets/*) — safe to cache forever
// because the hash changes whenever the content changes.
self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)

  // Never intercept non-GET requests or API calls
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return

  // Coin icons: let the browser HTTP-cache handle them normally (they carry a 1-day max-age),
  // so re-renders and scrolling serve instantly from cache with no flicker. Corrections still
  // reach users because the client bumps the icon URL version (?v=) when the logic changes,
  // which is a brand-new URL the cache has never seen. (An earlier cache:'reload' here forced
  // a network fetch on every render — that's what made icons re-flicker.)

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached
          return fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone())
            return response
          }).catch(() => cached ?? Response.error())
        })
      )
    )
    return
  }

  // Everything else: network, fall back to cache if offline
  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(request)
      return cached ?? Response.error()
    })
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      // Delete old asset caches
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
      ),
      // Take control of all open tabs immediately
      clients.claim(),
    ])
  )
})

self.addEventListener('install', () => self.skipWaiting())
