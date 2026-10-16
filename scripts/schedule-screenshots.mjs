// Schedule screen screenshots (1920x1080) for ?day=fri and ?day=sat with some games complete and one active per day.
// Run on a freshly seeded demo (seed-demo.js --reset); it changes game states, so reseed afterwards.
// Usage: [BASE_URL=http://localhost:3000] [OUT_DIR=dir] [CHROME_PATH=/usr/bin/google-chrome] node scripts/schedule-screenshots.mjs
// OUT_DIR unset: deliverables/screenshots (fri, sat) + docs/screenshots (offline); set: all three go to OUT_DIR.
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import fs from 'node:fs';
const B=(process.env.BASE_URL||'http://localhost:3000').replace(/\/+$/,'');
const OUT=process.env.OUT_DIR; if (OUT) fs.mkdirSync(OUT,{recursive:true});
const out=(def,name)=>`${OUT||def}/${name}`;
const WSB=B.replace(/^http/,'ws'); let t;
for (let i=0;i<10&&!t;i++){const r=await fetch(B+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'change-me-admin'})}); if(r.status===429){await new Promise(x=>setTimeout(x,(Number(r.headers.get('retry-after'))||5)*1000+300));continue;} t=(await r.json()).token;}
const H={authorization:'Bearer '+t,'content-type':'application/json'};
const api=async(p,o={})=>(await fetch(B+p,{...o,headers:{...H,...(o.headers||{})}})).json();
const gs=await api('/api/games');
const at=(day,time,court)=>gs.find(g=>new Date(g.scheduled_at).toLocaleString('sv-SE',{timeZone:'America/Chicago'}).slice(8,16)===`${day} ${time}`&&g.court===court);
// Complete results (never-started games: CSV status import), then one active game per day with a live score.
const fin=[[at('17','08:00','West'),24,18],[at('17','08:00','East'),12,16],[at('17','09:00','West'),20,20],[at('17','09:00','East'),14,10],[at('16','17:30','Full'),31,27]];
const csv='id,status,home_score,away_score\n'+fin.map(([g,h,a])=>`${g.id},complete,${h},${a}`).join('\n')+'\n';
console.log(JSON.stringify(await (await fetch(B+'/api/import/schedule.csv',{method:'POST',headers:{...H,'content-type':'text/csv'},body:csv})).json()));
async function live(g, court, pin, pts){
  console.log(await (await fetch(`${B}/api/games/${g.id}/start`,{method:'POST',headers:H,body:'{"force":true}'})).text());
  const ws=new WebSocket(`${WSB}/ws?court=${court}&role=score`); await new Promise(r=>ws.on('open',r));
  const send=(o)=>new Promise(r=>{const id=Math.random().toString(36).slice(2); const h=(d)=>{const m=JSON.parse(String(d)); if((m.type==='ack'||m.type==='auth')&&(m.id===id||m.type==='auth')){ws.off('message',h);r(m);}}; ws.on('message',h); ws.send(JSON.stringify({...o,id}));});
  await send({type:'auth',pin});
  for (const [team,p] of pts) await send({type:'cmd',cmd:{type:'SCORE',team,pts:p}});
  await send({type:'cmd',cmd:{type:'PERIOD',delta:1}}); await send({type:'cmd',cmd:{type:'CLOCK_START'}});
  return ws;
}
const b=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
const p=await (await b.newContext({viewport:{width:1920,height:1080}})).newPage();
const w1=await live(at('16','18:30','Full'),'full','1111',[['home',2],['home',2],['away',3],['home',2],['away',2]]);
await p.goto(B+'/upwardbasketballscores/schedule?day=fri'); await p.waitForTimeout(2500);
await p.screenshot({path:out('deliverables/screenshots','schedule-fri.png')});
const w2=await live(at('17','10:00','West'),'west','2222',[['home',2],['away',2],['home',3],['home',2],['away',1]]);
await p.goto(B+'/upwardbasketballscores/schedule?day=sat'); await p.waitForTimeout(2500);
await p.screenshot({path:out('deliverables/screenshots','schedule-sat.png')});
console.log(await p.evaluate(()=>({conn:document.documentElement.dataset.conn,page:document.documentElement.dataset.page,pages:document.documentElement.dataset.pages,off:getComputedStyle(document.documentElement).getPropertyValue('--offset'),earlier:document.querySelector('.earlier').textContent,games:document.querySelectorAll('.game').length,active:document.querySelectorAll('.game[data-state=active]').length,cheer:document.querySelectorAll('.game.has-cheer').length})));
// reduced motion + offline variants for QA evidence
await p.emulateMedia({reducedMotion:'reduce'}); await p.context().setOffline(true); await p.waitForTimeout(4500);
await p.screenshot({path:out('docs/screenshots','schedule-sat-offline.png')});
console.log('offline conn:', await p.evaluate(()=>document.documentElement.dataset.conn));
w1.close(); w2.close(); await b.close();
