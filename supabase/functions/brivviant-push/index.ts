import {createClient} from 'npm:@supabase/supabase-js@2.116.0';
import webpush from 'npm:web-push@3.6.7';

const URL=Deno.env.get('SUPABASE_URL')!;
const SERVICE=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin=createClient(URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});
const headers={
  'Content-Type':'application/json',
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info,x-internal-secret',
  'Access-Control-Allow-Methods':'POST,OPTIONS'
};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});

async function getConfig(){
  let {data,error}=await admin.from('bv_push_config').select('*').eq('id',1).maybeSingle();
  if(error)throw error;
  if(!data?.vapid_public||!data?.vapid_private){
    const keys=webpush.generateVAPIDKeys();
    const update=await admin.from('bv_push_config').update({vapid_public:keys.publicKey,vapid_private:keys.privateKey,updated_at:new Date().toISOString()}).eq('id',1).select('*').single();
    if(update.error)throw update.error;
    data=update.data;
  }
  return data;
}

async function authenticatedUser(req:Request){
  const token=(req.headers.get('Authorization')||'').replace(/^Bearer /i,'');
  const {data:{user},error}=await admin.auth.getUser(token);
  if(error||!user)return null;
  const {data:profile}=await admin.from('bv_profiles').select('id,active,must_change').eq('id',user.id).maybeSingle();
  return profile?.active&&!profile.must_change?user:null;
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response(null,{headers});
  if(req.method!=='POST')return reply({error:'Method not allowed'},405);
  try{
    const body=await req.json().catch(()=>({})) as any;
    if(body.action==='dispatch'){
      const cfg=await getConfig();
      if((req.headers.get('x-internal-secret')||'')!==cfg.internal_secret)return reply({error:'Forbidden'},403);
      webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')||'mailto:notifications@brivviant-team.invalid',cfg.vapid_public,cfg.vapid_private);
      const {data:subs,error}=await admin.from('bv_push_subscriptions').select('*').eq('user_id',body.user_id).eq('active',true);
      if(error)throw error;
      const payload=JSON.stringify({title:String(body.title||'Brivviant Studio'),body:'لديك تحديث جديد في نظام Brivviant Studio',url:'./index.html',kind:body.kind||'notification',task_id:body.task_id||null,request_id:body.request_id||null,peer_id:body.peer_id||null});
      let sent=0;
      for(const sub of subs||[]){
        try{
          await webpush.sendNotification({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},payload,{TTL:3600});
          sent++;
        }catch(e:any){
          const status=Number(e?.statusCode||0);
          if(status===404||status===410)await admin.from('bv_push_subscriptions').update({active:false,updated_at:new Date().toISOString()}).eq('id',sub.id);
        }
      }
      return reply({ok:true,sent});
    }

    const user=await authenticatedUser(req);
    if(!user)return reply({error:'سجّل دخولك أولًا.'},401);
    if(body.action==='public_key'){
      const cfg=await getConfig();
      return reply({ok:true,public_key:cfg.vapid_public});
    }
    if(body.action==='subscribe'){
      const sub=body.subscription;
      if(!sub?.endpoint||!sub?.keys?.p256dh||!sub?.keys?.auth)return reply({error:'Push subscription غير صحيح.'},400);
      const row={user_id:user.id,endpoint:String(sub.endpoint),p256dh:String(sub.keys.p256dh),auth:String(sub.keys.auth),user_agent:String(body.user_agent||'').slice(0,500),active:true,updated_at:new Date().toISOString()};
      const {error}=await admin.from('bv_push_subscriptions').upsert(row,{onConflict:'user_id,endpoint'});
      if(error)throw error;
      return reply({ok:true});
    }
    if(body.action==='unsubscribe'){
      if(body.endpoint)await admin.from('bv_push_subscriptions').update({active:false,updated_at:new Date().toISOString()}).eq('user_id',user.id).eq('endpoint',String(body.endpoint));
      return reply({ok:true});
    }
    return reply({error:'Unknown action'},400);
  }catch(e){
    console.error(e);
    return reply({error:'تعذر تنفيذ Push Notification.'},500);
  }
});
