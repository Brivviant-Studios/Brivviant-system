import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {validateTaskInput,validateDistribution,transitionAssignment,elapsedMs,validateApproval,validateRevision,type Actor,type Assignment,type Task} from '../lib/workflow.ts';
const ceo:Actor={id:'ceo',role:'ceo'},emy:Actor={id:'emy',role:'coordinator'},employee:Actor={id:'oscar',role:'employee'};
const assignment=():Assignment=>({userId:'oscar',status:'assigned',accumulatedMs:0,runningSince:null,firstStartedAt:null,submittedAt:null,submissionUrl:null,delayReason:null});
const task=(a=assignment()):Task=>({id:'1',approved:false,dueAt:10000,assignments:[a]});
test('mandatory deadline and Drive link; employee cannot create',()=>{
 const input={title:'بوث',brief:'تصميم جناح',driveUrl:'https://drive.google.com/folder/test',dueAt:10000};
 assert.equal(validateTaskInput(emy,input,0),input);assert.throws(()=>validateTaskInput(employee,input,0));
 assert.throws(()=>validateTaskInput(emy,{...input,dueAt:NaN},0));
 assert.throws(()=>validateTaskInput(emy,{...input,driveUrl:'https://drive.google.com.evil.example/test'},0));
});
test('only CEO distributes, at least one valid employee',()=>{
 assert.throws(()=>validateDistribution(emy,['oscar'],['oscar']));assert.throws(()=>validateDistribution(ceo,[],['oscar']));
 validateDistribution(ceo,['oscar','youssef'],['oscar','youssef']);
});
test('each assigned member controls only their own timer and first start remains fixed',()=>{
 let a=assignment();const t=task(a);assert.throws(()=>transitionAssignment({...employee,id:'youssef'},t,a,'start',100));
 a=transitionAssignment(employee,t,a,'start',100);assert.equal(a.firstStartedAt,100);
 assert.throws(()=>transitionAssignment(ceo,t,a,'pause',1000));
 a=transitionAssignment(employee,t,a,'pause',1000);assert.equal(elapsedMs(a,5000),900);
 a=transitionAssignment(employee,t,a,'resume',5000);assert.equal(a.firstStartedAt,100);assert.equal(elapsedMs(a,5500),1400);
});
test('late submission requires reason and timer freezes while in review',()=>{
 let a=assignment();const t=task(a);a=transitionAssignment(employee,t,a,'start',100);
 assert.throws(()=>transitionAssignment(employee,t,a,'submit',11000,{submissionUrl:'https://drive.google.com/test'}));
 a=transitionAssignment(employee,t,a,'submit',11000,{submissionUrl:'https://drive.google.com/test',delayReason:'عطل في الجهاز'});
 assert.equal(a.status,'submitted');assert.equal(elapsedMs(a,50000),10900);
 assert.throws(()=>transitionAssignment(employee,t,a,'submit',12000,{submissionUrl:'https://drive.google.com/test',delayReason:'سبب'}));
});
test('approval awaits everyone and is CEO-only; revision has new deadline',()=>{
 const a={...assignment(),status:'submitted' as const};assert.throws(()=>validateApproval(emy,task(a)));
 assert.throws(()=>validateApproval(ceo,{...task(a),assignments:[a,{...assignment(),userId:'youssef'}]}));validateApproval(ceo,task(a));
 assert.throws(()=>validateRevision(emy,'تعديل',200,100));assert.throws(()=>validateRevision(ceo,'تعديل',99,100));
});
