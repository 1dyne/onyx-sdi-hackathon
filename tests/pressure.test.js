const assert = require('node:assert/strict');

global.FOOT_IDS = ['left','right'];
global.DEFAULT_CAPTURE_CHANNELS = ['P6','P3','P2','P1'];
global.LEGACY_CAPTURE_CHANNELS = ['P1','P2','P3','P4'];
global.PRESSURE_POINTS = {
  P1:{svgX:150,svgY:25}, P2:{svgX:150,svgY:105},
  P3:{svgX:60,svgY:105}, P6:{svgX:100,svgY:350},
};

const p = require('../js/pressure.js');

assert.deepEqual(p.baselineFromSamples([
  [10,20,30,40], [1000,21,31,39], [11,19,29,41],
]), [11,20,30,40], 'median baseline must reject a transient spike');

assert.deepEqual(p.deltaValues([20,10,50,35],[10,20,30,40]), [10,0,20,0]);
assert.equal(p.heatLevel(0),0);
assert.equal(p.heatLevel(9),1);
assert.equal(p.heatLevel(600),5);

const samples=[];
for(let i=0;i<50;i++){
  const phase=i%20;
  const heel=(phase>=2&&phase<=7)?220:0;
  samples.push([i*100, 20+heel, 0, 0, 0, 0, 0, 0]);
}
const steps=p.detectSteps(samples,['P6','P3','P2','P1'],[20,0,0,0]);
assert.equal(steps.length,2);
assert.equal(steps[0].start,200);
assert.equal(steps[0].duration,2000);

const metric=p.balance({
  left:{values:[120,0,0,0],baseline:[20,0,0,0]},
  right:{values:[70,0,0,0],baseline:[20,0,0,0]},
}, ['P6','P3','P2','P1']);
assert.equal(metric.leftPct,67);
assert.equal(metric.rightPct,33);
assert.ok(metric.feet.left.cop);

console.log('pressure tests: ok');
