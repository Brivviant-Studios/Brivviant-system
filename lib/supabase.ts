import {createClient} from '@supabase/supabase-js';
export const supabase=createClient('https://viwaclirvokwoeqqivgr.supabase.co','sb_publishable_OoERhmKw2t5PSwMiYX2I0A_DZE04otZ');
export async function accountAction(body:Record<string,unknown>){
 const {data:{session}}=await supabase.auth.getSession();
 if(!session)throw new Error('سجّل دخولك أولًا.');
 const res=await fetch('https://viwaclirvokwoeqqivgr.supabase.co/functions/v1/brivviant-accounts',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`,apikey:'sb_publishable_OoERhmKw2t5PSwMiYX2I0A_DZE04otZ'},body:JSON.stringify(body)});
 const data=await res.json() as {error?:string;ok?:boolean};if(!res.ok||data.error)throw new Error(data.error||'تعذر تنفيذ الإجراء.');return data;
}
