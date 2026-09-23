/** Apply these business rules in authenticated server-side mutations. */
export type Role='ceo'|'team_leader'|'coordinator'|'employee';
export const TEAM=[
 {username:'mohamed.zidan',name:'Mohamed Zidan',role:'ceo'},
 {username:'mohamed.farouk',name:'Mohamed Farouk',role:'ceo'},
 {username:'seif.akram',name:'Seif Akram',role:'team_leader'},
 {username:'emy',name:'EMY',role:'coordinator'},
 {username:'oscar',name:'OSCAR',role:'employee'},
 {username:'youssef',name:'Youssef',role:'employee'},
] as const;
export type Actor={id:string;role:Role};
export type Assignment={userId:string;status:'assigned'|'working'|'paused'|'submitted';accumulatedMs:number;runningSince:number|null;firstStartedAt:number|null;submittedAt:number|null;submissionUrl:string|null;delayReason:string|null};
export type Task={id:string;approved:boolean;dueAt:number;assignments:Assignment[]};
export function requireCEO(actor:Actor){if(!['ceo','team_leader'].includes(actor.role))throw new Error('هذا الإجراء متاح للإدارة فقط.');}
export function validateDriveLink(value:string){
 try{const u=new URL(value);if(u.protocol!=='https:'||!['drive.google.com','docs.google.com'].includes(u.hostname)||u.username||u.password)throw new Error();return u.href;}
 catch{throw new Error('أدخل رابط Google Drive صحيحًا يبدأ بـ https.');}
}
export function validateTaskInput(actor:Actor,input:{title:string;brief:string;driveUrl:string;dueAt:number},now:number){
 if(!['ceo','team_leader','coordinator'].includes(actor.role))throw new Error('إضافة التاسكات متاحة للإدارة وإيمي فقط.');
 if(!input.title.trim()||input.title.length>180)throw new Error('اسم التاسك مطلوب، بحد أقصى 180 حرفًا.');
 if(!input.brief.trim())throw new Error('اكتب وصفًا للتاسك.');
 if(!Number.isFinite(input.dueAt)||input.dueAt<=now)throw new Error('اختر موعد تسليم قادمًا بالتاريخ والساعة.');
 validateDriveLink(input.driveUrl);return input;
}
export function validateDistribution(actor:Actor,userIds:string[],activeMemberIds:string[]){
 requireCEO(actor);
 if(!userIds.length||new Set(userIds).size!==userIds.length||userIds.some(id=>!activeMemberIds.includes(id)))throw new Error('اختر عضوًا مفعّلًا واحدًا على الأقل.');
}
export function elapsedMs(a:Assignment,now:number){return a.accumulatedMs+(a.runningSince===null?0:Math.max(0,now-a.runningSince));}
export function taskStatus(t:Task){
 if(t.approved)return 'approved';if(!t.assignments.length)return 'unassigned';
 if(t.assignments.every(a=>a.status==='submitted'))return 'review';
 if(t.assignments.some(a=>a.status==='working'))return 'working';
 if(t.assignments.some(a=>a.status==='paused'))return 'paused';return 'assigned';
}
export function transitionAssignment(actor:Actor,task:Task,a:Assignment,action:'start'|'pause'|'resume'|'submit',now:number,data?:{submissionUrl?:string;delayReason?:string}):Assignment{
 if(task.approved)throw new Error('التاسك معتمد بالفعل.');
 if(!task.assignments.some(x=>x.userId===a.userId))throw new Error('لم يتم توزيع التاسك على هذا الموظف.');
 if(actor.id!==a.userId)throw new Error('يمكنك بدء وإيقاف واستكمال وتسليم التكليفات المسندة إليك فقط.');
 if(action==='start'){
  if(a.status!=='assigned')throw new Error('التاسك بدأ بالفعل.');
  return {...a,status:'working',runningSince:now,firstStartedAt:a.firstStartedAt??now};
 }
 if(action==='pause'){
  if(a.status!=='working')throw new Error('التايمر غير شغال.');
  return {...a,status:'paused',accumulatedMs:elapsedMs(a,now),runningSince:null};
 }
 if(action==='resume'){
  if(a.status!=='paused')throw new Error('التايمر ليس متوقفًا.');
  return {...a,status:'working',runningSince:now};
 }
 if(!['working','paused'].includes(a.status))throw new Error('ابدأ التاسك قبل تسليمه.');
 const submissionUrl=validateDriveLink(data?.submissionUrl??'');
 if(now>task.dueAt&&!data?.delayReason?.trim())throw new Error('سبب التأخير إجباري قبل التسليم.');
 return {...a,status:'submitted',accumulatedMs:elapsedMs(a,now),runningSince:null,submittedAt:now,submissionUrl,delayReason:data?.delayReason?.trim()||null};
}
export function validateApproval(actor:Actor,task:Task){requireCEO(actor);if(taskStatus(task)!=='review')throw new Error('يجب أن يسلم كل الموظفين المسند إليهم التاسك قبل اعتماده.');}
export function validateRevision(actor:Actor,text:string,dueAt:number,now:number){requireCEO(actor);if(!text.trim())throw new Error('اكتب التعديلات المطلوبة.');if(!Number.isFinite(dueAt)||dueAt<=now)throw new Error('حدد موعد تسليم جديدًا للتعديل.');}
