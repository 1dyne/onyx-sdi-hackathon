const {JSDOM,VirtualConsole,ResourceLoader}=require('jsdom');
const {indexedDB}=require('fake-indexeddb');
const fs=require('node:fs');
const path=require('node:path');
const errors=[];
const vc=new VirtualConsole();
vc.on('jsdomError',e=>{if(!/Could not parse CSS stylesheet|Not implemented: HTMLCanvasElement|Not implemented: navigation/.test(e.message))errors.push(e.message);});
class LocalResources extends ResourceLoader{fetch(url,options){if(!url.startsWith('http://127.0.0.1:8902/'))return null;return Promise.resolve(fs.readFileSync(path.join(__dirname,'..',new URL(url).pathname)));}}
(async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{url:'http://127.0.0.1:8902/index.html?nosw=1',resources:new LocalResources(),runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){w.indexedDB=indexedDB;w.URL.createObjectURL=()=> 'blob:qa';w.URL.revokeObjectURL=()=>{};}});
 await new Promise(r=>dom.window.addEventListener('load',r,{once:true}));
 const w=dom.window;
 w.document.body.insertAdjacentHTML('beforeend','<button id="run">run</button><pre id="result">Ready</pre>');
 let html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
 let script=html.match(/<script>([\s\S]*)<\/script>/)[1];
 script=script.replace("const frame=document.getElementById('appframe'), output=document.getElementById('result');","const frame={contentWindow:window}, output=document.getElementById('result');");
 script=script.replace("assert(!d.documentElement.scrollWidth||d.documentElement.scrollWidth<=360,'no horizontal overflow at 360px');",'');
 w.eval(script);w.document.getElementById('run').click();
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){await new Promise(r=>setTimeout(r,500));const out=w.document.getElementById('result').textContent;if(/ALL CHECKS PASSED|FAIL /.test(out)){console.log(out);console.log('Runtime errors:',JSON.stringify(errors));dom.window.close();process.exit(/FAIL /.test(out)||errors.length?1:0);}}
 console.log(w.document.getElementById('result').textContent);dom.window.close();throw Error('QA timed out');
})().catch(e=>{console.error(e);process.exit(1);});
