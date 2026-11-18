import fs from 'node:fs'; import path from 'node:path';
const [src, sid, outDir] = process.argv.slice(2);
const NEW = 'b7e1c0de-0000-4000-8000-000000000001';
const reps = [[/\/private\/tmp\/claude-[0-9]+\/-private-tmp-squad-plugin-lab-live/g,'/tmp/claude/-work-demo'],[/-private-tmp-squad-plugin-lab-live/g,'-work-demo'],[/\/private\/tmp\/squad-plugin-lab\/live/g,'/work/demo'],[/\/tmp\/squad-plugin-lab\/live/g,'/work/demo'],[/\/Users\/[a-z0-9_-]+/gi,'/home/user'],[/[\w.+-]+@[\w-]+\.[\w.]+/g,'user@example.com'],[new RegExp(sid.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'),NEW]];
const clip = (s,n=400)=>{ s=String(s); for (const [r,v] of reps) s=s.replace(r,v); return s.length>n? s.slice(0,n)+'…':s; };
const deep = (v)=> typeof v==='string'? clip(v,600) : Array.isArray(v)? v.map(deep) : v&&typeof v==='object'? Object.fromEntries(Object.entries(v).map(([k,x])=>[k,deep(x)])) : v;
function content(c){ if (typeof c==='string') return clip(c,1500); if(!Array.isArray(c)) return c;
  return c.filter(b=>b.type!=='thinking'&&b.type!=='redacted_thinking').map(b=>{
    if(b.type==='text') return {type:'text',text:clip(b.text,600)};
    if(b.type==='tool_use') return {type:'tool_use',id:b.id,name:b.name,input:deep(b.input)};
    if(b.type==='tool_result') return {type:'tool_result',tool_use_id:b.tool_use_id,...(b.is_error?{is_error:true}:{}),content:typeof b.content==='string'?clip(b.content):content(b.content)};
    return {type:b.type}; }); }
function line(m){
  const base={type:m.type,timestamp:m.timestamp,sessionId:NEW};
  if(m.agentId) base.agentId=m.agentId;
  if(m.type==='assistant') return {...base,message:{role:'assistant',model:m.message?.model,content:content(m.message?.content)}};
  if(m.type==='user'){ const o={...base}; for(const k of ['promptSource','isMeta']) if(m[k]!==undefined)o[k]=m[k];
    if(m.origin) o.origin={kind:m.origin.kind};
    o.message={role:'user',content:content(m.message?.content)};
    const r=m.toolUseResult; if(r&&typeof r==='object'&&!Array.isArray(r)){ const k=['status','isAsync','agentId','agentType','description','totalDurationMs','totalTokens','totalToolUseCount']; o.toolUseResult=Object.fromEntries(k.filter(x=>r[x]!==undefined).map(x=>[x,deep(r[x])])); if(Array.isArray(r.content)) o.toolUseResult.content=content(r.content);}
    return o; }
  if(m.type==='attachment'){ const a=m.attachment; if(a.type!=='hook_success') return null; return {...base,attachment:{type:a.type,hookName:a.hookName,hookEvent:a.hookEvent,toolUseID:a.toolUseID,stdout:''}}; }
  if(m.type==='system'&&m.subtype==='stop_hook_summary') return {...base,subtype:m.subtype,hookCount:m.hookCount,hookErrors:[]};
  return null; }
const read=f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const dir=path.join(outDir,'projects','-work-demo'); fs.mkdirSync(path.join(dir,NEW,'subagents'),{recursive:true});
const mainLines=read(path.join(src,sid+'.jsonl')).map(line).filter(Boolean);
// one unknown line type, as a later Claude Code release might add
mainLines.splice(3,0,{type:'future-line-type',timestamp:mainLines[2].timestamp,sessionId:NEW,payload:{secret:'must not be shown'}});
fs.writeFileSync(path.join(dir,NEW+'.jsonl'),mainLines.map(l=>JSON.stringify(l)).join('\n')+'\n');
for(const f of fs.readdirSync(path.join(src,sid,'subagents'))){
  const p=path.join(src,sid,'subagents',f), o=path.join(dir,NEW,'subagents',f);
  if(f.endsWith('.meta.json')){ const m=JSON.parse(fs.readFileSync(p,'utf8')); fs.writeFileSync(o,JSON.stringify(deep(m))+'\n'); }
  else fs.writeFileSync(o,read(p).map(line).filter(Boolean).filter(l=>l.type==='assistant'||l.type==='user').map(l=>JSON.stringify(l)).join('\n')+'\n');
}
