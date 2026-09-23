"use client";
import {useState} from 'react';
import {supabase} from '@/lib/supabase';
import {ArrowLeft, Eye, EyeOff, LockKeyhole, UserRound} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
export default function Login(){
  const [visible,setVisible]=useState(false);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function login(e:React.FormEvent<HTMLFormElement>){
    e.preventDefault();setBusy(true);setError('');const f=new FormData(e.currentTarget);
    const username=String(f.get('username')||'').trim().toLowerCase();
    if(!/^[a-z0-9.]{3,40}$/.test(username)){setError('راجع اسم المستخدم.');setBusy(false);return;}
    const {error}=await supabase.auth.signInWithPassword({email:username+'@brivviant-team.invalid',password:String(f.get('password')||'')});
    if(error)setError('اسم المستخدم أو كلمة المرور غير صحيحة، أو حاولت مرات كتير. جرّب تاني بعد شوية.');setBusy(false);
  }
  return <main className="login-shell">
    <section className="brand-panel" aria-label="Brivviant Studios">
      <span className="brand-kicker">BRIVVIANT / TEAM WORKSPACE</span>
      <img className="brand-logo" src="brivviant-logo.png" alt="Brivviant Studios"/>
      <div className="brand-bottom"><span>مساحة الفريق</span><span>التاسكات · الوقت · التسليم</span></div>
    </section>
    <section className="login-panel"><div className="login-content">
      <div className="login-icon"><LockKeyhole size={25}/></div>
      <p className="eyebrow">BRIVVIANT STUDIOS</p><h1>أهلًا بيك في مساحة الفريق</h1>
      <p className="login-subtitle">ادخل بحسابك لمتابعة شغلك وتسليماتك.</p>
      <form onSubmit={login} className="login-form">
        <label htmlFor="username">اسم المستخدم</label>
        <div className="input-wrap"><UserRound size={19}/><Input id="username" name="username" autoComplete="username" dir="ltr" placeholder="mohamed.zidan" required disabled={busy}/></div>
        <label htmlFor="password">كلمة المرور</label>
        <div className="input-wrap"><LockKeyhole size={19}/><Input id="password" name="password" autoComplete="current-password" type={visible?'text':'password'} dir="ltr" placeholder="••••••••••••" required disabled={busy}/><button type="button" className="show-password" onClick={()=>setVisible(!visible)} aria-label={visible?'إخفاء كلمة المرور':'إظهار كلمة المرور'}>{visible?<EyeOff size={19}/>:<Eye size={19}/>}</button></div>
        <Button type="submit" className="login-submit" disabled={busy}>{busy?'جاري الدخول…':'تسجيل الدخول'} <ArrowLeft size={19}/></Button>
        {error&&<p className="setup-notice" role="alert">{error}</p>}<p className="login-help">نسيت كلمة المرور؟ تواصل مع الإدارة لإعادة تعيينها.</p>
      </form>
    </div><footer>Brivviant Studios · V6.1 <span>مساحة عمل خاصة بالفريق</span></footer></section>
  </main>;
}
