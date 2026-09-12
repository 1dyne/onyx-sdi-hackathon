/* Registration metadata and signal checks. Values are ADC counts, not force. */
const validation = (() => {
  const tasks = { sit:'의자에 앉기', stand:'의자에서 일어나기', supportL:'왼발 축 지지', supportR:'오른발 축 지지', walk:'치료사 보조 보행', other:'기타 동작' };
  const copy = value => JSON.parse(JSON.stringify(value));
  const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function defaults() {
    return { task:'sit', environment:'indoor', footwear:'none', support:'unrecorded', otherFoot:'unrecorded', baselinePosture:'seated-unloaded', goal:'', heatGain:1 };
  }
  function node(tag, cls, text) {
    const n = document.createElement(tag); if (cls) n.className=cls;
    if (text !== undefined) n.textContent=text; return n;
  }
  function form(initial = defaults()) {
    const box=node('div','card validation-form');
    box.append(node('div','section-heading','측정 조건 · 이번 기록에 함께 저장'));
    const controls={};
    const fields=[
      ['task','동작',Object.entries(tasks)],
      ['environment','환경',[['indoor','실내'],['outdoor','Outdoor · 실외']]],
      ['footwear','신발',[['none','미착용'],['shoes','착용']]],
      ['support','치료사 보조',[['unrecorded','미기록 / 확인 필요'],['none','없음'],['standby','옆에서 관찰'],['balance','균형 보조'],['weight','체중 지지 포함'],['movement','움직임 유도'],['other','기타 / 아래에 기록']]],
      ['otherFoot','반대발 상태 (한발 축 지지)',[['unrecorded','미기록 / 확인 필요'],['touching','바닥에 댐'],['lifted','들고 있음'],['na','해당 없음']]],
      ['baselinePosture','Baseline 자세',[['seated-unloaded','앉아서 발바닥 부하를 덜어낸 자세'],['supported','지지받는 자세 · 아래에 설명']]],
      ['goal','목적'],
      ['heatGain','열지도 표시 민감도 (좌우 공통)',[[1,'기본 ×1'],[1.5,'×1.5'],[2,'×2'],[3,'×3']]],
    ];
    for(const [key,label,options] of fields){
      const wrap=node('label','form-group'); wrap.append(node('span','form-label',label));
      const input=node(options?'select':'input','form-input');
      if(options) for(const [value,text] of options){ const opt=node('option','',text); opt.value=value; input.append(opt); }
      else { input.type='text'; input.maxLength=500; }
      input.value=initial[key] ?? ''; input.dataset.field=key; controls[key]=input;
      wrap.append(input); box.append(wrap);
    }
    box.append(node('small','','신발 착용 상태가 바뀌면 baseline을 다시 측정하세요. 민감도는 색상만 바꾸며 원본값·판정 기준은 바꾸지 않습니다.'));
    return {element:box, read(){ const out={}; for(const [k,c] of Object.entries(controls))out[k]=c.value; out.heatGain=Number(out.heatGain); return out; }, disable(value){Object.values(controls).forEach(c=>c.disabled=value);} };
  }
  /* ── Baseline 게이트 ───────────────────────────────────────
     사유는 두 갈래다.

     blocking  — 패킷이 제대로 오지 않았다. 중앙값 자체를 믿을 수
                 없으므로 다시 받는 것 말고는 방법이 없다.
     advisory  — 신호는 왔는데 조건이 나쁘다. 신발을 신으면 센서가
                 이미 눌린 채로 시작하므로 여기에 걸리는 것이 오히려
                 정상이다. 측정을 통째로 버리는 대신, 숫자를 그대로
                 보여주고 치료사가 사유를 남기고 진행할 수 있게 한다.

     흔들림 한계는 호출부가 넘긴다. 맨발과 신발 착용은 같은 자세로
     서 있어도 폭이 자릿수 가까이 다르기 때문이다. 기본 35는 맨발
     기준으로 정해진 초기값일 뿐 신발 착용 데이터로 검증된 적이 없다.
     실제 값은 쌓인 시도 기록에서 tools/baseline-limit.cjs로 뽑아
     개발 도구에서 넣는다. */
  const DEFAULT_MAX_SPREAD = 35;

  function baselineQuality(samples, start, end, opts = {}) {
    const maxSpread = Number.isFinite(opts.maxSpread) ? opts.maxSpread : DEFAULT_MAX_SPREAD;
    const n=samples.length, times=samples.map(s=>s.t);
    const gaps=[(times[0]??end)-start, end-(times.at(-1)??start)];
    for(let i=1;i<n;i++)gaps.push(times[i]-times[i-1]);
    const span=n>1?times.at(-1)-times[0]:0;
    const base=pressureEngine.baselineFromSamples(samples.map(s=>s.v));
    const spread=[0,1,2,3].map(ch=>{
      const a=samples.map(s=>s.v[ch]).sort((a,b)=>a-b);
      return n ? a[Math.floor((n-1)*.9)]-a[Math.floor((n-1)*.1)] : 0;
    });
    const blocking=[], advisory=[], warnings=[];
    if(n<10 || span<2000 || Math.max(...gaps)>600) blocking.push('수신 부족·공백: 다시 연결하고 재측정');
    if(spread.some(v=>v>maxSpread)) advisory.push(`기준값 흔들림(한계 ${maxSpread}): 같은 자세로 재측정`);
    const fixedAtMax=[0,1,2,3].filter(ch=>n && samples.every(s=>(s.v[ch]??0)>=1023));
    if(fixedAtMax.length) advisory.push(`센서 상한 고정(CH${fixedAtMax.map(ch=>ch+1).join(', CH')}): 변화를 읽을 수 없음`);
    else if(base.some(v=>v>=1000)) warnings.push('센서 상한 근접: 작은 변화(3–5)를 기준으로 기록');
    const reasons=[...blocking,...advisory];
    return {ok:!reasons.length,reasons,blocking,advisory,warnings,count:n,spanMs:span,maxGapMs:Math.max(...gaps),
      hz:span>0?Math.round((n-1)*10000/span)/10:0,
      baseline:base,spread,headroom:base.map(v=>1023-v),saturated:fixedAtMax,
      method:'fresh-packets-median-v1', limits:{minPackets:10,minSpanMs:2000,maxGapMs:600,maxSpread,nearSaturation:1000,hardSaturation:1023,minVisibleDelta:3}};
  }

  /* 측정 결과를 통과 여부와 무관하게 항상 같은 형태로 보여준다.
     게이트에 걸렸을 때 숫자가 사라지면 왜 걸렸는지 알 수 없고,
     신발 착용 한계값을 데이터로 다시 정할 수도 없다. */
  function baselineReadout(evidence, footKey) {
    const row=node('div','baseline-readout');
    const chans=[0,1,2,3];
    row.append(node('strong','',`${FOOT_LABEL[footKey]||footKey} · ${evidence.count}개 수신 · ${evidence.hz}Hz · 최대 공백 ${evidence.maxGapMs}ms`));
    const table=node('table','baseline-table');
    const head=node('tr'); ['','기준값','흔들림','남은 범위'].forEach(t=>head.append(node('th','',t)));
    table.append(head);
    chans.forEach(ch=>{
      const tr=node('tr');
      tr.append(node('td','',`CH${ch+1}`));
      tr.append(node('td','',String(evidence.baseline[ch])));
      const sp=node('td','',String(evidence.spread[ch]));
      if(evidence.spread[ch]>evidence.limits.maxSpread) sp.dataset.over='1';
      tr.append(sp);
      tr.append(node('td','',String(evidence.headroom[ch])));
      table.append(tr);
    });
    row.append(table);
    evidence.warnings.forEach(w=>row.append(node('small','',w)));
    return row;
  }

  function signalQuality(samples, durationMs) {
    if(!samples?.length)return {count:0,hz:0,maxGapMs:durationMs,saturationPct:0};
    let maxGap=samples[0][0], clipped=0;
    samples.forEach((s,i)=>{ if(i)maxGap=Math.max(maxGap,s[0]-samples[i-1][0]); clipped+=s.slice(1,5).filter(v=>v>=1000).length; });
    maxGap=Math.max(maxGap,durationMs-samples.at(-1)[0]);
    const span=samples.at(-1)[0]-samples[0][0];
    return {count:samples.length,hz:span>0?Math.round((samples.length-1)*10000/span)/10:0,maxGapMs:Math.round(maxGap),saturationPct:Math.round(clipped/(samples.length*4)*1000)/10};
  }
  function summary(context) {
    if(!context)return node('div','ready-banner','이전 기록 · 측정 조건 없음');
    const box=node('div','card validation-summary');
    box.append(node('strong','',`${tasks[context.task]||context.task} · ${context.environment==='outdoor'?'Outdoor':'실내'} · 신발 ${context.footwear==='shoes'?'착용':'미착용'}`));
    box.append(node('div','',`목적: ${context.goal||'미기록'} · 열지도 ×${context.heatGain||1}`));
    const labels={support:'보조',otherFoot:'반대발',baselinePosture:'Baseline 자세'};
    const words={unrecorded:'미기록 / 확인 필요',none:'없음',standby:'관찰',balance:'균형 보조',weight:'체중 지지 포함',movement:'움직임 유도',other:'기타',touching:'바닥 접촉',lifted:'들고 있음',na:'해당 없음','seated-unloaded':'앉아서 발바닥 부하를 덜어낸 자세',supported:'지지받는 자세'};
    for(const [key,label]of Object.entries(labels))if(context[key])box.append(node('div','',`${label}: ${words[context[key]]||context[key]}`));
    return box;
  }
  function download(data, name='onyx-validation-backup.json') {
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=node('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  let database;
  function db(){
    if(!database)database=new Promise((resolve,reject)=>{
      const req=indexedDB.open('onyx-validation-recovery',1);
      req.onupgradeneeded=()=>req.result.createObjectStore('pending');
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
    return database;
  }
  async function pending(action, value){
    const d=await db(); return new Promise((resolve,reject)=>{
      const tx=d.transaction('pending',action==='get'?'readonly':'readwrite'), s=tx.objectStore('pending');
      const req=action==='get'?s.get('capture'):action==='put'?s.put(value,'capture'):s.delete('capture');
      tx.oncomplete=()=>resolve(req.result); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
    });
  }
  function referenceFromSegment(samples) {
    // A representative observed instant, not independent channel maxima.
    const middle=pressureEngine.median(samples.map(s=>s.slice(1,5).reduce((a,b)=>a+b,0)));
    return samples.reduce((best,s)=>Math.abs(s.slice(1,5).reduce((a,b)=>a+b,0)-middle)<Math.abs(best.slice(1,5).reduce((a,b)=>a+b,0)-middle)?s:best,samples[0]);
  }
  return {tasks,copy,id,defaults,node,form,DEFAULT_MAX_SPREAD,baselineQuality,baselineReadout,signalQuality,summary,download,pending,referenceFromSegment};
})();
if(typeof module!=='undefined') module.exports=validation;
