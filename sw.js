const CACHE='tripsplit-v1';
const ASSETS=['index.html','login.html','register.html','forgot.html','dashboard.html','trips.html','expenses.html','settlements.html','reports.html','settings.html','css/style.css','css/dashboard.css','js/storage.js','js/utils.js','js/auth.js','js/app.js','js/trip.js','js/expense.js','js/settlement.js','js/report.js','js/components.js','components/sidebar.html','components/topbar.html'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));
