export type Profile={id:string;name:string;username:string;role:'ceo'|'coordinator'|'employee';active:boolean;must_change:boolean};
export type Task={id:string;title:string;brief:string;drive_url:string;due_at:string;round:number;approved_at:string|null;created_at:string;updated_at:string;created_by:string;version:number};
export type Assignment={id:string;task_id:string;user_id:string;round:number;active:boolean;status:string;elapsed_ms:number;running_since:string|null;started_at:string|null;submitted_at:string|null;submission_url:string|null;delay_reason:string|null};
export type RequestItem={id:string;created_by:string;kind:string;title:string;body:string;status:string;response:string;created_at:string;updated_at:string};
export type Activity={id:number;task_id:string;actor:string;action:string;detail:string;created_at:string};
export type State={server_time:string;profiles:Profile[];tasks:Task[];assignments:Assignment[];requests:RequestItem[];activity:Activity[]};
export const roleLabel={ceo:'CEO',coordinator:'تنسيق التاسكات',employee:'فريق التصميم'};
export const statusLabel:Record<string,string>={unassigned:'بانتظار التوزيع',assigned:'لم يبدأ',working:'شغال',paused:'متوقف',submitted:'تم التسليم',review:'بانتظار الاعتماد',approved:'معتمد'};
export function currentAssignments(t:Task,state:State){return state.assignments.filter(a=>a.task_id===t.id&&a.round===t.round&&a.active);}
export function status(t:Task,s:State){const a=currentAssignments(t,s);return t.approved_at?'approved':!a.length?'unassigned':a.every(x=>x.status==='submitted')?'review':a.some(x=>x.status==='working')?'working':a.some(x=>x.status==='paused')?'paused':'assigned';}
export function ms(a:Assignment,now:number){return a.elapsed_ms+(a.running_since?Math.max(0,now-Date.parse(a.running_since)):0);}
export function duration(n:number){const s=Math.floor(n/1000);return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(x=>String(x).padStart(2,'0')).join(':');}
export function date(value:string){return new Intl.DateTimeFormat('ar-EG',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));}
export function localDate(value?:string){const d=value?new Date(value):new Date(Date.now()+86400000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
