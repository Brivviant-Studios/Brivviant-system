import {createClient} from 'npm:@supabase/supabase-js@2.116.0';
const URL=Deno.env.get('SUPABASE_URL')!;
const admin=createClient(URL,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
const email=(u:string)=>`${u}@brivviant-team.invalid`;
const validPassword=(p:unknown)=>typeof p==='string'&&p.length>=6&&p.length<=128;
const DEFAULT_PASSWORD='123456';
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response(null,{headers});
 if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 try{
  const b=await req.json() as Record<string,any>;
  const token=(req.headers.get('Authorization')||'').replace(/^Bearer /i,'');
  const {data:{user},error:authError}=await admin.auth.getUser(token);
  if(authError||!user)return reply({error:'سجّل دخولك أولًا.'},401);
  const {data:me}=await admin.from('bv_profiles').select('*').eq('id',user.id).maybeSingle();
  if(!me?.active)return reply({error:'الحساب غير متاح.'},403);

  if(b.action==='change_password'){
   if(!validPassword(b.password))return reply({error:'كلمة المرور لازم تكون من 6 إلى 128 حرفًا.'},400);
   const verifier=createClient(URL,Deno.env.get('SUPABASE_ANON_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
   const {error:ve}=await verifier.auth.signInWithPassword({email:user.email!,password:String(b.current_password||'')});
   if(ve)return reply({error:'كلمة المرور الحالية غير صحيحة.'},400);
   await verifier.auth.signOut();
   const {error}=await admin.auth.admin.updateUserById(user.id,{password:b.password});if(error)throw error;
   const {error:pe}=await admin.from('bv_profiles').update({must_change:false}).eq('id',user.id);if(pe)throw pe;
   return reply({ok:true});
  }

  if(!['ceo','team_leader'].includes(me.role))return reply({error:'إدارة الحسابات للإدارة فقط.'},403);

  if(b.action==='create_user'){
   if(!/^[a-z0-9.]{3,40}$/.test(b.username)||!String(b.name||'').trim()||!['ceo','team_leader','coordinator','employee'].includes(b.role))
    return reply({error:'راجع الاسم واسم المستخدم والصلاحية.'},400);
   const {data,error}=await admin.auth.admin.createUser({email:email(b.username),password:DEFAULT_PASSWORD,email_confirm:true,app_metadata:{workspace:'brivviant'}});
   if(error)return reply({error:'اسم المستخدم موجود بالفعل أو البيانات غير صحيحة.'},400);
   const {error:pe}=await admin.from('bv_profiles').insert({id:data.user.id,username:b.username,name:String(b.name).slice(0,100),role:b.role,must_change:false});
   if(pe){await admin.auth.admin.deleteUser(data.user.id);throw pe;}
   return reply({ok:true,default_password:DEFAULT_PASSWORD});
  }

  if(b.action==='bulk_reset_default'){
   const {data:profiles,error:pe}=await admin.from('bv_profiles').select('id,username').eq('active',true);
   if(pe)throw pe;
   const results=[];
   for(const p of profiles||[]){
    const {error}=await admin.auth.admin.updateUserById(p.id,{password:DEFAULT_PASSWORD});
    results.push({username:p.username,ok:!error});
    if(error)throw error;
   }
   await admin.from('bv_profiles').update({must_change:false}).in('id',(profiles||[]).map((p:any)=>p.id));
   return reply({ok:true,default_password:DEFAULT_PASSWORD,results});
  }

  const {data:target}=await admin.from('bv_profiles').select('*').eq('id',b.user_id).maybeSingle();
  if(!target)return reply({error:'الحساب غير موجود.'},404);

  if(b.action==='reset_password'){
   if(target.id===user.id)return reply({error:'استخدم تغيير كلمة مروري لحسابك.'},400);
   const {error}=await admin.auth.admin.updateUserById(target.id,{password:DEFAULT_PASSWORD});if(error)throw error;
   const {error:pe}=await admin.from('bv_profiles').update({must_change:false}).eq('id',target.id);if(pe)throw pe;
   return reply({ok:true,default_password:DEFAULT_PASSWORD});
  }

  if(b.action==='update_user'){
   if(!['ceo','team_leader','coordinator','employee'].includes(b.role)||typeof b.active!=='boolean'||!String(b.name||'').trim())
    return reply({error:'راجع بيانات الحساب.'},400);
   if(target.id===user.id&&(!['ceo','team_leader'].includes(b.role)||!b.active))
    return reply({error:'لا يمكن تعطيل حسابك الإداري أو إزالة صلاحياتك بنفسك.'},400);
   const {error}=await admin.from('bv_profiles').update({name:String(b.name).slice(0,100),role:b.role,active:b.active}).eq('id',target.id);if(error)throw error;
   return reply({ok:true});
  }
  return reply({error:'إجراء غير معروف.'},400);
 }catch(e){
  console.error('Account action failed:',e instanceof Error?e.message:'unknown');
  return reply({error:'تعذر تنفيذ الإجراء. راجع البيانات وحاول تاني.'},400);
 }
});