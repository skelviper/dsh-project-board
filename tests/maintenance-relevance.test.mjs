// 产品相关性回归：发现文件只是线索，不能把真实项目变成目录清单。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeBoard } from '../schema.mjs';
import { BoardService } from '../service.mjs';
import { mergeBoardContent, maintenanceScanRoots, withdrawImportedNodes } from '../maintenance.mjs';
import { discoverBoardContent } from '../maintenance-files.mjs';

const discovered = paths => ({ candidates: paths.map(p => ({path:p,kind:'component',title:path.posix.basename(p),summary:'A historical process record',fingerprint:p})),warnings:[],truncated:false });
function memoryBoard() { return normalizeBoard({nodes:[{id:'fig1',kind:'figure',title:'方法总览',summary:'已有项目概览',links:[{kind:'dir',path:'main/fig1'}]}]}, {workspacePath:'/tmp/relevance-memory'}); }

test('138个旧执行目录和文档仅成为线索，原节点/任务/状态完全不变', () => {
  const board=memoryBoard(), original=structuredClone(board);
  const paths=Array.from({length:138},(_,i)=>`analysis/20261014-gpt61-features-run${i}`);
  const result=mergeBoardContent(board,discovered(paths));
  assert.equal(result.counts.added,0);assert.equal(result.counts.staged,138);
  assert.deepEqual(board.nodes,original.nodes);assert.deepEqual(board.tasks,original.tasks);assert.deepEqual(board.todos,original.todos);
  assert.equal(board.maintenance.candidates.length,138);assert.equal(board.maintenance.sources.length,0);
  mergeBoardContent(board,discovered(paths));assert.equal(board.maintenance.candidates.length,138);assert.equal(board.nodes.length,1);
});

test('默认范围只来自关联活动入口，主题根目录、归档、公共数据与源码根不扩扫', () => {
  const board=memoryBoard();
  board.nodes.push({id:'theme',kind:'theme',links:[{kind:'dir',path:'.'},{kind:'dir',path:'main'}]}, {id:'old',kind:'historical',links:[{kind:'dir',path:'analysis/old'}]}, {id:'data',kind:'infra',links:[{kind:'dir',path:'data'}]}, {id:'code',kind:'infra',links:[{kind:'dir',path:'snp_free_recon'}]});
  board.tasks.push({id:'task',nodeId:'fig1',status:'doing',artifacts:[{kind:'dir',path:'main/experiments/runs/MP005'}]});
  assert.deepEqual(maintenanceScanRoots(board),['main/fig1','main/experiments/runs/MP005']);
  assert.equal(board.maintenance.scope,'linked');assert.deepEqual(board.maintenance.roots,[]);
});

test('撤回只影响原始自动导入，保留文件意图与原任务，并阻止再次导入', () => {
  const board=memoryBoard();board.tasks.push({id:'task',nodeId:'fig1',title:'原有任务',status:'doing'});
  mergeBoardContent(board,discovered(['analysis/old-run']),{allowImport:true});
  const id=board.nodes.find(n=>n.id.startsWith('disk-')).id;
  const beforeTask=structuredClone(board.tasks);
  const result=withdrawImportedNodes(board,[id]);assert.equal(result.withdrawn,1);
  assert.deepEqual(board.tasks,beforeTask);assert.equal(board.nodes.length,1);
  assert.equal(board.maintenance.deletions[0].status,'retained');assert.deepEqual(board.maintenance.deletions[0].paths,[]);
  mergeBoardContent(board,discovered(['analysis/old-run']));assert.equal(board.nodes.length,1);assert.equal(board.maintenance.candidates.length,0);
});

