const assert = require('node:assert/strict');
global.pressureEngine = require('../js/pressure.js');
const v = require('../js/validation.js');
const defaults=v.defaults();
assert.equal(defaults.goal,'','purpose must start blank');
for(const removed of ['socks','orthosis','supportSite','chair','handSupport','placementNote','note'])assert.equal(removed in defaults,false,`${removed} must not be a registration slot`);
const samples = Array.from({length:30},(_,i)=>({t:i*100,v:[100+i%3,200,300,400]}));
const good=v.baselineQuality(samples,0,3000);
assert.equal(good.ok,true);
assert.deepEqual(good.baseline,[101,200,300,400]);
assert.equal(v.baselineQuality(samples.slice(0,1),0,3000).ok,false,'one stale packet must not pass');
assert.equal(v.baselineQuality(samples.filter(s=>s.t<1000||s.t>2200),0,3000).ok,false,'receive gaps must not pass');
assert.equal(v.baselineQuality(samples.map(s=>({...s,v:[s.t,200,300,400]})),0,3000).ok,false,'moving baseline must not pass');
assert.equal(v.baselineQuality(samples.map(s=>({...s,v:[1023,200,300,400]})),0,3000).ok,false,'a channel fixed at saturation must not pass');
const nearMax=v.baselineQuality(samples.map((s,i)=>({...s,v:[1020+i%4,200,300,400]})),0,3000);
assert.equal(nearMax.ok,true,'near-saturation variation in shoes must remain measurable');
assert.ok(nearMax.warnings.length,'near-saturation variation must be surfaced as a warning');

/* 게이트 사유의 두 갈래. 수신 문제는 막고, 신호 조건 문제는 숫자를
   보여준 뒤 치료사가 사유를 남기고 진행할 수 있어야 한다. 신발을
   신으면 흔들림 한계를 넘는 것이 정상에 가깝기 때문이다. */
const gaps=v.baselineQuality(samples.filter(s=>s.t<1000||s.t>2200),0,3000);
assert.ok(gaps.blocking.length,'receive gaps block');
assert.equal(gaps.advisory.length,0,'a delivery problem is not an advisory');
const shaky=v.baselineQuality(samples.map(s=>({...s,v:[s.t,200,300,400]})),0,3000);
assert.equal(shaky.blocking.length,0,'a moving baseline must not block');
assert.ok(shaky.advisory.length,'a moving baseline is advisory');
const pinned=v.baselineQuality(samples.map(s=>({...s,v:[1023,200,300,400]})),0,3000);
assert.deepEqual(pinned.saturated,[0],'the pinned channel is named');
assert.equal(pinned.blocking.length,0,'saturation is advisory, not a block');
assert.deepEqual(good.reasons,[...good.blocking,...good.advisory],'reasons stays the union');
assert.ok(good.hz>0,'the readout needs a sample rate');

/* 흔들림 한계는 호출부가 넘긴다. 맨발 기준 35를 신발 착용에 그대로
   쓰면 정상적인 측정이 전부 걸린다. */
const shoeLike=samples.map((s,i)=>({...s,v:[700+(i%2)*90,710,720,730]}));
assert.equal(shaky.limits.maxSpread,35,'the default limit stays 35');
assert.ok(v.baselineQuality(shoeLike,0,3000).advisory.length,'35 flags a shoe-worn baseline');
const loosened=v.baselineQuality(shoeLike,0,3000,{maxSpread:120});
assert.equal(loosened.advisory.length,0,'a raised limit accepts the same measurement');
assert.equal(loosened.limits.maxSpread,120,'the applied limit is recorded with the result');
assert.equal(v.DEFAULT_MAX_SPREAD,35);
const segment=[[0,100,0,20,0,1,2,3],[100,0,100,0,20,4,5,6],[200,10,30,40,50,7,8,9]];
assert.ok(segment.includes(v.referenceFromSegment(segment)),'representative must be a real observed sample');
const q=v.signalQuality([[0,1023,0,0,0],[100,0,0,0,0],[900,0,0,0,0]],1000);
assert.equal(q.maxGapMs,800);assert.equal(q.saturationPct,8.3);
assert.equal(v.signalQuality([],3000).count,0);
const original={conditionId:'a',task:'sit'};const frozen=v.copy(original);original.task='walk';assert.equal(frozen.task,'sit');
// Reset is deliberately limited to record keys and export/import preserves metadata.
const vm=require('node:vm'), fs=require('node:fs');
const data=new Map();const context={MAX_SENSOR_VAL:1023,DEFAULT_CAPTURE_CHANNELS:[],BUILD_VERSION:'test',localStorage:{getItem:k=>data.get(k)||null,setItem:(k,x)=>data.set(k,x),removeItem:k=>data.delete(k)}};
vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../js/store.js'),'utf8')+'\nglobalThis.storeTest=store;',context);
const store=context.storeTest;
store.saveSettings({audioVolume:.7});
assert.equal(store.getSettings().spreadLimitNone,35,'barefoot limit defaults to 35');
assert.equal(store.getSettings().spreadLimitShoes,35,'the shoe limit starts at the same value until measured');
store.saveCapture({captureId:'test-cap',context:frozen,markers:[{t:1,label:'보조 변경',note:'균형 지지'}],left:segment});
store.saveDrill({id:'d1',channels:[],points:[],context:frozen,source:{captureId:'test-cap'},referenceReviewRequired:true});

/* v2.1: thr가 좌우로 나뉜다. 예전 드릴의 숫자 하나는 양발에 그대로
   복사된다 — 그것이 그 드릴이 이미 하던 동작이다. */
store.saveDrill({id:'d-legacy',channels:['P6'],points:[{id:'P6',thr:240,direction:'positive'}]});
// store는 vm 컨텍스트에서 돌아 프로토타입이 달라 값만 옮겨 비교한다.
const migrated=store.getDrill('d-legacy').points[0];
assert.deepEqual({...migrated.thr},{left:240,right:240},'a single thr applies to both feet');
store.saveDrill({id:'d-split',channels:['P6'],points:[{id:'P6',thr:{left:120,right:180},direction:'positive'}]});
assert.deepEqual({...store.getDrill('d-split').points[0].thr},{left:120,right:180},'a split thr survives a round trip');

/* BASELINE 시도 기록은 통과·미통과를 가리지 않고 남고 백업에 실린다. */
store.saveBaselineTrial({trialId:'t1',foot:'left',outcome:'advisory',spread:[62,48,55,71]});
store.saveBaselineTrial({trialId:'t2',foot:'right',outcome:'blocked',spread:[9,9,9,9]});
assert.equal(store.getBaselineTrials().length,2);
assert.equal(store.updateBaselineTrial('t1',{outcome:'accepted',note:'신발 착용'}),true);
assert.equal(store.getBaselineTrials()[0].outcome,'accepted');
const backup=store.exportAll();store.resetExperimentRecords();
assert.equal(store.getCaptures().length,0);assert.equal(store.getDrills().length,0);assert.equal(store.getSettings().audioVolume,.7);
assert.equal(store.getBaselineTrials().length,0,'reset clears the trial log too');
store.importAll(backup);assert.equal(store.getCapture('test-cap').markers[0].note,'균형 지지');
assert.equal(store.getBaselineTrials().length,2,'trials come back with the backup');
assert.equal(store.getDrill('d1').source.captureId,'test-cap');
console.log('validation tests: ok');
