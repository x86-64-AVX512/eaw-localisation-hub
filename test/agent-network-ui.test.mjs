import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Agent WinForms stays responsive during offline requests, handles status and discards stale replies', {skip:process.platform!=='win32'},async context=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'eaw-ui-network-'));
  context.after(()=>fs.rm(root,{recursive:true,force:true}));
  let mode='stall';const sockets=new Set(),counts=new Map(),bodies=new Map();
  const server=http.createServer((request,response)=>{
    const key=mode+request.url;counts.set(key,(counts.get(key)??0)+1);
    if(request.url==='/fixture-post'){
      let body='';request.on('data',value=>body+=value);request.on('end',()=>bodies.set(key,JSON.parse(body)));
      if(mode==='post-stall')return;
      response.writeHead(200,{'Content-Type':'application/json'});response.end('{}');return;
    }
    if(mode==='stall'||mode==='close-path'||mode==='cancel')return;
    if(mode==='body-stall'){response.writeHead(200,{'Content-Type':'application/json'});response.write('{');return;}
    const send=()=>{
      if(request.url==='/health'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({version:'0.8.9F1',protocol:21}));}
      else if(mode==='auth-stall')return;
      else if(mode==='unauthorized'||mode==='unavailable'){response.writeHead(mode==='unauthorized'?401:503,{'Content-Type':'application/json'});response.end('{}');}
      else{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({user:{displayName:'Fixture',temporaryPassword:false}}));}
    };
    if(mode==='stale')setTimeout(send,120);else send();
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  context.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  for(mode of ['stall','auth-stall','body-stall','unauthorized','unavailable','healthy','close-path','stale','cancel','post','post-stall'])await context.test(mode,async()=>{
    const output=path.join(root,mode+'.json');
    const script=fileURLToPath(new URL('../scripts/verify-agent-network.ps1',import.meta.url));
    const child=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script,'-Port',String(server.address().port),'-Case',mode,'-ResultPath',output],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',value=>stderr+=value);
    const timer=setTimeout(()=>child.kill(),10000);
    const code=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timer);
    assert.equal(code,0,stderr);
    const result=JSON.parse(await fs.readFile(output,'utf8'));
    assert.equal(result.error,'',result.error);assert.equal(result.checking,false);assert.equal(result.pending,0);
    assert.ok(result.pulses>10,JSON.stringify(result));assert.ok(result.maxGapMs<500,JSON.stringify(result));
    assert.equal(result.tokenRed,mode==='unauthorized',JSON.stringify(result));
    assert.equal(result.tokenConfirmed,['healthy','post','post-stall'].includes(mode),JSON.stringify(result));
    if(mode==='healthy'){
      assert.match(result.tokenStatus,/Fixture/u,JSON.stringify(result));
      assert.deepEqual(result.failures,[]);
    }
    if(mode==='auth-stall'||mode==='unavailable')assert.equal(counts.get(mode+'/api/auth/me'),1);
    if(mode==='post'||mode==='post-stall'){
      assert.equal(result.postComplete,true,JSON.stringify(result));
      assert.equal(counts.get(mode+'/fixture-post'),1,'writes are never retried automatically');
      assert.deepEqual(bodies.get(mode+'/fixture-post'),{password:'original-fixture-value'});
      if(mode==='post')assert.equal(result.postStatus,'saved');
      else assert.match(result.postStatus,/не подтверждено/u);
    }
    if(mode==='close-path')assert.ok(result.stopMs<150,JSON.stringify(result));
    if(mode==='stale')assert.equal(counts.get(mode+'/api/auth/me'),undefined);
    assert.ok((counts.get(mode+'/health')??0)<=1,'state probes must not overlap');
    if(mode!=='cancel')assert.equal(counts.get(mode+'/health'),1,'fixture must reach the real HTTP server');
    for(const socket of sockets)socket.destroy();
  });
});

test('the Review launcher reports its own failure instead of claiming success', {skip:process.platform!=='win32'},async context=>{
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'eaw-review-launch-'));
  context.after(()=>fs.rm(scratch,{recursive:true,force:true}));
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '${path.join(root,'test','fixtures','review-launch.ps1')}' -Root '${root}' -Scratch '${scratch}'`],{windowsHide:true});
  let output='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
  const code=await new Promise(resolve=>child.on('close',resolve));
  assert.equal(code,0,output);
  const [failed,succeeded]=output.trim().split(/\r?\n/u).map(line=>JSON.parse(line));
  assert.deepEqual(failed,{exit:1,status:'Ошибка запуска Review: Desktop Agent did not start in time. Open Agent to inspect its setup error.',pending:false});
  assert.deepEqual(succeeded,{exit:0,status:'Review запущен.',pending:false});
});
