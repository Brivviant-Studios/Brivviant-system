import {createClient} from 'npm:@supabase/supabase-js@2.116.0';

const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};
const respond=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
const url=Deno.env.get('SUPABASE_URL')||'';
const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const apiKey=Deno.env.get('GEMINI_API_KEY')||'';
const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
type InputTask={id:string;title:string;hours:number;deadline?:string;priority?:string;brief?:string;proposals?:number;stages?:{name:string;hours:number}[]};
const safe=(v:unknown,n=250)=>String(v??'').trim().slice(0,n);

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{headers});
 if(req.method!=='POST')return respond({error:'Method not allowed'},405);
 try{
  const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
  if(!token)return respond({error:'Authentication required'},401);
  const {data:{user},error:authError}=await admin.auth.getUser(token);
  if(authError||!user)return respond({error:'Authentication required'},401);
  const {data:profile,error:profileError}=await admin.from('bv_profiles').select('role,active,must_change').eq('id',user.id).maybeSingle();
  if(profileError||!profile?.active||profile.must_change||profile.role!=='team_leader')return respond({error:'هذه الأداة مخصصة للـ Team Leader فقط.'},403);
  const body=await req.json().catch(()=>null);
  if(!body||!Array.isArray(body.tasks))return respond({error:'Missing tasks'},400);
  const tasks:InputTask[]=body.tasks.slice(0,60).map((t:any)=>({
    id:safe(t.id,60),title:safe(t.title,160),hours:Number(t.hours),deadline:safe(t.deadline,16),priority:['high','normal','low'].includes(t.priority)?t.priority:'normal',brief:safe(t.brief,3000),proposals:Math.max(1,Math.min(20,Number(t.proposals)||1))
  })).filter((t:InputTask)=>t.id&&t.title&&Number.isFinite(t.hours)&&t.hours>0&&t.hours<=500);
  if(!tasks.length)return respond({error:'أضف مهمة واحدة بمدة صحيحة على الأقل.'},400);
  if(!apiKey)return respond({error:'GEMINI_API_KEY غير مضبوط في Supabase Secrets.'},503);
  const hoursPerDay=Math.max(1,Math.min(16,Number(body.hoursPerDay)||8));
  const workDays=Array.isArray(body.workDays)?body.workDays.filter((n:unknown)=>Number.isInteger(n)&&Number(n)>=0&&Number(n)<=6).slice(0,7):[0,1,2,3,4];
  const startDate=/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)?body.startDate:new Date().toISOString().slice(0,10);
  const message=safe(body.message,2000);
  const context={startDate,hoursPerDay,workDays,tasks,message,timezone:'Africa/Cairo'};
  const instruction=`You are an Arabic-speaking professional production scheduling assistant for Brivviant Studio. Return ONLY a JSON object with keys "reply" (Arabic helpful answer), "days" (array of {date:"YYYY-MM-DD",hours:number,load:"light"|"balanced"|"busy"|"overloaded",items:[{taskId:string,title:string,hours:number}]}), "deliveries" (array of {taskId:string,date:"YYYY-MM-DD",risk:"low"|"medium"|"high"}), "warnings" (array of Arabic strings). Produce a realistic finite schedule, not a vague essay. Respect working weekdays as JS indexes (Sunday=0), daily work capacity, start date, priorities, and task deadlines. For exhibitions and booths, always examine the project brief. If brief is missing, ask concise specific questions about booth dimensions, required deliverables, proposal count, identity constraints and revision expectations. Treat proposals as separate concept and layout production stages, not one job. Give an actionable daily next step. Split long tasks into days. Include all tasks exactly for their entered effort, do not invent new task IDs or claim impossible deadlines can be met. If overload is unavoidable, report it clearly. Reply in conversational Egyptian Arabic and answer the user's message; update the proposed schedule if they ask to change priorities. The schedule is a suggestion only, not an actual assignment or saved task. Work in timezone Africa/Cairo. Do not schedule before startDate. Max 90 calendar days; if tasks exceed capacity within that horizon, explain remaining workload in warnings. Respond with valid JSON only.`;
  const models=(Deno.env.get('GEMINI_PLANNER_MODELS')||'gemini-2.5-flash,gemini-2.5-flash-lite').split(',').map(x=>x.trim()).filter(Boolean);
  let reason='Gemini unavailable';
  for(const model of models){
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);
   try{
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{
     method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},
     body:JSON.stringify({systemInstruction:{parts:[{text:instruction}]},contents:[{role:'user',parts:[{text:JSON.stringify(context)}]}],generationConfig:{temperature:0.2,responseMimeType:'application/json'}})
    });
    const raw=await response.json();
    if(!response.ok){reason=String(raw?.error?.message||response.status).slice(0,180);continue;}
    const txt=raw?.candidates?.[0]?.content?.parts?.map((p:any)=>p.text||'').join('')||'';
    const result=JSON.parse(txt);
    if(!result||!Array.isArray(result.days)||!Array.isArray(result.deliveries)||typeof result.reply!=='string')throw new Error('Unexpected Gemini response');
    const ids=new Set(tasks.map(t=>t.id));
    const days=result.days.slice(0,90).filter((d:any)=>/^\d{4}-\d{2}-\d{2}$/.test(d?.date)).map((d:any)=>({
     date:d.date,hours:Number(d.hours)||0,load:['light','balanced','busy','overloaded'].includes(d.load)?d.load:'balanced',
     items:(Array.isArray(d.items)?d.items:[]).filter((i:any)=>ids.has(i.taskId)&&Number(i.hours)>0).map((i:any)=>({taskId:i.taskId,title:safe(i.title,160),hours:Number(i.hours)}))
    }));
    const deliveries=result.deliveries.filter((d:any)=>ids.has(d.taskId)&&/^\d{4}-\d{2}-\d{2}$/.test(d.date)).map((d:any)=>({taskId:d.taskId,date:d.date,risk:['low','medium','high'].includes(d.risk)?d.risk:'medium'}));
    return respond({reply:safe(result.reply,5000),days,deliveries,warnings:Array.isArray(result.warnings)?result.warnings.map((w:unknown)=>safe(w,300)).slice(0,15):[],model});
   }catch(e){reason=e instanceof Error?e.message:'Gemini failed';}
   finally{clearTimeout(timer);}
  }
  return respond({error:'تعذر إنشاء الخطة حاليًا: '+reason},503);
 }catch(e){return respond({error:e instanceof Error?e.message:'Server error'},500);}
});
