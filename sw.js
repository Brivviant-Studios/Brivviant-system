self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch{data={title:'Brivviant Studio',body:event.data?.text()||'لديك تحديث جديد'}}
  const title=data.title||'Brivviant Studio';
  const options={body:data.body||'لديك تحديث جديد في نظام Brivviant Studio',icon:'./pwa-192.png',badge:'./pwa-192.png',tag:'brivviant-'+(data.kind||'notification')+'-'+(data.task_id||data.request_id||Date.now()),renotify:true,data:{url:data.url||'./index.html',task_id:data.task_id||null,request_id:data.request_id||null,peer_id:data.peer_id||null}};
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url||'./index.html',self.location.origin).href;
  event.waitUntil((async()=>{const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const c of clients){if('focus'in c){await c.focus();if('navigate'in c)await c.navigate(target);return;}}if(self.clients.openWindow)return self.clients.openWindow(target);})());
});