test('自动项已经被人工改写或加任务时拒绝整批撤回', () => {
  const board=memoryBoard();mergeBoardContent(board,discovered(['a','b']),{allowImport:true});
  const imported=board.nodes.filter(n=>n.id.startsWith('disk-'));imported[1].summary='人工重要修改';
  const before=JSON.stringify(board);
  assert.throws(()=>withdrawImportedNodes(board,imported.map(n=>n.id)),{code:'WITHDRAWAL_CHANGED'});
  assert.equal(JSON.stringify(board),before);
});

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pb-relevance-'));
  t.after(async()=>{assert.match(path.basename(root),/^pb-relevance-/);await fs.rm(root,{recursive:true,force:true});});
  const put=async(p,text)=>{await fs.mkdir(path.dirname(path.join(root,p)),{recursive:true});await fs.writeFile(path.join(root,p),text);};
  await put('main/fig1/README.md','# Figure one\n\nCurrent figure description.\n');
  await put('main/fig1/QA.md','# Figure QA\n\nReview evidence for the existing figure.\n');
  await put('analysis/20261014-gpt61-features-run2/README.md','# Old runner\n\nHistorical SDK execution.\n');
  const service=new BoardService({ctx:{workspaceRegistry:{list:()=>[{id:'ws',path:root,title:'Project'}]},agents:{list:()=>[]},jobs:{list:()=>[]}}});
  await service.create({workspacePath:root});
  await service.command({workspacePath:root,action:'upsert_node',input:{node:{id:'fig1',kind:'figure',title:'方法总览',summary:'用户概览',links:[{path:'main/fig1',kind:'dir'}]}}});
  const maintain=(operation,args={})=>service.maintain({workspacePath:root,operation,...args});
  return {root,put,service,maintain};
}

test('真实目录fixture默认不进入analysis旧SDK，只收集Fig1资料且不添加卡片', async t => {
  const f=await fixture(t),result=await f.maintain('scan');
  assert.equal(result.board.nodes.length,1);assert.equal(result.board.nodes[0].title,'方法总览');assert.equal(result.board.nodes[0].summary,'用户概览');
  assert.ok(result.board.maintenance.candidates.some(c=>c.path==='main/fig1/QA.md'));
  assert.equal(result.board.maintenance.candidates.some(c=>c.path.startsWith('analysis/')),false);
});

test('Lead把资料接到已有任务后，下一次检查识别关联而不建重复节点', async t => {
  const f=await fixture(t);await f.maintain('scan');
  await f.service.command({workspacePath:f.root,action:'upsert_task',input:{task:{id:'review',nodeId:'fig1',title:'核验图版',artifacts:[{kind:'file',path:'main/fig1/QA.md'}]}}});
  const result=await f.maintain('scan');
  assert.equal(result.board.nodes.length,1);assert.equal(result.board.tasks.length,1);
  const candidate=result.board.maintenance.candidates.find(c=>c.path==='main/fig1/QA.md');
  assert.equal(candidate.status,'linked');assert.equal(candidate.targetId,'review');assert.equal(candidate.targetType,'task');
});

test('忽略无关线索在重扫和内容变化后仍保留决定，文件不被删除', async t => {
  const f=await fixture(t);await f.maintain('scan');
  await f.maintain('dismiss',{paths:['main/fig1/QA.md'],message:'已在当前任务中核验，无需新工作项'});
  await f.put('main/fig1/QA.md','# Updated QA\n\nUpdated evidence.\n');
  const result=await f.maintain('scan');
  assert.equal(result.board.maintenance.candidates.find(c=>c.path==='main/fig1/QA.md').status,'dismissed');
  assert.match(await fs.readFile(path.join(f.root,'main/fig1/QA.md'),'utf8'),/Updated evidence/);
  assert.equal(result.board.nodes.length,1);
});

test('显式范围才检查额外目录，空配置恢复关联范围；日期run名不被推断为科学实验', async t => {
  const f=await fixture(t);await f.maintain('configure',{roots:['analysis']});
  const result=await f.maintain('scan');assert.equal(result.board.nodes.length,1);
  assert.ok(result.board.maintenance.candidates.some(c=>c.path.startsWith('analysis/')));
  const disk=await discoverBoardContent(f.root,{roots:['analysis']});assert.equal(disk.candidates[0].kind,'component');
  await f.maintain('configure',{roots:[]});const state=await f.maintain('state');
  assert.equal(state.board.maintenance.scope,'linked');assert.deepEqual(state.board.maintenance.roots,[]);
});
