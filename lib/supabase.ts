import {createClient} from '@supabase/supabase-js';
export const SUPABASE_URL='https://viwaclirvokwoeqqivgr.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY='sb_publishable_OoERhmKw2t5PSwMiYX2I0A_DZE04otZ';
export const supabase=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);

async function authHeaders(){
 const {data:{session}}=await supabase.auth.getSession();
 if(!session)throw new Error('سجّل دخولك أولًا.');
 return {session,headers:{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_PUBLISHABLE_KEY}};
}

export async function accountAction(body:Record<string,unknown>){
 const {headers}=await authHeaders();
 const res=await fetch(`${SUPABASE_URL}/functions/v1/brivviant-accounts`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const data=await res.json() as {error?:string;ok?:boolean};if(!res.ok||data.error)throw new Error(data.error||'تعذر تنفيذ الإجراء.');return data;
}

export async function voiceTaskAction(audio:Blob,driveUrl=''){
 const {headers}=await authHeaders();
 const body=new FormData();
 body.append('audio',audio,`voice-task.${audio.type.includes('ogg')?'ogg':audio.type.includes('mp4')?'m4a':'webm'}`);
 if(driveUrl.trim())body.append('drive_url',driveUrl.trim());
 const res=await fetch(`${SUPABASE_URL}/functions/v1/brivviant-voice-task`,{method:'POST',headers,body});
 const data=await res.json() as {error?:string;ok?:boolean;fallback_manual?:boolean;reason?:string;message?:string;title?:string;assignees?:string[];warning?:string;used_default_drive?:boolean;transcript?:string;model_used?:string;attempted_models?:string[];drive_url?:string};
 if(!res.ok||data.error)throw new Error(data.error||'تعذر إنشاء التاسك بالصوت.');
 return data;
}
