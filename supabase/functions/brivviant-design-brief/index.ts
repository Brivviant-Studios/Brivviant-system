import {createClient} from 'npm:@supabase/supabase-js@2.116.0';
const url=Deno.env.get('SUPABASE_URL')||'',service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',key=Deno.env.get('GEMINI_API_KEY')||'';
const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};
const reply=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{headers});
 if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 try{
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 const {data:{user},error}=await admin.auth.getUser(token);
 if(error||!user)return reply({error:'يرجى تسجيل الدخول.'},401);
 const {data:p}=await admin.from('bv_profiles').select('role,active,must_change').eq('id',user.id).maybeSingle();
 if(!p?.active||p.must_change)return reply({error:'حساب غير مصرح.'},403);
 const b=await req.json(); const pdf=typeof b.pdfBase64==='string'?b.pdfBase64:'';const text=String(b.text||'').trim().slice(0,65000);
 if(!pdf&&!text)return reply({error:'ارفع PDF أو أدخل نص كراسة الشروط.'},400);
 if(pdf&&(pdf.length>14_000_000||!/^[A-Za-z0-9+/=]+$/.test(pdf)))return reply({error:'ملف PDF غير صالح أو حجمه أكبر من 10MB.'},400);
 if(!key)return reply({error:'Gemini API غير مضبوط على السيرفر.'},503);
 const prompt=`أنت محلل كراسات شروط متخصص في تصميم الأجنحة والمعارض والفعاليات لدى استوديو تصميم ثلاثي الأبعاد. حلل المصدر المعطى باللغة العربية، واستخرج **المعلومات التي يحتاجها المصمم ثلاثي الأبعاد فقط** وليس الشروط المالية أو القانونية أو الإدارية. حدد النوع event أو pavilion أو mixed. استخرج قائمة تفصيلية شاملة بالعناصر والأركان والأنشطة والمناطق والمراحل المطلوبة بصرياً، بما فيها الشاشات والمجسمات والبوابات والاستقبال والمسرح ومساحات الجمهور، وعدد كل عنصر ووصفه وموقعه وأبعاد طول×عرض×ارتفاع أو قطر إن ذُكرت. لا تخترع أبعادا على أنها واردة بالكراسة. لكل عنصر اكتب measurement_source = explicit إن كانت الأبعاد صريحة، area_only إن كانت مساحة فقط، suggested إن لم توجد أبعاد، unspecified إن تعذر التقدير. لو وردت مساحة بالمتر المربع فقط، اقترح طولًا وعرضًا منطقيين حاصل ضربهما يساوي المساحة بدقة حتى منزلتين، مثلا 24 م² = 6×4، وبين أنها مقترحة وتحتاج اعتماداً وأن نسبة الأبعاد تعتمد على الشكل والموقع. إذا لم توجد أي مساحة أو أبعاد، اقترح مقاسات أولية مع توضيح أنها افتراضية، أو اتركها فارغة إن كانت المعلومة غير كافية. لا تخلط مساحة الجناح كله بمساحة أركانه. استخدم المتر m كوحدة موحدة. اذكر التعارضات والنواقص وأسئلة مهمة للمصمم. لأي معلومة من المصدر، اذكر صفحة أو مقتطف نص قصير في evidence إن أمكن. لا تستنتج عناصر غير مطلوبة باعتبارها إلزامية. ارجع JSON فقط بالشكل {type:"event|pavilion|mixed",project_name:string,summary:string,overall_area_sqm:number|null,overall_dimensions:{length_m:number|null,width_m:number|null,height_m:number|null,source:"explicit|area_only|suggested|unspecified",note:string},items:[{name:string,category:string,quantity:number,description:string,activity:string,location:string,area_sqm:number|null,length_m:number|null,width_m:number|null,height_m:number|null,diameter_m:number|null,measurement_source:"explicit|area_only|suggested|unspecified",dimension_note:string,evidence:string}],design_requirements:string[],missing_information:string[],conflicts:string[],designer_questions:string[]}. لا تكتب مقدمات خارج JSON.`;
 const parts:any[]=[{text:prompt+'\n\nنص كراسة الشروط المقدم:\n'+text}];
 if(pdf)parts.push({inline_data:{mime_type:'application/pdf',data:pdf}});
 let last='';
 const models=(Deno.env.get('GEMINI_ANALYZER_MODELS')||'gemini-2.5-flash,gemini-2.5-flash-lite').split(',').map(x=>x.trim()).filter(Boolean);
 // Large tender documents can overflow one JSON response. Retry with a much smaller
 // payload instead of surfacing a confusing JSON syntax error to the designer.
 const modes=[
  {name:'detailed',limit:8192,extra:'Return concise descriptions (maximum 90 Arabic characters per field), evidence maximum 70 characters, and max 60 items. Group identical repeated elements with quantity. Keep all essential design elements.'},
  {name:'compact',limit:8192,extra:'IMPORTANT: respond in VERY COMPACT JSON, max 35 grouped items, each description <= 45 characters, evidence <= 30 characters; keep all explicit measurements and important areas. Use empty strings rather than lengthy explanations. No markdown.'},
  {name:'minimum',limit:8192,extra:'Output a MINIMAL JSON object containing at most 20 grouped, most important design elements. Very short values (<=25 characters). Prioritize dimensions, quantity and missing data. Never truncate JSON. No markdown.'}
 ];
 for(const mode of modes){
  for(const model of models){
   try{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),50000);
    let response:Response;
    try{
     response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify({contents:[{role:'user',parts:[...parts,{text:mode.extra}]}],generationConfig:{temperature:0,responseMimeType:'application/json',maxOutputTokens:mode.limit}})});
    }finally{clearTimeout(timer);}
    const data=await response.json();if(!response.ok){last=String(data?.error?.message||response.status).slice(0,200);continue;}
    const candidate=data?.candidates?.[0];
    const raw=(candidate?.content?.parts||[]).map((p:any)=>p.text||'').join('').trim();
    if(!raw){last='Empty model response';continue;}
    let result:any;
    try{result=JSON.parse(raw);}catch{
     last=candidate?.finishReason==='MAX_TOKENS'?'Gemini output exceeded token limit':'Gemini returned incomplete JSON';
     continue;
    }
    if(!result||!Array.isArray(result.items)){last='Invalid report structure';continue;}
    return reply({result,model,report_mode:mode.name,warning:mode.name==='detailed'?'':'تم تقليل تفاصيل التقرير لضمان اكتمال التحليل. راجع العناصر المستخرجة مقابل الكراسة الأصلية.'});
   }catch(e){last=e instanceof Error?e.message:String(e);}
  }
 }

 return reply({error:'تعذر التحليل بواسطة Gemini: '+last},503);
 }catch(e){return reply({error:e instanceof Error?e.message:'Server error'},500);}
});