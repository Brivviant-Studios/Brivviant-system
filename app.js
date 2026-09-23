(() => {
  const C = window.APP_CONFIG;
  const SB = window.supabase.createClient(C.supabaseUrl, C.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  
  const FORBIDDEN_OLD_TABLE_PREFIX = "studio_";
  const BUILD_DATA_SOURCE = Object.freeze(["bv_profiles","bv_tasks","bv_assignments","bv_requests","bv_activity"]);

  const state = {
    session: null, me: null, profiles: [], tasks: [], assignments: [], requests: [], activity: [],
    notifications: [], messages: [], chatPeer: null,
    serverOffset: 0, view: "dashboard", taskFilter: "all", realtimeChannel: null, refreshTimer: null
  };
  const $ = (q) => document.querySelector(q);
  const $$ = (q) => [...document.querySelectorAll(q)];
  const byId = (id) => document.getElementById(id);
  const esc = (v="") => String(v).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const isoLocal = (d) => { const x=new Date(d); x.setMinutes(x.getMinutes()-x.getTimezoneOffset()); return x.toISOString().slice(0,16); };
  const fmtDate = (v) => v ? new Intl.DateTimeFormat("ar-EG",{dateStyle:"medium",timeStyle:"short"}).format(new Date(v)) : "—";
  const roleName = r => ({ceo:"CEO",team_leader:"Team Leader",coordinator:"Project Manager",employee:"Designer"})[r] || r;
  const isAdmin = r => ["ceo","team_leader"].includes(r||state.me?.role);
  const nowServer = () => Date.now() + state.serverOffset;
  const fmtMs = (ms=0) => {
    ms=Math.max(0,Number(ms)||0); const s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  };
  const person = id => state.profiles.find(p=>p.id===id);
  const visible = x => !String(x?.title||"").startsWith(C.hiddenTestPrefix);
  const activeAssignments = task => state.assignments.filter(a=>a.task_id===task.id && a.round===task.round && a.active);
  const myAssignment = task => activeAssignments(task).find(a=>a.user_id===state.me?.id);
  const taskStatus = task => {
    const aa=activeAssignments(task), late=nowServer()>new Date(task.due_at).getTime() && !task.approved_at;
    if(task.approved_at) return "approved";
    if(!aa.length) return late ? "late" : "waiting";
    if(aa.every(a=>a.status==="submitted")) return late ? "late" : "review";
    if(aa.some(a=>a.status==="working"||a.status==="paused")) return late ? "late" : "working";
    return late ? "late" : "waiting";
  };
  const statusLabel = s => ({approved:"معتمد",waiting:"بانتظار التوزيع",working:"جاري العمل",review:"قيد المراجعة",late:"متأخر"})[s]||s;
  const toast = (msg,bad=false) => { const el=byId("toast"); el.textContent=msg; el.className="toast show"+(bad?" bad":""); clearTimeout(el._t); el._t=setTimeout(()=>el.className="toast",2600); };
  const open = id => byId(id).showModal();
  const closeDialogs = () => $$("dialog[open]").forEach(d=>d.close());

  async function login(username,password){
    const u=String(username||"").trim().toLowerCase();
    const email=u.includes("@")?u:`${u}@${C.syntheticEmailDomain}`;
    const {data,error}=await SB.auth.signInWithPassword({email,password});
    if(error) throw new Error("اسم المستخدم أو كلمة المرور غير صحيحة.");
    return data.session;
  }
  async function accountAction(body){
    const token=state.session?.access_token; if(!token) throw new Error("سجّل دخولك أولًا.");
    const res=await fetch(`${C.supabaseUrl}/functions/v1/${C.accountFunction}`,{
      method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`,"apikey":C.supabasePublishableKey},
      body:JSON.stringify(body)
    });
    const out=await res.json().catch(()=>({error:"تعذر قراءة الرد."}));
    if(!res.ok||out.error) throw new Error(out.error||"تعذر تنفيذ العملية.");
    return out;
  }
  async function action(name,payload={}){
    const {data,error}=await SB.rpc("bv_action",{p_action:name,p:payload});
    if(error) throw new Error(error.message||"تعذر تنفيذ العملية.");
    await refreshState();
    return data;
  }
  async function refreshState(){
    const {data,error}=await SB.rpc("bv_state");
    if(error) throw new Error(error.message||"تعذر تحميل البيانات.");
    state.serverOffset=new Date(data.server_time).getTime()-Date.now();
    state.profiles=(data.profiles||[]);
    state.tasks=(data.tasks||[]).filter(visible);
    state.assignments=(data.assignments||[]);
    state.requests=(data.requests||[]).filter(visible);
    state.activity=(data.activity||[]);
    state.me=state.profiles.find(p=>p.id===state.session?.user?.id)||null;
    render();
    if(state.me?.must_change) forcePasswordChange();
  }
  function scheduleRefresh(){
    clearTimeout(state.refreshTimer);
    state.refreshTimer=setTimeout(()=>refreshState().catch(e=>toast(e.message,true)),180);
  }
  function subscribeRealtime(){
    if(state.realtimeChannel) SB.removeChannel(state.realtimeChannel);
    const ch=SB.channel(`brivviant-live-${state.session.user.id}`)
      .on("postgres_changes",{event:"*",schema:"public",table:"bv_tasks"},scheduleRefresh)
      .on("postgres_changes",{event:"*",schema:"public",table:"bv_assignments"},scheduleRefresh)
      .on("postgres_changes",{event:"*",schema:"public",table:"bv_requests"},scheduleRefresh)
      .on("postgres_changes",{event:"*",schema:"public",table:"bv_activity"},scheduleRefresh)
      .on("postgres_changes",{event:"*",schema:"public",table:"bv_profiles"},scheduleRefresh)
      .on("postgres_changes",{event:"*",schema:"public",table:"bv_notifications",filter:`user_id=eq.${state.session.user.id}`},()=>refreshCommunication().catch(()=>{}))
      .on("postgres_changes",{event:"*",schema:"public",table:"bv_messages"},()=>refreshCommunication().catch(()=>{}))
      .subscribe(status=>{
        const el=byId("realtimeStatus");
        el.classList.toggle("online",status==="SUBSCRIBED");
        el.classList.toggle("offline",status!=="SUBSCRIBED");
        el.innerHTML=`<span></span>${status==="SUBSCRIBED"?" Realtime Online":" "+esc(status)}`;
      });
    state.realtimeChannel=ch;
  }
  function setRoleUI(){
    document.body.dataset.role=state.me?.role||"";
    const admin=isAdmin();
    $$(".ceo-only").forEach(el=>el.classList.toggle("hidden",!admin));
    $$(".coordinator-only").forEach(el=>el.classList.toggle("hidden",!["ceo","team_leader","coordinator"].includes(state.me?.role)));
    $$(".manager-create").forEach(el=>el.classList.toggle("hidden",!["ceo","team_leader","coordinator"].includes(state.me?.role)));
    byId("profileChip").innerHTML=`<div class="avatar">${esc((state.me?.name||"?").slice(0,1).toUpperCase())}</div><div class="profile-text"><b>${esc(state.me?.name||"")}</b><small>${esc(state.me?.username||"")} · ${roleName(state.me?.role)}</small></div>`;
    byId("tasksSubtitle").textContent=state.me?.role==="employee"?"يظهر لك فقط ما تم توزيعه عليك.":"التاسكات المتاحة حسب صلاحيات حسابك.";
  }
  function render(){
    if(!state.me) return;
    setRoleUI(); renderStats(); renderTasks(); renderRequests(); renderTeam(); renderActivity(); renderDashboard(); renderCommunication();
  }
  function renderStats(){
    const tasks=state.tasks, statuses=tasks.map(t=>taskStatus(t));
    const my=state.me.role==="employee"?tasks.filter(t=>!!myAssignment(t)):tasks;
    const running=state.assignments.filter(a=>a.active&&a.status==="working").length;
    const cards=[
      ["Tasks",my.length],["Working",running],["Review",statuses.filter(x=>x==="review").length],
      ["Late",statuses.filter(x=>x==="late").length],["Approved",statuses.filter(x=>x==="approved").length]
    ];
    byId("stats").innerHTML=cards.map(([a,b])=>`<div class="stat"><small>${a}</small><b>${b}</b></div>`).join("");
  }
  function taskCard(t,compact=false){
    const s=taskStatus(t), aa=activeAssignments(t), mine=myAssignment(t), admin=isAdmin();
    const late=nowServer()>new Date(t.due_at).getTime()&&!t.approved_at;
    const assignments=aa.map(a=>{
      const p=person(a.user_id), live=Number(a.elapsed_ms||0)+(a.status==="working"&&a.running_since?Math.max(0,nowServer()-new Date(a.running_since).getTime()):0);
      let btns="";
      if(a.user_id===state.me.id && a.status==="assigned") btns+=`<button class="primary" data-act="start" data-task="${t.id}" data-a="${a.id}">Start</button>`;
      if(a.user_id===state.me.id && a.status==="working") btns+=`<button data-act="pause" data-task="${t.id}" data-a="${a.id}">Pause</button>`;
      if(a.user_id===state.me.id && a.status==="paused") btns+=`<button data-act="resume" data-task="${t.id}" data-a="${a.id}">Resume</button>`;
      if(a.user_id===state.me.id && ["working","paused"].includes(a.status)) btns+=`<button class="primary" data-act="submit" data-task="${t.id}" data-a="${a.id}">تسليم</button>`;
      const score=a.submitted_at?`<span class="score-pill">+${Number(a.points_awarded||0)} نقطة</span>`:"";
      const timing=a.started_at?`بدأ: ${fmtDate(a.started_at)}`:"لم يبدأ";
      return `<div class="assignment"><div><div class="name">${esc(p?.name||"Member")} ${score}</div><small class="muted">${timing}${a.submitted_at?` · سلّم: ${fmtDate(a.submitted_at)}`:""}${a.delay_reason?` · سبب التأخير: ${esc(a.delay_reason)}`:""}${a.points_reason?` · ${esc(a.points_reason)}`:""}</small></div><div class="timer" data-aid="${a.id}" data-base="${Number(a.elapsed_ms||0)}" data-status="${esc(a.status)}" data-running="${esc(a.running_since||"")}">${fmtMs(live)}</div><div class="assignment-actions">${btns}</div></div>`;
    }).join("");
    let actions="";
    if(admin){
      actions+=`<button data-act="assign" data-task="${t.id}">توزيع</button>`;
      actions+=`<button data-act="edit" data-task="${t.id}">تعديل</button>`;
      if(aa.length&&aa.every(a=>a.status==="submitted")&&!t.approved_at) actions+=`<button class="primary" data-act="approve" data-task="${t.id}">اعتماد التسليم</button>`;
      if(aa.length) actions+=`<button data-act="revision" data-task="${t.id}">طلب تعديلات</button>`;
      actions+=`<button class="danger" data-act="delete" data-task="${t.id}">حذف التاسك</button>`;
    }
    return `<article class="task-card" data-task-card="${t.id}">
      <div class="task-top"><div><h4 class="task-title">${esc(t.title)}</h4><div class="task-meta">
      <span class="badge mint">${statusLabel(s)}</span><span class="badge blue">Round ${t.round}</span>
      <span class="badge ${late?"danger":""}">Deadline: ${fmtDate(t.due_at)}</span>
      </div></div>${t.drive_url?`<a class="drive-link" href="${esc(t.drive_url)}" target="_blank" rel="noopener">فتح ملفات المشروع ↗</a>`:""}</div>
      ${compact?"":`<div class="task-brief">${esc(t.brief)}</div>`}
      ${assignments?`<div class="assignments">${assignments}</div>`:`<div class="empty" style="margin-top:12px;padding:15px">لم يتم توزيع التاسك بعد.</div>`}
      ${actions?`<div class="task-actions">${actions}</div>`:""}
    </article>`;
  }
  function renderTasks(){
    const q=byId("globalSearch").value.trim().toLowerCase();
    let tasks=state.tasks.filter(t=>!q||[t.title,t.brief].join(" ").toLowerCase().includes(q));
    if(state.taskFilter!=="all") tasks=tasks.filter(t=>taskStatus(t)===state.taskFilter);
    byId("tasksList").innerHTML=tasks.length?tasks.map(t=>taskCard(t)).join(""):`<div class="empty">لا توجد Tasks مطابقة.</div>`;
  }
  function renderRequests(){
    const rows=state.requests, admin=isAdmin();
    const labels={equipment:"طلب تجهيز",fault:"عطل",complaint:"شكوى",other:"أخرى"}, statuses={open:"بانتظار المراجعة",progress:"موافق عليه / قيد التنفيذ",done:"تم التنفيذ"};
    if(!rows.length){byId("requestsList").innerHTML=`<div class="empty">لا توجد طلبات حاليًا.</div>`;return;}
    byId("requestsList").innerHTML=`<div class="panel table-scroll"><table class="data-table"><thead><tr><th>صاحب الطلب</th><th>النوع</th><th>الطلب / الشكوى</th><th>الحالة</th><th>تاريخ الإرسال</th><th>وقت التنفيذ</th>${admin?"<th>إدارة</th>":""}</tr></thead><tbody>${rows.map(r=>{
      const p=person(r.created_by);
      return `<tr><td><b>${esc(p?.name||"")}</b></td><td>${esc(labels[r.kind]||r.kind)}</td><td><b>${esc(r.title)}</b><small class="table-detail">${esc(r.body)}</small>${r.response?`<span class="response-inline">رد الإدارة: ${esc(r.response)}</span>`:""}</td><td><span class="badge ${r.status==="done"?"mint":r.status==="progress"?"blue":""}">${esc(statuses[r.status]||r.status)}</span></td><td>${fmtDate(r.created_at)}</td><td>${r.execution_due_at?`${fmtDate(r.execution_due_at)}${r.approved_at?`<small class="table-detail">اعتمد: ${fmtDate(r.approved_at)}</small>`:""}`:"—"}</td>${admin?`<td><div class="inline-actions"><button data-request-manage="${r.id}">متابعة</button><button class="danger" data-request-delete="${r.id}">حذف</button></div></td>`:""}</tr>`;
    }).join("")}</tbody></table></div>`;
  }
  function renderTeam(){
    if(!isAdmin()) return;
    const historyFor=id=>state.assignments.filter(a=>a.user_id===id&&a.submitted_at).sort((a,b)=>new Date(b.submitted_at)-new Date(a.submitted_at));
    byId("teamList").innerHTML=state.profiles.map(p=>{
      const history=historyFor(p.id), total=history.reduce((n,a)=>n+Number(a.points_awarded||0),0), recent=history.slice(0,5);
      return `<article class="user-card performance-card"><div class="request-head"><div><h4>${esc(p.name)}</h4><small>${esc(p.username)}</small></div><span class="badge ${p.active?"mint":"danger"}">${p.active?"Active":"Disabled"}</span></div><div class="task-meta" style="margin-top:10px"><span class="badge blue">${roleName(p.role)}</span><span class="score-total">${total} نقطة</span></div><div class="password-reference"><small>Default / Reset Password</small><b>123456</b></div><div class="recent-deliveries"><b>آخر التسليمات</b>${recent.length?recent.map(a=>{const t=state.tasks.find(x=>x.id===a.task_id);return `<div class="delivery-row"><span>${esc(t?.title||"تاسك مؤرشف")}</span><strong>+${Number(a.points_awarded||0)}</strong><small>${fmtDate(a.submitted_at)}${a.delay_reason?` · سبب التأخير: ${esc(a.delay_reason)}`:""}</small></div>`}).join(""):`<small class="muted">لا توجد تسليمات بعد.</small>`}</div><div class="actions"><button data-user-edit="${p.id}">تعديل</button>${p.id!==state.me.id?`<button data-user-reset="${p.id}">Reset → 123456</button>`:""}</div></article>`;
    }).join("");
  }
  function renderActivity(){
    if(!isAdmin()) return;
    const rows=state.activity;
    byId("activityList").innerHTML=rows.length?rows.map(a=>{const t=a.task_id?state.tasks.find(x=>x.id===a.task_id):null;const r=a.request_id?state.requests.find(x=>x.id===a.request_id):null;return `<tr><td><b>${esc(person(a.actor)?.name||"")}</b></td><td>${esc(a.action)}</td><td>${esc(t?.title||r?.title||(a.task_id?"تاسك مؤرشف":a.request_id?"طلب/شكوى مؤرشفة":"النظام"))}</td><td>${esc(a.detail||"—")}</td><td>${fmtDate(a.created_at)}</td></tr>`}).join(""):`<tr><td colspan="5"><div class="empty">لا يوجد نشاط.</div></td></tr>`;
  }
  async function communicate(name,payload={}){
    const {data,error}=await SB.rpc("bv_communicate",{p_action:name,p:payload});
    if(error) throw new Error(error.message||"تعذر تنفيذ عملية التواصل.");
    return data;
  }
  async function refreshCommunication(){
    if(!state.session||!state.me)return;
    const [nres,mres]=await Promise.all([
      SB.from("bv_notifications").select("*").eq("user_id",state.me.id).order("id",{ascending:false}).limit(100),
      state.chatPeer?SB.from("bv_messages").select("*").or(`and(sender_id.eq.${state.me.id},recipient_id.eq.${state.chatPeer}),and(sender_id.eq.${state.chatPeer},recipient_id.eq.${state.me.id})`).order("id",{ascending:true}).limit(200):Promise.resolve({data:[],error:null})
    ]);
    if(!nres.error)state.notifications=nres.data||[];
    if(!mres.error)state.messages=mres.data||[];
    renderCommunication();
  }
  function renderCommunication(){
    if(!state.me)return;
    byId("chatContacts").innerHTML=state.profiles.filter(p=>p.id!==state.me.id).map(p=>`<button class="contact-card ${state.chatPeer===p.id?"active":""}" data-chat-peer="${p.id}"><span class="avatar">${esc(p.name.slice(0,1))}</span><span><b>${esc(p.name)}</b><small>${roleName(p.role)}${p.active?"":" · Disabled"}</small></span></button>`).join("");
    const unread=state.notifications.filter(n=>!n.read_at).length;byId("notificationCount").textContent=String(unread);
    byId("notificationsList").innerHTML=state.notifications.length?state.notifications.slice(0,30).map(n=>`<button class="notice-card ${n.read_at?"":"unread"}" data-notice="${n.id}"><b>${esc(n.title)}</b><small>${fmtDate(n.created_at)}</small></button>`).join(""):`<div class="empty">لا توجد إشعارات.</div>`;
    const peer=person(state.chatPeer);byId("chatPeerLabel").textContent=peer?peer.name:"اختر عضو";
    byId("chatDraft").disabled=!peer;byId("chatSendBtn").disabled=!peer;
    byId("chatMessages").innerHTML=peer?(state.messages.length?state.messages.map(m=>`<div class="chat-bubble ${m.sender_id===state.me.id?"mine":"theirs"}"><p>${esc(m.body)}</p><small>${fmtDate(m.created_at)}${m.sender_id===state.me.id?` · ${m.read_at?"مقروءة":"مرسلة"}`:""}</small></div>`).join(""):`<div class="empty">ابدأ أول رسالة.</div>`):`<div class="empty">اختار عضوًا من القائمة.</div>`;
    byId("chatMessages").scrollTop=byId("chatMessages").scrollHeight;
  }
  function renderDashboard(){
    const current=state.tasks.filter(t=>taskStatus(t)!=="approved").slice(0,6);
    byId("dashboardTasks").innerHTML=current.length?current.map(t=>taskCard(t,true)).join(""):`<div class="empty">لا توجد Tasks حالية.</div>`;
    const rows=state.activity.slice(0,12);
    byId("dashboardActivity").innerHTML=rows.length?rows.map(a=>`<div class="activity-item"><b>${esc(a.action)}</b><div>${esc(a.detail||"")}</div><small>${esc(person(a.actor)?.name||"")} · ${fmtDate(a.created_at)}</small></div>`).join(""):`<div class="empty">لا يوجد نشاط.</div>`;
  }
  function updateTimers(){
    $$(".timer").forEach(el=>{
      const base=Number(el.dataset.base||0), running=el.dataset.running, status=el.dataset.status;
      const live=base+(status==="working"&&running?Math.max(0,nowServer()-new Date(running).getTime()):0);
      el.textContent=fmtMs(live);
    });
  }
  function switchView(v){
    state.view=v; $$(".view").forEach(x=>x.classList.toggle("active",x.id===`${v}View`)); $$("#nav button").forEach(x=>x.classList.toggle("active",x.dataset.view===v));
    byId("viewTitle").textContent=({dashboard:"Dashboard",tasks:"Tasks",requests:"Requests",communication:"Communication",team:"Team & Points",activity:"Activity Log"})[v]||v;if(v==="communication")refreshCommunication().catch(e=>toast(e.message,true));
  }
  function taskById(id){return state.tasks.find(t=>t.id===id)}
  function forcePasswordChange(){
    if(byId("passwordDialog").open) return;
    byId("passwordForceText").textContent="لازم تغيّر كلمة المرور المؤقتة قبل استخدام النظام.";
    byId("passwordCancelBtn").classList.add("hidden");
    open("passwordDialog");
  }

  byId("loginForm").addEventListener("submit",async e=>{
    e.preventDefault(); byId("loginError").textContent="";
    try{ await login(byId("loginUsername").value,byId("loginPassword").value); }
    catch(err){byId("loginError").textContent=err.message}
  });
  SB.auth.onAuthStateChange(async (event,session)=>{
    state.session=session;
    if(!session){
      byId("loginOverlay").classList.remove("hidden"); byId("shell").classList.add("hidden");
      if(state.realtimeChannel) SB.removeChannel(state.realtimeChannel);
      return;
    }
    byId("loginOverlay").classList.add("hidden"); byId("shell").classList.remove("hidden");
    try{await refreshState();subscribeRealtime();await refreshCommunication()}catch(e){toast(e.message,true)}
  });
  byId("logoutBtn").addEventListener("click",()=>SB.auth.signOut());
  byId("changePasswordBtn").addEventListener("click",()=>{byId("passwordForceText").textContent="";byId("passwordCancelBtn").classList.remove("hidden");open("passwordDialog")});
  byId("passwordForm").addEventListener("submit",async e=>{
    e.preventDefault(); const a=byId("newPassword").value,b=byId("confirmPassword").value;
    if(a!==b)return toast("تأكيد كلمة المرور غير مطابق.",true);
    try{await accountAction({action:"change_password",current_password:byId("currentPassword").value,password:a});byId("passwordDialog").close();e.target.reset();toast("تم تغيير كلمة المرور.");await refreshState()}
    catch(err){toast(err.message,true)}
  });
  $$("[data-close]").forEach(b=>b.addEventListener("click",()=>b.closest("dialog").close()));
  $$("#nav button").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.view)));
  byId("globalSearch").addEventListener("input",renderTasks);
  $$("#taskFilters button").forEach(b=>b.addEventListener("click",()=>{state.taskFilter=b.dataset.filter;$$("#taskFilters button").forEach(x=>x.classList.toggle("active",x===b));renderTasks()}));

  byId("newTaskBtn").addEventListener("click",()=>{byId("taskForm").reset();byId("taskId").value="";byId("taskDialogTitle").textContent="إضافة Task";byId("taskDue").value=isoLocal(Date.now()+24*3600*1000);open("taskDialog")});
  byId("taskForm").addEventListener("submit",async e=>{
    e.preventDefault(); const id=byId("taskId").value, payload={title:byId("taskTitle").value.trim(),brief:byId("taskBrief").value.trim(),drive_url:byId("taskDrive").value.trim(),due_at:new Date(byId("taskDue").value).toISOString()};
    try{
      if(id){const t=taskById(id);await action("edit_task",{...payload,task_id:id,version:t.version})} else await action("create_task",payload);
      byId("taskDialog").close();toast("تم حفظ التاسك.");
    }catch(err){toast(err.message,true)}
  });
  byId("assignForm").addEventListener("submit",async e=>{
    e.preventDefault();const id=byId("assignTaskId").value,t=taskById(id),ids=$$("#assignUsers input:checked").map(x=>x.value);
    try{await action("assign",{task_id:id,version:t.version,user_ids:ids});byId("assignDialog").close();toast("تم توزيع التاسك.")}catch(err){toast(err.message,true)}
  });
  byId("submitForm").addEventListener("submit",async e=>{
    e.preventDefault();const id=byId("submitTaskId").value,t=taskById(id);
    try{await action("submit",{task_id:id,version:t.version,assignment_id:byId("submitAssignmentId").value,submission_url:byId("submissionUrl").value.trim(),delay_reason:byId("submissionDelay").value.trim()});byId("submitDialog").close();e.target.reset();toast("تم التسليم واحتساب النقاط تلقائيًا.")}catch(err){toast(err.message,true)}
  });
  byId("revisionForm").addEventListener("submit",async e=>{
    e.preventDefault();const id=byId("revisionTaskId").value,t=taskById(id);
    try{await action("revision",{task_id:id,version:t.version,note:byId("revisionNote").value.trim(),due_at:new Date(byId("revisionDue").value).toISOString()});byId("revisionDialog").close();e.target.reset();toast("تم فتح Revision جديد.")}catch(err){toast(err.message,true)}
  });
  byId("newRequestBtn").addEventListener("click",()=>open("requestDialog"));
  byId("requestForm").addEventListener("submit",async e=>{
    e.preventDefault();try{await action("create_request",{kind:byId("requestKind").value,title:byId("requestTitle").value.trim(),body:byId("requestBody").value.trim()});byId("requestDialog").close();e.target.reset();toast("تم إرسال الطلب.")}catch(err){toast(err.message,true)}
  });
  byId("requestManageForm").addEventListener("submit",async e=>{
    e.preventDefault();try{const status=byId("manageRequestStatus").value,due=byId("manageRequestDue").value;await action("update_request",{id:byId("manageRequestId").value,status,response:byId("manageRequestResponse").value.trim(),execution_due_at:due?new Date(due).toISOString():""});byId("requestManageDialog").close();toast("تم تحديث الطلب.")}catch(err){toast(err.message,true)}
  });
  byId("resetAllPasswordsBtn").addEventListener("click",async ()=>{
    if(!confirm("Reset Password لكل الحسابات النشطة إلى 123456؟"))return;
    try{
      const out=await accountAction({action:"bulk_reset_default"});
      toast(`تم Reset ${out.results?.length||0} حساب إلى 123456.`);
      await refreshState();
    }catch(err){toast(err.message,true)}
  });
  byId("newUserBtn").addEventListener("click",()=>open("userDialog"));
  byId("userForm").addEventListener("submit",async e=>{
    e.preventDefault();try{await accountAction({action:"create_user",name:byId("newUserName").value.trim(),username:byId("newUsername").value.trim().toLowerCase(),role:byId("newUserRole").value});byId("userDialog").close();e.target.reset();toast("تم إنشاء الحساب.");await refreshState()}catch(err){toast(err.message,true)}
  });

  byId("chatForm").addEventListener("submit",async e=>{
    e.preventDefault();if(!state.chatPeer)return;const body=byId("chatDraft").value.trim();if(!body)return;
    try{await communicate("send",{client_id:crypto.randomUUID(),recipient_id:state.chatPeer,body});byId("chatDraft").value="";await refreshCommunication();toast("تم إرسال الرسالة.")}catch(err){toast(err.message,true)}
  });
  byId("markNotificationsBtn").addEventListener("click",async()=>{
    const through=state.notifications[0]?.id;if(!through)return;try{await communicate("read_all",{through});await refreshCommunication();}catch(err){toast(err.message,true)}
  });

  document.body.addEventListener("click",async e=>{
    const btn=e.target.closest("button"); if(!btn)return;
    if(btn.dataset.requestManage){
      const r=state.requests.find(x=>x.id===btn.dataset.requestManage);if(!r)return;
      byId("manageRequestId").value=r.id;byId("manageRequestStatus").value=r.status;byId("manageRequestDue").value=r.execution_due_at?isoLocal(r.execution_due_at):"";byId("manageRequestResponse").value=r.response||"";open("requestManageDialog");return;
    }
    if(btn.dataset.requestDelete){
      const r=state.requests.find(x=>x.id===btn.dataset.requestDelete);if(!r)return;
      if(!confirm(`حذف الطلب/الشكوى «${r.title}»؟ سيختفي من الجدول ويظل الحذف محفوظًا في الـLog.`))return;
      try{await action("delete_request",{id:r.id});toast("تم حذف الطلب/الشكوى وحفظ العملية في الـLog.")}catch(err){toast(err.message,true)}return;
    }
    if(btn.dataset.chatPeer){state.chatPeer=btn.dataset.chatPeer;await refreshCommunication();return;}
    if(btn.dataset.notice){const n=state.notifications.find(x=>String(x.id)===btn.dataset.notice);if(n){try{await communicate("read_notification",{id:n.id});await refreshCommunication();}catch(err){toast(err.message,true)}}return;}
    if(btn.dataset.userReset){
      const p=person(btn.dataset.userReset); if(!p)return;
      if(!confirm(`Reset password لـ ${p.name} إلى 123456؟`))return;
      try{await accountAction({action:"reset_password",user_id:p.id});toast(`تم Reset Password لـ ${p.name} إلى 123456.`);await refreshState()}catch(err){toast(err.message,true)}return;
    }
    if(btn.dataset.userEdit){
      const p=person(btn.dataset.userEdit);if(!p)return;
      const name=prompt("الاسم:",p.name);if(name===null)return;
      const shown=roleName(p.role);
      const entered=prompt("Job Title: CEO / Team Leader / Project Manager / Designer",shown);if(entered===null)return;
      const roleMap={"ceo":"ceo","CEO":"ceo","team leader":"team_leader","Team Leader":"team_leader","project manager":"coordinator","Project Manager":"coordinator","designer":"employee","Designer":"employee"};
      const role=roleMap[String(entered).trim()]||roleMap[String(entered).trim().toLowerCase()];
      if(!role){toast("اكتب CEO أو Team Leader أو Project Manager أو Designer.",true);return;}
      const active=confirm("OK = Active / Cancel = Disabled");
      try{await accountAction({action:"update_user",user_id:p.id,name,role,active});toast("تم تحديث الحساب.");await refreshState()}catch(err){toast(err.message,true)}return;
    }
    const act=btn.dataset.act,id=btn.dataset.task;if(!act||!id)return;const t=taskById(id);if(!t)return;
    try{
      if(act==="assign"){
        byId("assignTaskId").value=t.id;const current=new Set(activeAssignments(t).map(a=>a.user_id));
        byId("assignUsers").innerHTML=state.profiles.filter(p=>p.active).map(p=>`<label class="check-row"><input type="checkbox" value="${p.id}" ${current.has(p.id)?"checked":""}><span><b>${esc(p.name)}</b><small class="muted">${esc(p.username)}</small></span></label>`).join("");open("assignDialog");
      }else if(act==="edit"){
        byId("taskId").value=t.id;byId("taskDialogTitle").textContent="تعديل Task";byId("taskTitle").value=t.title;byId("taskBrief").value=t.brief;byId("taskDrive").value=t.drive_url||"";byId("taskDue").value=isoLocal(t.due_at);open("taskDialog");
      }else if(act==="start"){await action("start",{task_id:t.id,version:t.version,assignment_id:btn.dataset.a});toast("بدأ التايمر.")}
      else if(act==="pause"){await action("pause",{task_id:t.id,version:t.version,assignment_id:btn.dataset.a});toast("تم إيقاف التايمر.")}
      else if(act==="resume"){await action("resume",{task_id:t.id,version:t.version,assignment_id:btn.dataset.a});toast("تم استكمال التايمر.")}
      else if(act==="submit"){byId("submitTaskId").value=t.id;byId("submitAssignmentId").value=btn.dataset.a;byId("submissionUrl").value="";byId("submissionDelay").value="";open("submitDialog")}
      else if(act==="approve"){if(confirm("اعتماد التسليم نهائيًا؟")){await action("approve",{task_id:t.id,version:t.version});toast("تم اعتماد التسليم.")}}
      else if(act==="delete"){if(confirm("حذف التاسك؟ سيختفي من القوائم ويظل السجل محفوظًا.")){await action("delete_task",{task_id:t.id,version:t.version});toast("تم حذف التاسك.")}}
      else if(act==="revision"){byId("revisionTaskId").value=t.id;byId("revisionNote").value="";byId("revisionDue").value=isoLocal(Date.now()+24*3600*1000);open("revisionDialog")}
    }catch(err){toast(err.message,true)}
  });

  setInterval(updateTimers,1000);
  // CLEAN V2: service worker intentionally disabled to prevent stale Studio builds.
  SB.auth.getSession().then(({data})=>{if(!data.session){byId("loginOverlay").classList.remove("hidden")}});
})();
