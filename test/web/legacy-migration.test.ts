import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { legacyIds, legacySourceId, migrateLegacyStorage } from '../../web/src/legacyMigration.ts';
import { eventId } from '../../web/src/federation.ts';
import ts from 'typescript';

const sources = [{id:'runner-a',view_index:2,legacy_project_ids:['old-project'],legacy_task_ids:['old-task'],
  legacy_approval_ids:['old-approval'],legacy_question_ids:['old-question']}];

function storage(initial:Record<string,unknown>) {
  const rows = new Map(Object.entries(initial).map(([k,v])=>[k,JSON.stringify(v)]));
  return {
    getItem:(k:string)=>rows.get(k)??null,
    setItem:(k:string,v:string)=>{rows.set(k,v);},
    read:(k:string)=>JSON.parse(rows.get(k)??'null'),
    raw:rows,
  };
}

test('migration keeps pins, filters, view order, drafts, selections and notification references',()=>{
  const s=storage({
    'agent-desk.columns.v2':[{id:'pin',title:'old',filter:{taskIds:['old-task','w:runner-a:old-task'],projectIds:['old-project']}}],
    'agent-desk.viewByTask':{'v:t:old-task':false,'v:t:w:runner-a:old-task':true,'v:p:old-project':false},
    'agent-desk.viewOrder':{project:['v:p:old-project','v:p:w:runner-a:old-project','v:p:other']},
    'agent-desk.columnWidths':{'v:t:old-task':450,'v:t:w:runner-a:old-task':500},
    'agent-desk.threadReferences':{'old-task':{ids:[3,4],open:true},other:{ids:[3],open:true}},
    'agent-desk.drafts.v1':{
      'reply:old-task':{taskId:'old-task',value:'keep',at:5},
      'question:old-question':{taskId:'old-task',value:'answer',at:5},
      'ask:old-approval':{taskId:'old-task',value:'yes',at:5},
      'handoff:old-task':{taskId:'old-task',value:{picked:[4],after:6,summary:'keep'},at:5},
    },
    'agent-desk.notified':{'done:old-task:time':7,'approval:old-approval':8,'ask:3':9},
  });
  s.raw.set('agent-desk.location','runner:runner-a');
  assert.equal(migrateLegacyStorage(s,sources),true);
  const scoped='w:runner-a:old-task';
  assert.deepEqual(s.read('agent-desk.columns.v2')[0].filter,{taskIds:[scoped],projectIds:['w:runner-a:old-project']});
  assert.equal(s.read('agent-desk.viewByTask')[`v:t:${scoped}`],true);
  assert.deepEqual(s.read('agent-desk.viewOrder').project,['v:p:w:runner-a:old-project','v:p:other']);
  assert.equal(s.read('agent-desk.columnWidths')[`v:t:${scoped}`],500);
  assert.deepEqual(s.read('agent-desk.threadReferences')[scoped],{ids:[eventId(2,3),eventId(2,4)],open:true});
  assert.deepEqual(s.read('agent-desk.threadReferences').other,{ids:[3],open:true});
  const drafts=s.read('agent-desk.drafts.v1');
  assert.equal(drafts[`reply:${scoped}`].value,'keep');
  assert.equal(drafts['question:w:runner-a:old-question'].taskId,scoped);
  assert.equal(drafts['ask:w:runner-a:old-approval'].taskId,scoped);
  assert.deepEqual(drafts[`handoff:${scoped}`].value.picked,[eventId(2,4)]);
  assert.equal(drafts[`handoff:${scoped}`].value.after,eventId(2,6));
  assert.equal(s.read('agent-desk.notified')[`done:${scoped}:time`],7);
  assert.equal(s.read('agent-desk.notified')['ask:3'],9,'an event without its task must not be guessed');
  assert.equal(s.raw.get('agent-desk.location'),'workspace:runner-a');
  const snapshot=new Map(s.raw);
  assert.equal(migrateLegacyStorage(s,sources),false);
  assert.deepEqual(s.raw,snapshot);
});

test('a second migration handles an old tab write; ambiguous IDs and unrelated data stay untouched',()=>{
  const s=storage({'agent-desk.drafts.v1':{'reply:old-task':{taskId:'old-task',value:'first',at:1}}});
  migrateLegacyStorage(s,sources);
  s.raw.set('agent-desk.drafts.v1',JSON.stringify({
    ...s.read('agent-desk.drafts.v1'),
    'reply:old-task':{taskId:'old-task',value:'newer',at:2},
  }));
  assert.equal(migrateLegacyStorage(s,sources),true);
  assert.deepEqual(Object.keys(s.read('agent-desk.drafts.v1')),['reply:w:runner-a:old-task']);
  assert.equal(s.read('agent-desk.drafts.v1')['reply:w:runner-a:old-task'].value,'newer');
  const ids=legacyIds([...sources,{...sources[0],id:'runner-b',view_index:3}]);
  assert.equal(ids.scoped('old-task',ids.tasks),'old-task');
  assert.equal(ids.event(3,'old-task'),3);
});

