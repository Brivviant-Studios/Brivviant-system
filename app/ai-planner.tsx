'use client';
import {useState} from 'react';
import {supabase} from '@/lib/supabase';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Plus,Trash2,Send,CalendarDays} from 'lucide-react';
type Work={id:string;title:string;hours:number;deadline:string;priority:string};
type Day={date:string;hours:number;load:string;items:{taskId:string;title:string;hours:number}[]};
type Result={reply:string;days:Day[];deliveries:{taskId:string;date:string;risk:string}[];warnings:string[]};
const newTask=():Work=>({id:crypto.randomUUID(),title:'',hours:4,deadline:'',priority:'normal'});
const start=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const loadName:Record<string,string>={light:'خفيف',balanced:'متوازن',busy:'مضغوط',overloaded:'أكثر من الطاقة'};
export default function AiPlanner(){
 const [tasks,setTasks]=useState<Work[]>([newTask()]),[hours,setHours]=useState(8),[startDate,setStartDate]=useState(start);
 const [workDays,setWorkDays]=useState<number[]>([0,1,2,3,4]),[message,setMessage]=useState('وزع الشغل بأفضل طريقة ووضح لي امتى هكون مضغوط وامتى أقدر أسلم.');
 const [chat,setChat]=useState<{q:string;a:string}[]>([]),[plan,setPlan]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const update=(id:string,changes:Partial<Work>)=>setTasks(p=>p.map(t=>t.id===id?{...t,...changes}:t));
 async function submit(){
  if(busy)return;
  if(!tasks.some(t=>t.title.trim()&&t.hours>0)){setError('أدخل اسم مهمة ووقتها المتوقع.');return;}
  setBusy(true);setError('');
  try{
   const {data:{session}}=await supabase.auth.getSession();
   if(!session)throw new Error('سجّل دخولك مرة أخرى.');
   const {data,error:fnError}=await supabase.functions.invoke('brivviant-ai-planner',{body:{tasks:tasks.filter(t=>t.title.trim()&&t.hours>0),hoursPerDay:hours,workDays,startDate,message}});
   if(fnError)throw new Error(typeof data?.error==='string'?data.error:fnError.message);
   if(data?.error)throw new Error(data.error);
   if(!data||!Array.isArray(data.days))throw new Error('رد الذكاء الاصطناعي غير صالح.');
   setPlan(data);setChat(c=>[...c,{q:message,a:data.reply}]);setMessage('');
  }catch(e){setError(e instanceof Error?e.message:'تعذر إنشاء الخطة.');}
  finally{setBusy(false);}
 }
 return <div className="planner-root" dir="rtl">
  <div className="section-title"><div><h2>مساعد تخطيط الشغل · Gemini AI</h2><p className="muted">اكتب شغلك ومدد التنفيذ، والمساعد يقسمه على الأيام ويحدد الضغط ومواعيد التسليم المقترحة. الخطة استشارية ولا تغيّر التاسكات الأصلية.</p></div></div>
  <section className="panel" style={{padding:20,marginBottom:18}}>
   <div className="panel-header"><h3>جدول الأعمال المطلوب تنفيذها</h3><Button variant="outline" onClick={()=>setTasks(t=>[...t,newTask()])}><Plus size={16}/> إضافة شغل</Button></div>
   <div style={{overflowX:'auto'}}><table className="report-table" style={{width:'100%'}}><thead><tr><th>الشغل / المشروع</th><th>المدة بالساعات</th><th>آخر موعد مطلوب</th><th>الأولوية</th><th></th></tr></thead><tbody>{tasks.map(t=><tr key={t.id}><td><Input aria-label="اسم الشغل" placeholder="مثلاً: رندر جناح المعرض" value={t.title} onChange={e=>update(t.id,{title:e.target.value})}/></td><td><Input aria-label="الوقت المتوقع بالساعات" type="number" min="0.5" max="500" step="0.5" value={t.hours} onChange={e=>update(t.id,{hours:Number(e.target.value)})}/></td><td><Input aria-label="تاريخ التسليم" type="date" value={t.deadline} onChange={e=>update(t.id,{deadline:e.target.value})}/></td><td><select aria-label="الأولوية" className="planner-select" value={t.priority} onChange={e=>update(t.id,{priority:e.target.value})}><option value="high">عالية</option><option value="normal">عادية</option><option value="low">منخفضة</option></select></td><td><Button aria-label="حذف السطر" variant="ghost" size="icon" disabled={tasks.length===1} onClick={()=>setTasks(p=>p.filter(x=>x.id!==t.id))}><Trash2 size={16}/></Button></td></tr>)}</tbody></table></div>
   <div className="planner-options"><label>ساعات الشغل اليومية<Input type="number" min="1" max="16" value={hours} onChange={e=>setHours(Number(e.target.value))}/></label><label>بداية التخطيط<Input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)}/></label><div><b>أيام العمل</b><div className="planner-weekdays">{['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'].map((d,i)=><label key={d}><input type="checkbox" checked={workDays.includes(i)} onChange={e=>setWorkDays(s=>e.target.checked?[...s,i]:s.filter(v=>v!==i))}/>{d}</label>)}</div></div></div>
  </section>
  <section className="panel" style={{padding:20,marginBottom:18}}><h3>اسأل مساعدك</h3><p className="muted">مثلاً: لو المشروع الأول مستعجل؟ أو لو عندي تسليم جديد يوم الخميس؟ غيّر الجدول أو اكتب توجيهًا وسيتم حساب خطة جديدة.</p>
   {chat.map((c,i)=><div className="planner-exchange" key={i}><p><strong>أنت:</strong> {c.q}</p><p><strong>Gemini:</strong> {c.a}</p></div>)}
   <Textarea value={message} onChange={e=>setMessage(e.target.value)} placeholder="اكتب طلبك للجدولة أو تعديل الأولويات..." rows={3}/>
   {error&&<p role="alert" style={{color:'#e85c5c'}}>{error}</p>}
   <Button disabled={busy||!workDays.length} onClick={submit}><Send size={16}/>{busy?'جاري تحليل الشغل...':plan?'إعادة التخطيط بالذكاء الاصطناعي':'حلل وجدول الشغل'}</Button>
  </section>
  {plan&&<><section className="panel" style={{padding:20,marginBottom:18}}><h3>ملخص المساعد</h3><p style={{whiteSpace:'pre-wrap'}}>{plan.reply}</p>{plan.warnings?.map((w,i)=><p key={i} style={{color:'#d68b40'}}>⚠ {w}</p>)}</section>
   <section className="panel" style={{padding:20,marginBottom:18}}><h3><CalendarDays size={18} style={{display:'inline'}}/> جدول الأيام والضغط</h3><div className="planner-day-grid">{plan.days.map(d=><article className="planner-day" key={d.date}><div className="planner-day-heading"><b>{d.date}</b><span className={'planner-load '+d.load}>{loadName[d.load]||d.load}</span></div><small>{d.hours} ساعة</small>{d.items.map((i,k)=><p key={k}>{i.title} · {i.hours}س</p>)}</article>)}</div></section>
   <section className="panel" style={{padding:20}}><h3>مواعيد التسليم المتوقعة</h3>{plan.deliveries.map(d=><p key={d.taskId}><b>{tasks.find(t=>t.id===d.taskId)?.title||'مهمة'}:</b> {d.date} · {d.risk==='high'?'مخاطرة عالية':d.risk==='medium'?'مخاطرة متوسطة':'مخاطرة منخفضة'}</p>)}</section>
  </>}
 </div>;
