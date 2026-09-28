const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const LABELS = ['低活动', '正常游动', '快速游动', '急转避让'];
const state = { source: 'none', running: false, data: null, frame: null, series: [], stream: null,
  objectUrl: null, demoTick: 0, lastTime: null, alertKey: null, demoFish: [] };
const video = $('#video');
const stage = $('#videoStage');
const pose = $('#poseCanvas');
const behavior = $('#behaviorChart');
const activity = $('#activityChart');
const pctx = pose.getContext('2d');
const bctx = behavior.getContext('2d');
const actx = activity.getContext('2d');
const clamp = (v, low = 0, high = 1) => Math.max(low, Math.min(high, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function resizeCanvas(canvas) {
  const bounds = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(bounds.width * dpr));
  canvas.height = Math.max(1, Math.round(bounds.height * dpr));
  canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}
function addLog(type, message, level = '') {
  const row = document.createElement('div');
  row.className = `log-row ${level}`;
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  [stamp, type, message].forEach(text => {
    const span = document.createElement('span'); span.textContent = text; row.append(span);
  });
  $('#eventLog').prepend(row);
  while ($('#eventLog').children.length > 80) $('#eventLog').lastChild.remove();
}
function setStatus(id, value, ok = false) {
  $(id).textContent = value;
  $(id).classList.toggle('ok', ok);
  $(id).classList.toggle('muted', !ok);
}
function updateSourceUI() {
  const source = state.source;
  const names = { none: '数据源未接入', file: video.src ? '本地视频已接入' : '等待视频文件', camera: state.stream ? '本机摄像头已接入' : '等待摄像头', demo: '界面演示' };
  $('#sourceBadge').textContent = names[source];
  $('#sourceBadge').classList.toggle('online', source === 'demo' || Boolean(video.src || state.stream));
  $('#runBadge').textContent = state.running ? '监测中' : $('#runBadge').dataset.paused === '1' ? '已暂停' : '监测未启动';
  $('#runBadge').classList.toggle('online', state.running);
  $('#videoFileLabel').hidden = source !== 'file';
  $('#jsonFileLabel').hidden = source !== 'file';
  const canRun = source === 'demo' || (source === 'file' && Boolean(video.src)) || (source === 'camera' && Boolean(state.stream));
  $('#togglePlayBtn').disabled = !canRun;
  $('#stopBtn').disabled = !canRun;
  $('#togglePlayBtn').textContent = state.running ? '暂停监测' : $('#runBadge').dataset.paused === '1' ? '继续监测' : '开始监测';
  stage.classList.toggle('has-video', Boolean(video.src || state.stream));
  stage.classList.toggle('is-running', state.running && source === 'demo');
  $('#modeLabel').textContent = source === 'demo' ? '界面演示：所有数值均为模拟数据' : source === 'camera' ? '本机摄像头预览：等待工控机分析服务' : source === 'file' ? state.data ? '本地视频 · 已导入分析结果' : '本地视频 · 尚无分析结果' : '等待选择数据源';
  $('#stageTag').textContent = source === 'demo' ? '模拟数据' : source === 'file' && state.data ? '导入分析结果' : source === 'camera' ? '仅摄像头预览' : source === 'file' ? '仅视频预览' : '未接入';
  $('#sourceHint').textContent = source === 'camera' ? '浏览器需在 localhost 或 HTTPS 下获得摄像头授权；预览不执行模型推理。' : source === 'demo' ? '演示数据由页面随机生成，仅用于验证界面交互。' : '导入本地视频和配套 JSON 后可同步展示姿态与行为结果。';
  setStatus('#statusVideo', source === 'demo' ? '模拟场景' : video.src || state.stream ? '已接入' : '未接入', canRun);
  setStatus('#statusPose', state.running && source === 'demo' ? '演示数据' : state.running && state.data ? '导入结果' : '等待数据', state.running && (source === 'demo' || Boolean(state.data)));
  setStatus('#statusBehavior', state.running && source === 'demo' ? '演示数据' : state.running && state.data ? '导入结果' : '等待数据', state.running && (source === 'demo' || Boolean(state.data)));
  $('#engine').textContent = state.running && source === 'demo' ? '模拟' : state.running && state.data ? state.data.engine || '未提供' : '未连接';
}
function clearResults() {
  state.frame = null; state.series = []; state.lastTime = null; state.alertKey = null;
  ['#fishCount', '#activityScore', '#behaviorState', '#behaviorRatio', '#kpConf', '#latency'].forEach(id => $(id).textContent = '—');
  $('#riskLevel').textContent = '—'; $('#riskReason').textContent = '等待有效分析数据';
  $('#riskCard').classList.remove('warning', 'danger');
  $('#individualRows').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-data', textContent: '等待分析结果' }));
  drawCharts(); drawOverlay();
}
function releaseSource() {
  state.running = false;
  if (state.stream) { state.stream.getTracks().forEach(track => track.stop()); state.stream = null; }
  video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  state.data = null; $('#videoName').textContent = '未导入视频';
  $('#videoInput').value = ''; $('#jsonInput').value = '';
  $('#runBadge').dataset.paused = '0'; clearResults(); updateSourceUI();
}
async function chooseSource(source) {
  releaseSource(); state.source = source; updateSourceUI();
  if (source === 'camera') {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error('当前环境无法访问摄像头；请在 localhost 或 HTTPS 打开。');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (state.source !== source) { stream.getTracks().forEach(t => t.stop()); return; }
      state.stream = stream;
      video.srcObject = stream; video.play().catch(() => {});
      addLog('视频接入', '本机摄像头预览已接入，尚未连接分析服务。');
    } catch (error) { addLog('接入失败', error.message || '摄像头权限或设备不可用。', 'danger'); }
  } else if (source === 'demo') addLog('演示模式', '模拟数据已就绪，可开始监测。');
  updateSourceUI();
}
function normalizeJSON(raw) {
  if (!raw || !Array.isArray(raw.frames) || !raw.frames.length) throw Error('JSON 需要非空 frames 数组。');
  const frames = raw.frames.map((frame, i) => {
    if (!finite(frame.time) || frame.time < 0 || !Array.isArray(frame.detections)) throw Error(`第 ${i + 1} 帧缺少有效 time 或 detections。`);
    if (frame.metrics && (typeof frame.metrics !== 'object' || Array.isArray(frame.metrics))) throw Error(`第 ${i + 1} 帧 metrics 无效。`);
    frame.detections.forEach((det, j) => {
      if (!det || typeof det !== 'object' || Array.isArray(det)) throw Error(`第 ${i + 1} 帧第 ${j + 1} 个鱼体数据无效。`);
      if (det.bbox && (!Array.isArray(det.bbox) || det.bbox.length !== 4 || !det.bbox.every(finite))) throw Error(`第 ${i + 1} 帧第 ${j + 1} 个检测框无效。`);
      if (det.keypoints && (!Array.isArray(det.keypoints) || det.keypoints.length !== 11 || det.keypoints.some(k => !Array.isArray(k) || k.length < 2 || !finite(k[0]) || !finite(k[1]) || (k.length > 2 && !finite(k[2]))))) throw Error(`第 ${i + 1} 帧第 ${j + 1} 个目标需提供 11 个有效关键点。`);
    });
    const values = frame.metrics?.behavior;
    if (values !== undefined && (!Array.isArray(values) || values.length !== 4 || values.some(v => !finite(v) || v < 0))) throw Error(`第 ${i + 1} 帧的 behavior 应为四项非负数。`);
    return frame;
  }).sort((a, b) => a.time - b.time);
  if (raw.videoWidth !== undefined && (!finite(raw.videoWidth) || raw.videoWidth <= 0)) throw Error('videoWidth 无效。');
  if (raw.videoHeight !== undefined && (!finite(raw.videoHeight) || raw.videoHeight <= 0)) throw Error('videoHeight 无效。');
  return { frames, videoWidth: raw.videoWidth, videoHeight: raw.videoHeight, engine: typeof raw.engine === 'string' ? raw.engine.slice(0, 50) : null, windowSeconds: raw.windowSeconds };
}
function nearestFrame(seconds) {
  const frames = state.data.frames;
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (frames[mid].time < seconds) lo = mid + 1; else hi = mid; }
  const later = frames[Math.min(lo, frames.length - 1)];
  const earlier = frames[Math.max(lo - 1, 0)];
  const closest = Math.abs(later.time - seconds) < Math.abs(earlier.time - seconds) ? later : earlier;
  // Do not display stale detections if video and JSON timestamps do not align.
  return Math.abs(closest.time - seconds) <= 0.5 ? closest : null;
}
function renderFrame(frame) {
  state.frame = frame;
  const metrics = frame?.metrics || {};
  const dets = frame?.detections || [];
  const behaviors = metrics.behavior || (dets.some(d => d.behavior !== undefined)
    ? LABELS.map((label, i) => dets.filter(d => d.behavior === i || d.behavior === label).length)
    : null);
  const total = Array.isArray(behaviors) ? behaviors.reduce((a,b) => a+b, 0) : 0;
  const count = finite(metrics.fishCount) ? metrics.fishCount : frame ? dets.length : null;
  const score = finite(metrics.activityScore) ? clamp(metrics.activityScore) : null;
  $('#fishCount').textContent = count === null ? '—' : String(count);
  $('#activityScore').textContent = score === null ? '—' : score.toFixed(2);
  const leader = total > 0 ? behaviors.indexOf(Math.max(...behaviors)) : -1;
  $('#behaviorState').textContent = leader < 0 ? '—' : LABELS[leader];
  $('#behaviorRatio').textContent = leader < 0 ? '等待行为分析结果' : `占比 ${Math.round(behaviors[leader] / total * 100)}%`;
  const scores = dets.flatMap(d => d.keypoints || []).map(k => k[2]).filter(finite);
  const confidence = finite(metrics.confidence) ? metrics.confidence : scores.length ? scores.reduce((a,b) => a+b, 0)/scores.length : null;
  $('#kpConf').textContent = confidence === null ? '—' : confidence.toFixed(2);
  $('#latency').textContent = finite(metrics.latencyMs) ? `${metrics.latencyMs.toFixed(1)} ms` : '—';
  renderIndividuals(dets);
  updateRisk(score, total > 0 ? behaviors[3] / total * 100 : null, frame?.time);
  drawCharts(behaviors);
  drawOverlay();
}
function renderIndividuals(detections) {
  const target = $('#individualRows'); target.replaceChildren();
  if (!detections.length) { target.append(Object.assign(document.createElement('p'), {className:'empty-data',textContent:'当前帧无鱼体实例'})); return; }
  detections.slice(0, 30).forEach((det, i) => {
    const row = document.createElement('div'); row.className = 'individual-row';
    const category = Number.isInteger(det.behavior) && det.behavior >= 0 && det.behavior < 4 ? LABELS[det.behavior] : LABELS.includes(det.behavior) ? det.behavior : '待分析';
    [String(det.id ?? i + 1), det.keypoints ? `${det.keypoints.length}/11` : '—', category].forEach(v => {const span = document.createElement('span'); span.textContent = v; row.append(span);});
    target.append(row);
  });
}
function updateRisk(activityScore, sharpPercent, frameTime) {
  const high = sharpPercent !== null && sharpPercent >= Number($('#turnThreshold').value);
  const medium = activityScore !== null && activityScore >= Number($('#activityThreshold').value);
  const level = high ? '急转占比提示' : medium ? '活动强度提示' : activityScore !== null || sharpPercent !== null ? '未触发提示' : '—';
  $('#riskLevel').textContent = level;
  $('#riskReason').textContent = high ? `急转避让占比 ${sharpPercent.toFixed(1)}%，达到设定阈值` : medium ? `活动强度 ${activityScore.toFixed(2)}，达到设定阈值` : level === '—' ? '缺少状态分析数据' : '当前未达到状态提示条件';
  $('#riskCard').classList.toggle('danger', high);
  $('#riskCard').classList.toggle('warning', !high && medium);
  const key = high ? 'sharp' : medium ? 'activity' : null;
  if (state.running && key && key !== state.alertKey) addLog('状态提示', `${state.source === 'demo' ? '模拟数据；' : ''}${$('#riskReason').textContent}${finite(frameTime) ? `；视频时间 ${frameTime.toFixed(2)} s` : ''}`, high ? 'danger' : 'warn');
  state.alertKey = key;
}
function drawBehavior(values) {
  const w = behavior.clientWidth, h = behavior.clientHeight;
  bctx.clearRect(0,0,w,h); const x=w/2,y=h/2,r=Math.min(w,h)*0.33;
  const total = values?.reduce((a,b) => a+b,0) || 0;
  const colors=['#6aa9ff','#36d399','#ffd166','#ff5d73'];
  let start=-Math.PI/2;
  (total ? values : [1,0,0,0]).forEach((v,i) => {
    if (!v) return;
    const end=start + (total ? v/total : 1)*Math.PI*2;
    bctx.beginPath(); bctx.arc(x,y,r,start,end); bctx.arc(x,y,r*0.62,end,start,true); bctx.closePath();
    bctx.fillStyle=total?colors[i]:'rgba(255,255,255,.09)';bctx.fill(); start=end;
  });
  bctx.fillStyle='#e8f7ff'; bctx.textAlign='center'; bctx.font='700 26px sans-serif';
  bctx.fillText(total?`${Math.round(Math.max(...values)/total*100)}%`:'—',x,y+8);
  bctx.fillStyle='#8eb3c7';bctx.font='14px sans-serif';bctx.fillText(total?LABELS[values.indexOf(Math.max(...values))]:'等待数据',x,y+32);
}
function drawActivity() {
  const w=activity.clientWidth,h=activity.clientHeight,p=32;
  actx.clearRect(0,0,w,h); if(w<=p*2||h<=p*2)return;
  actx.strokeStyle='rgba(144,220,255,.15)';actx.lineWidth=1;
  for(let i=0;i<=4;i++){const y=p+i*(h-2*p)/4;actx.beginPath();actx.moveTo(p,y);actx.lineTo(w-p,y);actx.stroke();}
  const threshold=Number($('#activityThreshold').value),y=p+(1-threshold)*(h-2*p);
  actx.setLineDash([5,5]);actx.strokeStyle='#ffd166';actx.beginPath();actx.moveTo(p,y);actx.lineTo(w-p,y);actx.stroke();actx.setLineDash([]);
  const series=state.series;if(!series.length)return;
  actx.strokeStyle='#45d6ff';actx.lineWidth=2.5;actx.beginPath();
  series.forEach((v,i)=>{const x=p+(i/Math.max(series.length-1,1))*(w-2*p), yy=p+(1-v)*(h-2*p);i?actx.lineTo(x,yy):actx.moveTo(x,yy);});actx.stroke();
}
function drawCharts(values) {
  if (!values && state.frame) {
    values = state.frame.metrics?.behavior;
    if (!values && state.frame.detections.some(d => d.behavior !== undefined)) {
      values = LABELS.map((label, i) => state.frame.detections.filter(d => d.behavior === i || d.behavior === label).length);
    }
  }
  drawBehavior(values); drawActivity();
}
function drawOverlay() {
  const w=pose.clientWidth,h=pose.clientHeight;pctx.clearRect(0,0,w,h);
  if(!state.running && state.source !== 'file')return;
  if(state.source==='demo'){
    state.demoFish.forEach((fish,i)=>{
      fish.x += fish.vx;fish.y += fish.vy;
      if(fish.x<40||fish.x>w-40)fish.vx*=-1;
      if(fish.y<40||fish.y>h-40)fish.vy*=-1;
      const points=Array.from({length:11},(_,j)=>[fish.x+(j-5)*6, fish.y+Math.sin(j*.65+state.demoTick*.2+i)*7,.9]);
      drawDetection({bbox:[fish.x-42,fish.y-18,84,36],keypoints:points}, {x:0,y:0,w,h});
    });return;
  }
  if(state.source!=='file'||!state.frame||!video.videoWidth||!video.videoHeight)return;
  // object-fit: contain leaves letterbox margins; map source coordinates into displayed video content.
  const srcW=state.data.videoWidth||video.videoWidth,srcH=state.data.videoHeight||video.videoHeight;
  const scale=Math.min(w/video.videoWidth,h/video.videoHeight);
  const bounds={x:(w-video.videoWidth*scale)/2,y:(h-video.videoHeight*scale)/2,w:video.videoWidth*scale,h:video.videoHeight*scale};
  state.frame.detections.forEach(det=>drawDetection(det,bounds,srcW,srcH));
}
function drawDetection(det,bounds,srcW=bounds.w,srcH=bounds.h) {
  const px=x=>bounds.x+x*bounds.w/srcW,py=y=>bounds.y+y*bounds.h/srcH;
  if($('#showBoxes').checked&&det.bbox){const [x,y,w,h]=det.bbox;pctx.strokeStyle='#36d399';pctx.lineWidth=2;pctx.strokeRect(px(x),py(y),w*bounds.w/srcW,h*bounds.h/srcH);}
  if(!$('#showSkeleton').checked||!det.keypoints)return;
  const limit=Number($('#confThreshold').value);
  const valid=k=>Array.isArray(k)&&(!finite(k[2])||k[2]>=limit);
  pctx.strokeStyle='#45d6ff';pctx.lineWidth=2;
  for(let i=1;i<det.keypoints.length;i++)if(valid(det.keypoints[i-1])&&valid(det.keypoints[i])){
    pctx.beginPath();pctx.moveTo(px(det.keypoints[i-1][0]),py(det.keypoints[i-1][1]));pctx.lineTo(px(det.keypoints[i][0]),py(det.keypoints[i][1]));pctx.stroke();
  }
  pctx.fillStyle='#ff5d73';det.keypoints.filter(valid).forEach(k=>{pctx.beginPath();pctx.arc(px(k[0]),py(k[1]),3,0,Math.PI*2);pctx.fill();});
}
function stepDemo() {
  state.demoTick++;
  const score=clamp(.52+Math.sin(state.demoTick*.28)*.17+(Math.random()-.5)*.08);
  const sharp=Math.round(5+score*18),fast=Math.round(12+score*18),calm=Math.round(24-score*17);
  const behavior=[calm,100-calm-fast-sharp,fast,sharp];
  const detections=state.demoFish.map((f,i)=>({id:i+1,behavior:i%4,keypoints:Array.from({length:11},(_,j)=>[f.x+(j-5)*6,f.y+Math.sin(j*.65+state.demoTick*.2+i)*7,.7+Math.random()*.28])}));
  renderFrame({time:state.demoTick*1.2,detections,metrics:{fishCount:detections.length,activityScore:score,behavior,confidence:.88}});
  state.series.push(score); if(state.series.length>60)state.series.shift();drawCharts(behavior);
}
function syncFileFrame() {
  if(!state.running||state.source!=='file'||!state.data||!video.videoWidth)return;
  const time=video.currentTime;
  if(state.lastTime===time)return;
  if(state.lastTime!==null&&time<state.lastTime-.5){state.series=[];state.alertKey=null;}
  state.lastTime=time;
  const frame=nearestFrame(time);renderFrame(frame);
  if(frame&&finite(frame.metrics?.activityScore)){
    state.series.push(clamp(frame.metrics.activityScore));if(state.series.length>60)state.series.shift();drawCharts();
  }
}
function setRunning(running) {
  if(running&&$('#togglePlayBtn').disabled)return;
  state.running=running;
  $('#runBadge').dataset.paused=running?'0':'1';
  if(running){
    if(state.source==='file')video.play().catch(()=>addLog('播放提示','浏览器阻止自动播放，请使用视频控件播放。','warn'));
    if(state.source==='demo'&&!state.demoFish.length){const w=pose.clientWidth,h=pose.clientHeight;state.demoFish=Array.from({length:9},(_,i)=>({x:60+(i%3)*(w-120)/3,y:65+Math.floor(i/3)*(h-130)/3,vx:(i%2?1:-1)*.7,vy:.35}));}
    addLog('监测启动','已开始或恢复监测。');
  }else{if(state.source==='file')video.pause();addLog('监测暂停','画面与当前分析结果已保留。');}
  updateSourceUI();drawOverlay();
}
$('#sourceSelect').addEventListener('change',e=>chooseSource(e.target.value));
$('#videoInput').addEventListener('change',e=>{
  const file=e.target.files?.[0];if(!file)return;
  if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);
  state.objectUrl=URL.createObjectURL(file);video.src=state.objectUrl;video.srcObject=null;
  state.data=null;clearResults();$('#jsonInput').value='';$('#videoName').textContent=file.name;
  video.load();updateSourceUI();addLog('视频接入',`已加载本地视频：${file.name}`);
});
$('#jsonInput').addEventListener('change',async e=>{
  const file=e.target.files?.[0];if(!file)return;
  try { const parsed=normalizeJSON(JSON.parse(await file.text()));state.data=parsed;clearResults();
    $('#behaviorWindowLabel').textContent=finite(parsed.windowSeconds)?`${parsed.windowSeconds} 秒窗口`:'2 秒窗口';
    updateSourceUI();addLog('数据接入',`已导入分析结果：${file.name}`);
  }catch(error){state.data=null;clearResults();updateSourceUI();addLog('数据错误',error.message,'danger');}
});
$('#togglePlayBtn').addEventListener('click',()=>setRunning(!state.running));
$('#stopBtn').addEventListener('click',()=>{state.running=false;$('#runBadge').dataset.paused='0';if(state.source==='file'){video.pause();video.currentTime=0;}clearResults();updateSourceUI();addLog('监测停止','本次监测已停止，事件日志保留。');});
$('#clearLog').addEventListener('click',()=>$('#eventLog').replaceChildren());
['showBoxes','showSkeleton','confThreshold'].forEach(id=>$('#'+id).addEventListener('input',()=>{if(id==='confThreshold')$('#confValue').textContent=Number($('#confThreshold').value).toFixed(2);drawOverlay();}));
['activityThreshold','turnThreshold'].forEach(id=>$('#'+id).addEventListener('input',()=>{
  $('#activityValue').textContent=Number($('#activityThreshold').value).toFixed(2);$('#turnValue').textContent=$('#turnThreshold').value+'%';
  if(state.frame)renderFrame(state.frame);else drawCharts();
}));
$$('.nav-item').forEach(item=>item.addEventListener('click',()=>{$$('.nav-item').forEach(n=>n.classList.remove('active'));item.classList.add('active');document.getElementById(item.dataset.target).scrollIntoView({behavior:'smooth',block:'start'});}));
video.addEventListener('timeupdate',syncFileFrame);
video.addEventListener('seeked',()=>{state.lastTime=null;syncFileFrame();});
video.addEventListener('ended',()=>{if(state.running&&state.source==='file'){state.running=false;$('#runBadge').dataset.paused='0';updateSourceUI();addLog('监测结束','视频播放结束。');}});
window.addEventListener('resize',()=>{[pose,behavior,activity].forEach(resizeCanvas);drawCharts();drawOverlay();});
[pose,behavior,activity].forEach(resizeCanvas);updateSourceUI();drawCharts();
addLog('系统就绪','请选择本地视频、摄像头预览或界面演示。');
setInterval(()=>{$('#clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false});},1000);
setInterval(()=>{if(state.running&&state.source==='demo')stepDemo();},1200);
$('#clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false});
