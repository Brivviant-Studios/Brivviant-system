# Brivviant Studio — Realtime Task System

هذه النسخة مربوطة مباشرة بمشروع Supabase الحالي **Studio**:
`viwaclirvokwoeqqivgr`

## التشغيل السريع
1. فك الضغط.
2. شغّل `START_WINDOWS.bat` على Windows، أو:
   `python -m http.server 8080`
3. افتح:
   `http://localhost:8080`

يمكن نشر نفس الملفات على Netlify / Vercel Static / GitHub Pages / أي Static Hosting.

## الحسابات الموجودة حاليًا
- `mohamed.zidan` — CEO
- `mohamed.farouk` — CEO
- `seif.akram` — CEO
- `emy` — Project Manager
- `oscar` — Designer
- `youssef` — Designer

كلمات المرور لا يتم تخزينها أو تصديرها داخل الـZIP. هي موجودة في Supabase Auth.
الـCEO يقدر يعمل Reset Password لأي حساب من شاشة **Team**.

## الصلاحيات المؤكدة
### CEO
- يرى جميع التاسكات.
- يوزع التاسك على موظف أو أكثر.
- يوقف ويستكمل Timer لأي موظف.
- يعتمد التسليم.
- يطلب Revision بموعد جديد.
- يعدل التاسك.
- يرى كل Requests / Complaints ويرد عليها.
- يدير الحسابات ويعمل Reset Password.
- يرى Activity Log.

### EMY / Project Manager
- تدخل Tasks جديدة.
- ترى التاسكات والإدارة التشغيلية.
- لا توزع Tasks.
- لا توقف Timers.
- لا تعتمد التسليم ولا تطلب Revision.
- لا تدير الحسابات.

### Designer
- يرى فقط Tasks الموزعة عليه.
- يبدأ التاسك بزر **بدء المشروع**.
- Timer يبدأ من السيرفر، وليس من ساعة الجهاز.
- لا يستطيع Pause لنفسه؛ Pause/Resume للـCEO فقط.
- يسلم عبر Google Drive Link.
- لو Deadline عدى: سبب التأخير إجباري.
- يرى Requests الخاصة به فقط.

## دورة التاسك
Create → Assign → Designer Start → Live Timer → Submit → CEO Approve
أو:
Submit → CEO Request Revision → Round جديد → Start → Submit → Approve

كل Action يرفع `version` للتاسك لتقليل تعارض التعديلات المتزامنة.

## Realtime
الواجهة مشتركة Live عبر Supabase Realtime على:
- `bv_profiles`
- `bv_tasks`
- `bv_assignments`
- `bv_requests`
- `bv_activity`

## الأمان
- الواجهة تحتوي فقط على **Publishable key**، وهو مصمم للـBrowser مع RLS.
- لا يوجد Service Role Key داخل ملفات الواجهة.
- إدارة الحسابات تتم داخل Edge Function.
- RLS يحدد ما يراه كل مستخدم.
- كلمات المرور يديرها Supabase Auth.
- الحسابات الجديدة تُجبر على تغيير كلمة المرور المؤقتة.

## الملفات
- `index.html` — الواجهة
- `style.css` — الهوية والـresponsive layout
- `app.js` — Auth / Tasks / Timers / Realtime / Roles
- `config.js` — Project URL + Publishable Key فقط
- `assets/brivviant-logo.png` — الشعار الأصلي
- `database/full_install.sql` — مرجع تثبيت على مشروع Supabase جديد
- `database/20260923_fix_assignment_round_activity.sql` — إصلاح Revision rounds (مطبق على المشروع الحالي)
- `database/verification.sql` — فحوصات Read-only
- `supabase/functions/brivviant-accounts/index.ts` — إدارة الحسابات الآمنة

## مهم
`database/full_install.sql` مخصص لمشروع جديد فقط. **لا تشغله على Studio الحالي** لأن الـBackend الحالي موجود بالفعل.


## Job Titles in V3
واجهة النظام تعرض الوظائف كالتالي:
- CEO
- Project Manager
- Designer

للتوافق مع الـBackend الحالي:
- Project Manager = `coordinator`
- Designer = `employee`

هذا mapping داخلي فقط، والمستخدم يرى المسميات الجديدة في الـPanel.

## Passwords
- النظام الآن يسمح بكلمات مرور تبدأ من 6 أحرف.
- كل حساب يمكنه تغيير كلمة مروره من داخل النظام.
- الـCEO يستطيع Reset Password لحسابات الفريق من Team.
- كلمة المرور `123456` مقبولة فنيًا في النظام الحالي.
