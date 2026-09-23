// Retire older service workers. The current app always uses the network.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 await self.clients.claim();
 await self.registration.unregister();
})()));
