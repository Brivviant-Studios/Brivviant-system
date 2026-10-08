import {createClient} from 'npm:@supabase/supabase-js@2.116.0';

const URL=Deno.env.get('SUPABASE_URL')!;
const publishableKeys=(()=>{try{return JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')||'{}') as Record<string,string>;}catch{return {};}})();
const PUBLIC_KEY=publishableKeys.default||Deno.env.get('SUPABASE_ANON_KEY')||'';
const SERVICE=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GEMINI_API_KEY=Deno.env.get('GEMINI_API_KEY')||'';
const DEFAULT_TEST_DRIVE='https://drive.google.com/drive/folders/TEST';

// Only general Gemini models that accept audio input and have a documented Free Tier.
// Override without redeploying by setting GEMINI_VOICE_MODELS as a comma-separated list.
const DEFAULT_MODELS=['gemini-2.5-flash','gemini-2.5-flash-lite'];
const MODEL_POOL=(Deno.env.get('GEMINI_VOICE_MODELS')||'')
  .split(',').map(x=>x.trim()).filter(Boolean);
const MODELS=MODEL_POOL.length?MODEL_POOL:DEFAULT_MODELS;

// A warm Edge Function isolate remembers temporarily exhausted/unavailable models.
// This reduces repeated 429/5xx calls while still allowing them again later.
const modelCooldownUntil=new Map<string,number>();
const QUOTA_COOLDOWN_MS=5*60*1000;
const TRANSIENT_COOLDOWN_MS=60*1000;

const admin=createClient(URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});
const headers={
  'Content-Type':'application/json',
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info',
  'Access-Control-Allow-Methods':'POST,OPTIONS',
};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});

function toBase64(bytes:Uint8Array){
  let binary='';
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
  return btoa(binary);
}

function rotateModels(models:string[]){
  if(models.length<=1)return [...models];
  const seed=new Uint32Array(1);crypto.getRandomValues(seed);
  const start=seed[0]%models.length;
  return [...models.slice(start),...models.slice(0,start)];
}

function modelErrorMessage(payload:any){
  return String(payload?.error?.message||payload?.message||'').slice(0,500);
}

function putOnCooldown(model:string,status:number){
  if(status===429)modelCooldownUntil.set(model,Date.now()+QUOTA_COOLDOWN_MS);
  else if(status===404||status===503||status>=500)modelCooldownUntil.set(model,Date.now()+TRANSIENT_COOLDOWN_MS);
}

function manualFallback(reason:string,attemptedModels:string[],driveUrl:string){
  return reply({
    ok:false,
    fallback_manual:true,
    reason,
    attempted_models:attemptedModels,
    drive_url:driveUrl,
    message:'التحليل الصوتي غير متاح حاليًا. تم تحويلك للطريقة العادية لإضافة التاسك يدويًا بدون تعطيل النظام.',
  });
}