test('location-only migration maps an old runner to an existing shared link and notifies other tabs',()=>{
  const s=storage({'agent-desk.drafts.v1':{'drawer-target':{value:'old-srv19',at:1}}});
  s.raw.set('agent-desk.location','runner:old-srv19');
  const merged=[{id:'existing-shared',view_index:7,legacy_runner_ids:['old-srv19']}];
  assert.equal(migrateLegacyStorage(s,merged),true);
  assert.equal(s.raw.get('agent-desk.location'),'workspace:existing-shared');
  assert.equal(s.read('agent-desk.drafts.v1')['drawer-target'].value,'existing-shared');
  assert.equal(legacySourceId('old-srv19',merged),'existing-shared');
  assert.ok(s.raw.get('agent-desk.legacyMigration.v1'),'a changed location must publish a cross-tab marker');
  const previous=s.raw.get('agent-desk.legacyMigration.v1');
  assert.equal(migrateLegacyStorage(s,merged),false);
  assert.equal(s.raw.get('agent-desk.legacyMigration.v1'),previous);
});

test('old shared URL selection moves to the merged source when no old link remains',()=>{
  const s=storage({});
  s.raw.set('agent-desk.location','workspace:old-srv19');
  const merged=[{id:'existing-shared',view_index:7,legacy_runner_ids:['old-srv19']}];
  assert.equal(migrateLegacyStorage(s,merged),true);
  assert.equal(s.raw.get('agent-desk.location'),'workspace:existing-shared');
  assert.ok(s.getItem('agent-desk.legacyMigration.v1'));
});

test('an ambiguous old runner location is not guessed',()=>{
  const s=storage({});
  s.raw.set('agent-desk.location','runner:old');
  const rows=[{id:'a',view_index:1,legacy_runner_ids:['old']},{id:'b',view_index:2,legacy_runner_ids:['old']}];
  assert.equal(migrateLegacyStorage(s,rows),false);
  assert.equal(legacySourceId('old',rows),'old');
  assert.equal(s.raw.get('agent-desk.location'),'runner:old');
  assert.equal(s.getItem('agent-desk.legacyMigration.v1'),null);
});

test('failed in-memory draft flush cancels migration; recovery keeps the newer edit',()=>{
  const s=storage({});
  let failing=true;
  const localStorage={getItem:s.getItem,setItem:(key:string,value:string)=>{
    if(failing&&key==='agent-desk.drafts.v1')throw Error('quota');
    s.setItem(key,value);
  }};
  const handlers:Record<string,(event:any)=>void>={};
  const source=readFileSync(new URL('../../web/src/drafts.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports:Record<string,any>={};
  runInNewContext(code,{exports,require:(name:string)=>name==='react'?{}:{workspaceKey:(key:string)=>key},
    addEventListener:(name:string,fn:(event:any)=>void)=>{handlers[name]=fn;},localStorage,
    setTimeout:()=>1,clearTimeout:()=>{},Date});
  exports.setDraft('reply:old-task','latest',{taskId:'old-task',empty:false});
  const event=()=>({defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}});
  const blocked=event();handlers['desk-before-legacy-migration'](blocked);
  assert.equal(blocked.defaultPrevented,true);
  assert.equal(s.getItem('agent-desk.drafts.v1'),null);
  // Another tab may have converted its own older draft while this tab still has an unsaved edit.
  s.setItem('agent-desk.drafts.v1',JSON.stringify({'reply:w:runner-a:old-task':
    {taskId:'w:runner-a:old-task',value:'older',at:1}}));
  failing=false;
  const allowed=event();handlers['desk-before-legacy-migration'](allowed);
  assert.equal(allowed.defaultPrevented,false);
  assert.equal(migrateLegacyStorage(localStorage,sources),true);
  assert.equal(s.read('agent-desk.drafts.v1')['reply:w:runner-a:old-task'].value,'latest');
  assert.equal(s.read('agent-desk.drafts.v1')['reply:old-task'],undefined);
});

test('partial storage failure leaves migration retryable and emits no completion marker',()=>{
  const s=storage({'agent-desk.columns.v2':[{id:'pin',filter:{taskIds:['old-task']}}],
    'agent-desk.drafts.v1':{'reply:old-task':{taskId:'old-task',value:'safe',at:2}}});
  let fail=true;
  const localStorage={getItem:s.getItem,setItem:(key:string,value:string)=>{
    if(fail&&key==='agent-desk.drafts.v1')throw Error('quota');
    s.setItem(key,value);
  }};
  assert.throws(()=>migrateLegacyStorage(localStorage,sources),/옮기지 못했습니다/);
  assert.equal(s.getItem('agent-desk.legacyMigration.v1'),null);
  fail=false;
  assert.equal(migrateLegacyStorage(localStorage,sources),true);
  assert.deepEqual(s.read('agent-desk.columns.v2')[0].filter.taskIds,['w:runner-a:old-task']);
  assert.equal(s.read('agent-desk.drafts.v1')['reply:w:runner-a:old-task'].value,'safe');
  assert.ok(s.getItem('agent-desk.legacyMigration.v1'));
});
