'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '@/lib/supabase';
import {type Profile,date,roleLabel} from '@/lib/types';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {Sheet,SheetContent,SheetTitle,SheetDescription} from '@/components/ui/sheet';
import {Tabs,TabsList,TabsTrigger,TabsContent} from '@/components/ui/tabs';
import {Bell,MessageSquare,Send,ArrowRight,CheckCheck} from 'lucide-react';
import {toast} from 'sonner';
type Notice={id:number;kind:string;title:string;task_id:string|null;request_id:string|null;peer_id:string|null;created_at:string;read_at:string|null};
type Message={id:number;sender_id:string;recipient_id:string;body:string;created_at:string;read_at:string|null};
async function communicate(action:string,p:Record<string,unknown>){
 const {data,error}=await supabase.rpc('bv_communicate',{p_action:action,p});
 if(error)throw new Error(error.message);if(!data?.ok)throw new Error('لم يؤكد السيرفر حفظ التغيير.');return data;
}
const merge=<T extends {id:number}>(previous:T[],next:T[])=>Array.from(new Map([...previous,...next].map(x=>[x.id,x])).values()).sort((a,b)=>b.id-a.id);
export default function Communication({me,profiles,onTask,onRequests}:{me:Profile;profiles:Profile[];onTask:(id:string)=>void;onRequests:()=>void}){
 const [opened,setOpened]=useState(false),[tab,setTab]=useState('notifications'),[notices,setNotices]=useState<Notice[]>([]),[unread,setUnread]=useState(0),[noticeMore,setNoticeMore]=useState(false);
 const [peer,setPeer]=useState<string|null>(null),[messages,setMessages]=useState<Message[]>([]),[older,setOlder]=useState(false),[loading,setLoading]=useState(false),[sending,setSending]=useState(false),[draft,setDraft]=useState(''),[error,setError]=useState('');
 const messageEnd=useRef<HTMLDivElement>(null),noticeFloor=useRef<number|null>(null);
 const sendLock=useRef(false),mounted=useRef(true),messageSeq=useRef(0),noticeSeq=useRef(0),messageFloor=useRef<number|null>(null);
 const pending=useRef<{client_id:string;body:string;recipient_id:string}|null>(null);
 const currentPeer=useRef(peer);currentPeer.current=peer;
 const loadNotices=useCallback(async(before?:number)=>{
  const seq=++noticeSeq.current;
  let query=supabase.from('bv_notifications').select('*').eq('user_id',me.id).order('id',{ascending:false}).limit(100);
  if(before)query=query.lt('id',before);
  const [rows,count]=await Promise.all([query,supabase.from('bv_notifications').select('id',{count:'exact',head:true}).eq('user_id',me.id).is('read_at',null)]);
  if(!mounted.current||seq!==noticeSeq.current)return;
  if(rows.error||count.error){setError('تعذر تحديث الإشعارات. حاول تاني.');return;}
  setNotices(old=>merge(old,rows.data as Notice[]));setUnread(count.count||0);if(before||noticeFloor.current===null)setNoticeMore(rows.data.length===100);if(rows.data.length)noticeFloor.current=Math.min(noticeFloor.current||Infinity,...rows.data.map(x=>x.id));setError('');
 },[me.id]);
 const loadMessages=useCallback(async(before?:number)=>{
  if(!peer)return;
  const seq=++messageSeq.current;
  let query=supabase.from('bv_messages').select('*').or(`and(sender_id.eq.${me.id},recipient_id.eq.${peer}),and(sender_id.eq.${peer},recipient_id.eq.${me.id})`).order('id',{ascending:false});
  if(before)query=query.lt('id',before).limit(50);
  else if(messageFloor.current)query=query.gte('id',messageFloor.current);
  else query=query.limit(50);
  const {data,error:e}=await query;
  if(!mounted.current||currentPeer.current!==peer||seq!==messageSeq.current)return;
  setLoading(false);
  if(e){setError('تعذر تحميل المحادثة. حاول تاني.');return;}
  const rows=data as Message[];
  setMessages(old=>merge(old,rows));if(before||!messageFloor.current)setOlder(rows.length===50);
  if(rows.length)messageFloor.current=Math.min(messageFloor.current||Infinity,...rows.map(x=>x.id));
  setError('');
 },[me.id,peer]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{setMessages([]);setOlder(false);messageFloor.current=null;setLoading(!!peer);setError('');void loadMessages();},[peer,loadMessages]);
 useEffect(()=>{
  void loadNotices();
  const refresh=()=>{void loadNotices();void loadMessages();};
  const channel=supabase.channel('inbox-'+me.id+'-'+(peer||'all'))
   .on('postgres_changes',{event:'*',schema:'public',table:'bv_notifications',filter:`user_id=eq.${me.id}`},p=>{void loadNotices();if(p.eventType==='INSERT'){const n=p.new as Notice;toast(n.title,{description:'افتح الإشعارات للمتابعة',action:{label:'عرض',onClick:()=>{setOpened(true);setTab('notifications');}}});}})
   .on('postgres_changes',{event:'*',schema:'public',table:'bv_messages'},()=>void loadMessages())
   .subscribe(status=>{if(status==='SUBSCRIBED')refresh();});
  const interval=setInterval(()=>{if(!document.hidden)refresh();},15000);
  window.addEventListener('online',refresh);window.addEventListener('focus',refresh);
  return()=>{clearInterval(interval);void supabase.removeChannel(channel);window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh);};
 },[me.id,peer,loadMessages,loadNotices]);
 useEffect(()=>{
  const incoming=messages.filter(x=>x.recipient_id===me.id&&!x.read_at);
  if(!opened||tab!=='chat'||!peer||!incoming.length||document.hidden)return;
  let cancelled=false;
  communicate('read_chat',{peer_id:peer,through:Math.max(...incoming.map(x=>x.id))}).then(()=>{if(!cancelled){void loadMessages();void loadNotices();}}).catch(e=>{if(!cancelled)setError(e.message);});
  return()=>{cancelled=true;};
 },[messages,opened,tab,peer,me.id,loadMessages,loadNotices]);
 useEffect(()=>{if(opened&&tab==='chat')messageEnd.current?.scrollIntoView({block:'nearest'});},[messages[0]?.id,opened,tab]);
 const choosePeer=(id:string)=>{setPeer(id);setDraft('');pending.current=null;setMessages([]);setTab('chat');};
 const act=async(n:Notice)=>{
  try{await communicate('read_notification',{id:n.id});await loadNotices();}catch(e){toast.error(e instanceof Error?e.message:'تعذر الحفظ');return;}
  if(n.peer_id){choosePeer(n.peer_id);return;}
  if(n.task_id){setOpened(false);onTask(n.task_id);return;}
  if(n.request_id){setOpened(false);onRequests();}
 };
 const send=async(e:React.FormEvent)=>{
  e.preventDefault();if(sendLock.current||!peer||!draft.trim())return;
  sendLock.current=true;setSending(true);setError('');
  const body=draft.trim(),recipient_id=peer;
  if(!pending.current||pending.current.body!==body||pending.current.recipient_id!==peer)pending.current={client_id:crypto.randomUUID(),body,recipient_id};
  try{await communicate('send',pending.current);pending.current=null;if(currentPeer.current===recipient_id){setDraft('');await loadMessages();}}
  catch(e){setError(e instanceof Error?e.message:'تعذر إرسال الرسالة. النص محفوظ هنا؛ حاول مرة أخرى.');}
  finally{sendLock.current=false;setSending(false);}
 };
 const selected=profiles.find(p=>p.id===peer);
 return <><Button className="inbox-trigger" variant="ghost" onClick={()=>setOpened(true)} aria-label={`الإشعارات والمحادثات، ${unread} غير مقروء`}><Bell size={20}/><span className="inbox-label">التواصل</span>{unread>0&&<b className="unread-count">{unread>99?'99+':unread}</b>}</Button>
 <Sheet open={opened} onOpenChange={setOpened}><SheetContent side="left" className="inbox-sheet" dir="rtl"><div className="inbox-heading"><SheetTitle>التواصل مع الفريق</SheetTitle><SheetDescription>رسائلك الخاصة وإشعاراتك محفوظة حتى بعد تسجيل الخروج.</SheetDescription></div>
 <Tabs value={tab} onValueChange={setTab} dir="rtl"><TabsList className="inbox-tabs"><TabsTrigger value="notifications"><Bell size={16}/>الإشعارات {unread>0?`(${unread})`:''}</TabsTrigger><TabsTrigger value="chat"><MessageSquare size={16}/>محادثات خاصة</TabsTrigger></TabsList>
 {error&&<div className="error-banner" role="alert">{error}<Button size="sm" variant="outline" onClick={()=>{void loadMessages();void loadNotices();}}>تحديث</Button></div>}
 <TabsContent value="notifications"><div className="inbox-actions"><p>الجديد في الفريق</p><Button size="sm" variant="outline" disabled={!unread} onClick={async()=>{try{const through=notices[0]?.id||0;await communicate('read_all',{through});setNotices(old=>old.map(n=>n.id<=through?{...n,read_at:new Date().toISOString()}:n));await loadNotices();}catch(e){toast.error(e instanceof Error?e.message:'تعذر الحفظ');}}}><CheckCheck size={16}/>تحديد كمقروء</Button></div>
 {!notices.length?<div className="empty-state"><Bell size={32}/><h3>مفيش إشعارات لسه</h3><p>تحديثات الفريق الجديدة هتظهر هنا.</p></div>:<div className="notice-list">{notices.map(n=><button className={'notice-card '+(!n.read_at?'unread':'')} key={n.id} onClick={()=>void act(n)}><span>{n.kind==='message'?<MessageSquare size={19}/>:<Bell size={19}/>}</span><div><b>{n.title}</b><small>{date(n.created_at)}</small>{n.kind==='task'&&!n.task_id&&<small>تحديث عام للفريق؛ التفاصيل للمكلّفين والإدارة.</small>}</div>{!n.read_at&&<span className="unread-dot" aria-label="غير مقروء"/>}</button>)}</div>}
 {noticeMore&&<Button variant="outline" onClick={()=>void loadNotices(notices.at(-1)?.id)}>إشعارات أقدم</Button>}</TabsContent>
 <TabsContent value="chat">{!peer?<><p className="chat-hint">اختار شخصًا لبدء محادثة. الرسائل يراها طرفا المحادثة فقط.</p><div className="chat-contacts">{profiles.filter(p=>p.id!==me.id).map(p=><button key={p.id} onClick={()=>choosePeer(p.id)}><span className="avatar">{p.name.slice(0,2)}</span><span><b dir="ltr">{p.name}</b><small>{roleLabel[p.role]}{!p.active?' · حساب غير مفعّل':''}</small></span><MessageSquare size={18}/></button>)}</div></>:<><div className="chat-person"><Button variant="ghost" size="icon" aria-label="رجوع لقائمة الفريق" disabled={sending} onClick={()=>{setPeer(null);setDraft('');pending.current=null;}}><ArrowRight size={19}/></Button><div><b dir="ltr">{selected?.name||'عضو الفريق'}</b><small>محادثة خاصة بينكما</small></div></div>
 <div className="chat-messages" role="log" aria-label="رسائل المحادثة" aria-live="polite">{older&&<Button variant="outline" onClick={()=>void loadMessages(messages.at(-1)?.id)}>تحميل رسائل أقدم</Button>}{loading?<p>جاري تحميل المحادثة…</p>:!messages.length?<p className="chat-hint">ابدأ أول رسالة.</p>:[...messages].reverse().map(m=><article key={m.id} className={'chat-bubble '+(m.sender_id===me.id?'mine':'theirs')}><p>{m.body}</p><small>{date(m.created_at)}{m.sender_id===me.id&&<span> · {m.read_at?'مقروءة':'تم الإرسال'}</span>}</small></article>)}<div ref={messageEnd}/></div>
 <form className="chat-compose" onSubmit={send}><label htmlFor="private-message">رسالتك إلى {selected?.name}</label><Textarea id="private-message" value={draft} onChange={e=>setDraft(e.target.value)} rows={3} maxLength={5000} required disabled={sending||!selected?.active} placeholder="اكتب رسالتك…"/><Button type="submit" disabled={sending||!draft.trim()||!selected?.active}><Send size={17}/>{sending?'جاري الحفظ والإرسال…':'إرسال'}</Button>{!selected?.active&&<small>الحساب غير مفعّل. الرسائل السابقة محفوظة.</small>}</form></>}</TabsContent>
 </Tabs></SheetContent></Sheet></>;
}