const outputSchema={
  type:'object',
  properties:{
    title:{type:'string'},
    brief:{type:'string'},
    due_at:{type:'string'},
    assignee_ids:{type:'array',items:{type:'string'}},
    drive_url:{type:['string','null']},
    transcript:{type:'string'}
  },
  required:['title','brief','due_at','assignee_ids','drive_url','transcript']
};

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS') return new Response(null,{headers});
  if(req.method!=='POST') return reply({error:'Method not allowed'},405);
  try{
    const token=(req.headers.get('Authorization')||'').replace(/^Bearer /i,'');
    const {data:{user},error:authError}=await admin.auth.getUser(token);
    if(authError||!user) return reply({error:'سجّل دخولك أولًا.'},401);

    const {data:me,error:meError}=await admin.from('bv_profiles').select('id,name,username,role,active,must_change').eq('id',user.id).maybeSingle();
    if(meError||!me?.active||me.must_change) return reply({error:'الحساب غير متاح لتنفيذ الأمر الصوتي.'},403);
    if(!['ceo','team_leader'].includes(me.role)) return reply({error:'إضافة التاسك بالصوت متاحة للإدارة والـTeam Leader فقط.'},403);

    const form=await req.formData();
    const audio=form.get('audio');
    if(!(audio instanceof File)) return reply({error:'التسجيل الصوتي غير موجود.'},400);
    if(audio.size===0) return reply({error:'التسجيل الصوتي فارغ.'},400);
    if(audio.size>15*1024*1024) return reply({error:'التسجيل طويل جدًا. سجّل أمرًا أقصر.'},413);
    const suppliedDrive=String(form.get('drive_url')||'').trim();
    if(suppliedDrive && !/^https:\/\/(drive|docs)\.google\.com\//.test(suppliedDrive)) return reply({error:'لينك Google Drive غير صحيح.'},400);

    // Missing key is not a system outage: gracefully fall back to the normal task form.
    if(!GEMINI_API_KEY) return manualFallback('missing_api_key',[],suppliedDrive);

    const {data:profiles,error:profilesError}=await admin.from('bv_profiles').select('id,name,username,role').eq('active',true).order('name');
    if(profilesError) throw profilesError;
    const team=(profiles||[]).map(p=>({id:p.id,name:p.name,username:p.username,role:p.role}));

    const bytes=new Uint8Array(await audio.arrayBuffer());
    const base64=toBase64(bytes);
    const now=new Date();
    const prompt=`
أنت parser أوامر صوتية لنظام Brivviant Studio. التسجيل غالبًا بالعربية المصرية وقد يحتوي كلمات إنجليزية.
استخرج تاسك واحد فقط بدقة. التاريخ الحالي ${now.toISOString()} والمنطقة الزمنية الأساسية Africa/Cairo.

قواعد صارمة:
- title: اسم التاسك نفسه فقط.
- brief: وصف مختصر واضح؛ إذا لم يذكر وصف منفصل استخدم معنى اسم التاسك.
- due_at: ISO-8601 كامل مع timezone/offset ويجب أن يكون موعدًا مستقبليًا حسب كلام المستخدم.
- assignee_ids: اختر IDs فقط من قائمة الفريق بالأسفل. طابق الاسم المنطوق مع أقرب اسم حقيقي. لا تختر شخصًا غير مذكور.
- drive_url: أخرج لينك Google Drive فقط إذا نُطق بوضوح؛ غير ذلك null.
- transcript: تفريغ مختصر ودقيق للأمر الصوتي.
- إذا لم تستطع تحديد اسم المصمم أو الموعد، اجعل الحقل المقابل فارغًا بدل التخمين.

قائمة الفريق:
${JSON.stringify(team)}
`;

    const ordered=rotateModels(MODELS);
    const attempted:string[]=[];
    let parsed:any=null;
    let usedModel='';
    let lastFailure='all_models_unavailable';

    // First pass: skip models still cooling down. If all are cooling down, second pass tries them anyway
    // so a stale warm-isolate cooldown can never block recovery.
    const available=ordered.filter(m=>(modelCooldownUntil.get(m)||0)<=Date.now());
    const candidates=available.length?available:ordered;

    for(const model of candidates){
      attempted.push(model);
      try{
        const geminiRes=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{
          method:'POST',
          headers:{'Content-Type':'application/json','x-goog-api-key':GEMINI_API_KEY},
          body:JSON.stringify({
            contents:[{parts:[
              {text:prompt},
              {inlineData:{mimeType:audio.type||'audio/webm',data:base64}},
              {text:'حلّل التسجيل الآن وأعد JSON فقط حسب الـschema.'}
            ]}],
            generationConfig:{
              temperature:0.1,
              responseMimeType:'application/json',\n              responseSchema:outputSchema
            }
          })
        });
        const geminiJson=await geminiRes.json().catch(()=>null) as any;
        if(!geminiRes.ok){
          putOnCooldown(model,geminiRes.status);
          lastFailure=geminiRes.status===429?'quota_exhausted':geminiRes.status===404?'model_unavailable':`http_${geminiRes.status}`;
          console.warn('Gemini model failed',model,geminiRes.status,modelErrorMessage(geminiJson));
          // Invalid key/authorization is shared by the whole pool; no reason to burn calls to every model.
          if(geminiRes.status===401)break;
          continue;
        }
        const text=(geminiJson?.candidates?.[0]?.content?.parts||[]).map((p:any)=>p?.text||'').join('').trim();
        let candidate:any;
        try{candidate=JSON.parse(text);}catch{
          lastFailure='invalid_json';
          console.warn('Gemini invalid JSON',model,text.slice(0,700));
          continue;
        }

        const title=String(candidate.title||'').trim();
        const dueAt=new Date(String(candidate.due_at||''));
        const allowedIds=new Set(team.map(p=>p.id));
        const assigneeIds=[...new Set((Array.isArray(candidate.assignee_ids)?candidate.assignee_ids:[]).map(String).filter((id:string)=>allowedIds.has(id)))];
        if(!title||!Number.isFinite(dueAt.getTime())||dueAt.getTime()<=Date.now()||!assigneeIds.length){
          lastFailure='incomplete_parse';
          console.warn('Gemini incomplete parse',model,{hasTitle:!!title,validDue:Number.isFinite(dueAt.getTime())&&dueAt.getTime()>Date.now(),assignees:assigneeIds.length});
          continue;
        }
        parsed={...candidate,title,dueAt,assigneeIds};
        usedModel=model;
        modelCooldownUntil.delete(model);
        break;
      }catch(e){
        modelCooldownUntil.set(model,Date.now()+TRANSIENT_COOLDOWN_MS);
        lastFailure='network_or_runtime_error';
        console.warn('Gemini request exception',model,e instanceof Error?e.message:'unknown');
      }
    }

    if(!parsed){
      return manualFallback(lastFailure,attempted,suppliedDrive);
    }

    const title=parsed.title as string;
    const brief=String(parsed.brief||title).trim()||title;
    const dueAt=parsed.dueAt as Date;
    const assigneeIds=parsed.assigneeIds as string[];
    const parsedDrive=String(parsed.drive_url||'').trim();
    const driveUrl=suppliedDrive || (/^https:\/\/(drive|docs)\.google\.com\//.test(parsedDrive)?parsedDrive:DEFAULT_TEST_DRIVE);

    if(!PUBLIC_KEY) throw new Error('Supabase publishable key is unavailable');
    const authed=createClient(URL,PUBLIC_KEY,{
      auth:{persistSession:false,autoRefreshToken:false},
      global:{headers:{Authorization:`Bearer ${token}`}}
    });
    const {data:created,error:createError}=await authed.rpc('bv_action',{p_action:'create_task',p:{title,brief,drive_url:driveUrl,due_at:dueAt.toISOString()}});
    if(createError||!created?.id) throw createError||new Error('Task create failed');
    const taskId=created.id as string;

    const {error:assignError}=await authed.rpc('bv_action',{p_action:'assign',p:{task_id:taskId,version:1,user_ids:assigneeIds}});
    if(assignError){
      console.error('Voice assign failed',assignError.message);
      return reply({
        ok:true,task_id:taskId,title,brief,due_at:dueAt.toISOString(),drive_url:driveUrl,assignee_ids:[],
        transcript:String(parsed.transcript||''),warning:'تم إنشاء التاسك، لكن توزيعه فشل. افتح التاسك ووزعه يدويًا. '+String(assignError.message||'').slice(0,140),
        model_used:usedModel,attempted_models:attempted,used_default_drive:driveUrl===DEFAULT_TEST_DRIVE
      },207);
    }

    return reply({
      ok:true,
      task_id:taskId,
      title,
      brief,
      due_at:dueAt.toISOString(),
      drive_url:driveUrl,
      assignee_ids:assigneeIds,
      assignees:team.filter(p=>assigneeIds.includes(p.id)).map(p=>p.name),
      transcript:String(parsed.transcript||''),
      used_default_drive:driveUrl===DEFAULT_TEST_DRIVE,
      model_used:usedModel,
      attempted_models:attempted,
    });
  }catch(e){
    console.error('Voice task failed:',e instanceof Error?e.message:'unknown');
    // Infrastructure/database errors are different from model exhaustion and should be surfaced.
    return reply({error:'تعذر إنشاء التاسك من التسجيل بسبب خطأ في النظام. استخدم إضافة تاسك العادية وحاول الصوت لاحقًا.'},500);
  }
});
