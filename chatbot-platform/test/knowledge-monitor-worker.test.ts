import { test,after } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeMonitor } from '../src/engine/knowledge-monitor.js';
import { config } from '../src/config.js';
import {pool} from '../src/db.js';
after(async()=>pool.end());
test('el apagado espera la revisión en curso y evita nuevas revisiones',async()=>{
 const previous=config.knowledgeMonitor.enabled;config.knowledgeMonitor.enabled=true;
 let calls=0,release:any;
 const monitor=new KnowledgeMonitor(async()=>{calls++;return new Promise(resolve=>{release=resolve;});},10);
 try {
  monitor.start();monitor.start();assert.equal(calls,1);
  let drained=false;
  const closing=monitor.stop().then(()=>{drained=true;});
  await Promise.resolve();assert.equal(drained,false);
  release({checked:1,failed:0});await closing;
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(drained,true);assert.equal(calls,1);
 }finally{config.knowledgeMonitor.enabled=previous;await monitor.stop();}
});
test('desactivar supervisión no inicia una revisión automática',async()=>{
 const previous=config.knowledgeMonitor.enabled;config.knowledgeMonitor.enabled=false;
 let calls=0;
 const monitor=new KnowledgeMonitor(async()=>{calls++;return {checked:0,failed:0};},10);
 try{monitor.start();await monitor.stop();assert.equal(calls,0);}
 finally{config.knowledgeMonitor.enabled=previous;}
});
