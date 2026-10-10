const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const LABELS = ['低活动', '正常游动', '快速游动', '急转避让'];
const SKELETON = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [1, 10], [10, 9], [9, 8]];
const API = {
  status: '/api/status',
  source: '/api/source',
  start: '/api/monitor/start',
  pause: '/api/monitor/pause',
  resume: '/api/monitor/resume',
  stop: '/api/monitor/stop',
  params: '/api/params',
  logs: '/api/logs',
  frame: '/api/frame',
  ws: '/ws'
};
const WINDOW_FRAMES = 96;
const STRIDE_FRAMES = 48;
const FPS = 30;
const WINDOW_SECONDS = WINDOW_FRAMES / FPS;
const STRIDE_SECONDS = STRIDE_FRAMES / FPS;
const state = {
  source: 'none', running: false, paused: false, mode: 'idle', backend: false, socket: null,
  data: null, frame: null, series: [], stream: null, objectUrl: null, demoTick: 0, demoFish: [],
  lastBehaviorTime: null, lastActivity: null, alertKey: null, liveDetections: [], behaviorById: {}, service: null,
  applyingParams: false, videoFile: null, uploadId: '', poseBuffer: [], pendingBehavior: []
};
const video = $('#video');
const stage = $('#videoStage');
const pose = $('#poseCanvas');
const behavior = $('#behaviorChart');
const activity = $('#activityChart');
const pctx = pose.getContext('2d');
const bctx = behavior.getContext('2d');
const actx = activity.getContext('2d');
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function resizeCanvas(canvas) {
  const bounds = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(bounds.width * ratio));
  canvas.height = Math.max(1, Math.round(bounds.height * ratio));
  canvas.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  const token = sessionStorage.getItem('monitorToken');
  if (token) headers['X-Monitor-Token'] = token;
  return headers;
}

async function request(path, options = {}) {
  const headers = authHeaders({ 'Content-Type': 'application/json', ...(options.headers || {}) });
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || '后端请求失败');
    error.payload = payload;
    throw error;
  }
  return payload;
}

function showLog(entry) {
  const row = document.createElement('div');
  row.className = `log-row ${entry.level && entry.level !== 'info' ? entry.level : ''}`;
  const stamp = entry.time ? new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false }) : new Date().toLocaleTimeString('zh-CN', { hour12: false });
  [stamp, entry.type, entry.message].forEach(text => {
    const span = document.createElement('span');
    span.textContent = text;
    row.append(span);
  });
  $('#eventLog').prepend(row);
  while ($('#eventLog').children.length > 80) $('#eventLog').lastChild.remove();
}

async function addLog(type, message, level = 'info') {
  showLog({ time: new Date().toISOString(), type, message, level });
  if (!state.backend) return;
  try { await request(API.logs, { method: 'POST', body: JSON.stringify({ type, message, level }) }); } catch (error) { state.backend = false; }
}

function setStatus(id, value, ok = false) {
  $(id).textContent = value;
  $(id).classList.toggle('ok', ok);
  $(id).classList.toggle('muted', !ok);
}

function windowLabel() {
  const frames = state.data?.windowFrames || state.service?.params?.windowFrames || WINDOW_FRAMES;
  const seconds = state.data?.windowSeconds || WINDOW_SECONDS;
  return `${frames} 帧 / ${Number(seconds).toFixed(1)} 秒`;
}

function updateSourceUI() {
  const names = { none: '数据源未接入', file: video.src ? '本地视频已接入' : '等待视频文件', camera: state.stream ? '本机摄像头已接入' : '等待摄像头', ipc: '工控机摄像头', demo: '界面演示' };
  const connected = state.source === 'demo' || Boolean(video.src || state.stream) || (state.source === 'ipc' && state.service?.sourceConnected);
  $('#sourceBadge').textContent = state.backend ? names[state.source] || '数据源未接入' : '后端未连接';
  $('#sourceBadge').classList.toggle('online', state.backend && connected);
  const runText = !state.backend ? '未连接' : state.mode === 'demo' && state.running ? '演示中' : state.mode === 'preview' && state.running ? '仅预览' : state.running ? '监测中' : state.paused ? '已暂停' : state.service?.state === 'stopped' ? '已停止' : state.service?.state === 'error' ? '运行异常' : '已就绪';
  $('#runBadge').textContent = runText;
  $('#runBadge').classList.toggle('online', state.running && state.mode !== 'demo' && state.mode !== 'preview');
  $('#videoFileLabel').hidden = state.source !== 'file';
  $('#jsonFileLabel').hidden = state.source !== 'file';
  $('#backendAnalyzeLabel').hidden = state.source !== 'file';
  const canRun = state.backend && (state.source === 'demo' || (state.source === 'file' && Boolean(video.src)) || (state.source === 'camera' && Boolean(state.stream)) || (state.source === 'ipc' && state.service?.sourceConnected));
  $('#togglePlayBtn').disabled = !canRun;
  $('#stopBtn').disabled = !state.backend || (!state.running && !state.paused && state.service?.state !== 'error');
  $('#togglePlayBtn').textContent = state.running ? '暂停监测' : state.paused ? '继续监测' : '开始监测';
  stage.classList.toggle('has-video', Boolean(video.src || state.stream));
  stage.classList.toggle('is-running', state.running && state.source === 'demo');
  const analyze = $('#backendAnalyze').checked;
  const formatTest = state.data?.purpose === 'format-test';
  $('#modeLabel').textContent = !state.backend ? '后端未连接' : state.source === 'demo' ? '界面演示：所有数值均为模拟数据' : state.source === 'camera' ? '本机摄像头预览，不执行模型推理' : state.source === 'ipc' ? '工控机摄像头由后端采集' : state.source === 'file' && analyze ? '本地视频将提交后端分析' : state.source === 'file' && state.data ? (formatTest ? '本地视频 · 测试数据' : '本地视频 · 已导入分析结果') : state.source === 'file' ? '本地视频 · 尚无分析结果' : '等待选择数据源';
  $('#stageTag').textContent = state.source === 'demo' ? '模拟数据' : formatTest ? '测试数据' : state.mode === 'analyze' ? '后端分析' : state.source === 'file' && state.data ? '导入分析结果' : state.source === 'camera' ? '仅摄像头预览' : state.source === 'ipc' ? '工控机摄像头' : state.source === 'file' ? '仅视频预览' : '未接入';
  $('#sourceHint').textContent = state.source === 'camera' ? '浏览器预览不执行姿态检测或行为分析。' : state.source === 'ipc' ? '真实监测由后端采集并推理；模型未加载时不会生成结果。' : state.source === 'demo' ? '演示数据只用于界面测试，不会写入真实监测结果。' : analyze ? '未加载模型时，后端会拒绝分析且页面不显示检测结果。' : '导入本地视频和配套 JSON 后，可按时间轴查看姿态与行为。';
  $('#behaviorWindowLabel').textContent = windowLabel();
  const service = state.service || {};
  setStatus('#statusVideo', !state.backend ? '未连接' : connected ? '已接入' : '未接入', connected && state.backend);
  const poseText = state.mode === 'demo' && state.running ? '演示数据' : state.mode === 'playback' && state.running ? (formatTest ? '测试数据' : '导入结果') : service.poseModel || '未找到模型文件';
  const behaviorText = state.mode === 'demo' && state.running ? '演示数据' : state.mode === 'playback' && state.running ? (formatTest ? '测试数据' : '导入结果') : service.behaviorModel || '未找到模型文件';
  const readyStatus = value => value === '可执行推理' || value === '导入结果' || value === '测试数据' || value === '演示数据';
  setStatus('#statusPose', poseText, readyStatus(poseText));
  setStatus('#statusBehavior', behaviorText, readyStatus(behaviorText));
  const engine = state.mode === 'demo' ? '模拟' : formatTest ? '测试数据' : service.engine || state.data?.engine || '未加载';
  $('#engine').textContent = engine;
}

function clearResults() {
  state.frame = null;
  state.series = [];
  state.lastBehaviorTime = null;
  state.lastActivity = null;
  state.alertKey = null;
  state.liveDetections = [];
  state.behaviorById = {};
  state.poseBuffer = [];
  state.pendingBehavior = [];
  state.demoFish = [];
  ['#fishCount', '#activityScore', '#behaviorState', '#behaviorRatio', '#kpConf', '#latency'].forEach(id => $(id).textContent = '—');
  $('#riskLevel').textContent = '—';
  $('#riskReason').textContent = '等待有效分析数据';
  $('#riskCard').classList.remove('warning', 'danger');
  $('#individualRows').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-data', textContent: '等待分析结果' }));
  drawCharts();
  drawOverlay();
}

function releaseLocalMedia() {
  if (state.stream) {
    state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;
  }
  video.pause();
  video.srcObject = null;
  video.removeAttribute('src');
  video.load();
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
  state.data = null;
  state.videoFile = null;
  state.uploadId = '';
  $('#videoName').textContent = '未导入视频';
  $('#videoInput').value = '';
  $('#jsonInput').value = '';
}

async function chooseSource(source) {
  if (state.backend && (state.running || state.paused)) {
    try { await request(API.stop, { method: 'POST', body: '{}' }); } catch (error) { state.backend = false; }
  }
  state.running = false;
  state.paused = false;
  state.mode = 'idle';
  releaseLocalMedia();
  clearResults();
  state.source = source;
  const payload = { type: source === 'camera' ? 'preview' : source === 'ipc' ? 'camera' : source, name: '', analyze: false };
  try {
    const result = await request(API.source, { method: 'POST', body: JSON.stringify(payload) });
    state.backend = true;
    state.service = result.status;
    if (result.log && result.created !== false) showLog(result.log);
  } catch (error) {
    state.backend = false;
    state.service = null;
    await addLog('系统异常', error.message || '无法连接后端。', 'danger');
  }
  if (source === 'camera') await openPreviewCamera();
  updateSourceUI();
}

async function openPreviewCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Error('当前环境无法访问摄像头。');
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    if (state.source !== 'camera') {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    state.stream = stream;
    video.srcObject = stream;
    video.play().catch(() => {});
    await addLog('视频数据源接入', '本机摄像头预览已接入，不执行模型推理。');
  } catch (error) {
    await addLog('视频流异常', error.message || '摄像头不可用。', 'danger');
  }
}

function normalizeJSON(raw) {
  if (!raw || !Array.isArray(raw.frames) || !raw.frames.length) throw Error('JSON 需要非空 frames 数组。');
  const windowSeconds = finite(raw.windowSeconds) ? raw.windowSeconds : WINDOW_SECONDS;
  const frames = raw.frames.map((frame, index) => {
    if (!finite(frame.time) || frame.time < 0 || !Array.isArray(frame.detections)) throw Error(`第 ${index + 1} 帧缺少有效 time 或 detections。`);
    frame.detections.forEach((det, detIndex) => {
      if (!det || typeof det !== 'object') throw Error(`第 ${index + 1} 帧第 ${detIndex + 1} 个鱼体数据无效。`);
      if (det.bbox && (!Array.isArray(det.bbox) || det.bbox.length !== 4 || !det.bbox.every(finite))) throw Error(`第 ${index + 1} 帧检测框无效。`);
      if (det.keypoints && (!Array.isArray(det.keypoints) || det.keypoints.length !== 11)) throw Error(`第 ${index + 1} 帧需要 11 个关键点。`);
      const hasBehavior = Number.isInteger(det.behavior) || LABELS.includes(det.behavior);
      if (!hasBehavior) return;
      if (frame.time + 1e-6 < windowSeconds) throw Error(`第 ${index + 1} 帧的行为结果早于 ${windowSeconds} 秒窗口。`);
      ['window_start_frame', 'window_end_frame', 'window_start_time', 'window_end_time'].forEach(key => {
        if (!finite(det[key]) && !Number.isInteger(det[key])) throw Error(`第 ${index + 1} 帧行为结果缺少 ${key}。`);
      });
      if (det.window_end_time > frame.time + 1e-3 || det.window_start_time > det.window_end_time) throw Error(`第 ${index + 1} 帧行为窗口时间无效。`);
    });
    return frame;
  }).sort((a, b) => a.time - b.time);
  return {
    frames,
    videoWidth: raw.videoWidth,
    videoHeight: raw.videoHeight,
    engine: typeof raw.engine === 'string' ? raw.engine : null,
    windowSeconds: finite(raw.windowSeconds) ? raw.windowSeconds : WINDOW_SECONDS,
    windowFrames: raw.windowFrames || WINDOW_FRAMES,
    strideFrames: raw.strideFrames || STRIDE_FRAMES,
    fps: raw.fps || FPS,
    purpose: raw.purpose || ''
  };
}

function nearestFrame(seconds) {
  const frames = state.data.frames.filter(frame => frame.time <= seconds + 1e-3);
  if (!frames.length) return null;
  const frame = frames[frames.length - 1];
  return seconds - frame.time <= STRIDE_SECONDS ? frame : null;
}

function behaviorVisible(det, time) {
  if (!det || (!Number.isInteger(det.behavior) && !LABELS.includes(det.behavior))) return false;
  if (!finite(det.window_end_time) || !finite(det.window_start_time)) return false;
  if (det.window_end_time > time + 1e-3) return false;
  return time - det.window_end_time <= STRIDE_SECONDS + 1e-3;
}

function withVisibleBehavior(frame, time) {
  if (!frame) return null;
  return {
    ...frame,
    videoWidth: frame.videoWidth || state.data?.videoWidth,
    videoHeight: frame.videoHeight || state.data?.videoHeight,
    detections: frame.detections.map(det => {
      if (behaviorVisible(det, time)) return det;
      const copy = { ...det };
      delete copy.behavior;
      return copy;
    })
  };
}

function behaviorCounts(detections) {
  if (!detections?.length) return null;
  const known = detections.filter(det => Number.isInteger(det.behavior) && det.behavior >= 0 && det.behavior < 4 || LABELS.includes(det.behavior));
  if (!known.length) return null;
  return LABELS.map((label, index) => known.filter(det => det.behavior === index || det.behavior === label).length);
}

function renderIndividuals(detections) {
  const target = $('#individualRows');
  target.replaceChildren();
  if (!detections.length) {
    target.append(Object.assign(document.createElement('p'), { className: 'empty-data', textContent: '当前帧无鱼体实例' }));
    return;
  }
  detections.slice(0, 30).forEach((det, index) => {
    const row = document.createElement('div');
    row.className = 'individual-row';
    const category = Number.isInteger(det.behavior) && det.behavior >= 0 && det.behavior < 4 ? LABELS[det.behavior] : LABELS.includes(det.behavior) ? det.behavior : '待分析';
    const points = det.keypoints || [];
    const validCount = points.filter(pointValid).length;
    [String(det.id ?? index + 1), points.length ? `${validCount}/11` : '—', category].forEach(value => {
      const span = document.createElement('span');
      span.textContent = value;
      row.append(span);
    });
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
  if (state.running && key && key !== state.alertKey) addLog('行为状态提示', $('#riskReason').textContent + (finite(frameTime) ? `；时间 ${Number(frameTime).toFixed(2)} s` : ''), high ? 'danger' : 'warn');
  state.alertKey = key;
}

function applyBehaviorSummary(counts, activityScore, frameTime, latencyMs) {
  const total = counts ? counts.reduce((sum, value) => sum + value, 0) : 0;
  const leader = total > 0 ? counts.indexOf(Math.max(...counts)) : -1;
  $('#behaviorState').textContent = leader < 0 ? '待分析' : LABELS[leader];
  $('#behaviorRatio').textContent = leader < 0 ? '等待行为分析结果' : `占比 ${Math.round(counts[leader] / total * 100)}%`;
  $('#activityScore').textContent = finite(activityScore) ? clamp(activityScore).toFixed(2) : '—';
  const formatTest = state.data?.purpose === 'format-test';
  $('#latency').textContent = !formatTest && finite(latencyMs) ? `${latencyMs.toFixed(1)} ms` : '—';
  updateRisk(finite(activityScore) ? clamp(activityScore) : null, total > 0 ? counts[3] / total * 100 : null, frameTime);
  drawCharts(total > 0 ? counts : null);
}

function pushActivity(time, score) {
  if (!finite(time) || !finite(score)) return;
  if (state.series.some(point => point.t === time)) return;
  state.series.push({ t: time, v: clamp(score) });
  state.series = state.series.filter(point => point.t <= time).slice(-60);
  drawCharts();
}

function renderPose(frame) {
  state.frame = frame;
  const detections = frame?.detections || [];
  $('#fishCount').textContent = frame ? String(finite(frame.metrics?.fishCount) ? frame.metrics.fishCount : detections.length) : '—';
  const scores = detections.flatMap(det => det.keypoints || []).filter(pointValid).map(point => point[2]).filter(finite);
  $('#kpConf').textContent = scores.length ? (scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(2) : '—';
  const withBehavior = detections.map(det => ({ ...det, behavior: det.behavior }));
  renderIndividuals(withBehavior);
  drawOverlay();
}

function renderFrame(frame, acceptBehavior) {
  renderPose(frame);
  if (!acceptBehavior) return;
  const counts = behaviorCounts(frame?.detections) || (Array.isArray(frame?.metrics?.behavior) ? frame.metrics.behavior : null);
  applyBehaviorSummary(counts, frame?.metrics?.activityScore, frame?.time, frame?.metrics?.latencyMs);
  if (finite(frame?.metrics?.activityScore)) pushActivity(frame.time, frame.metrics.activityScore);
}

function drawBehavior(values) {
  const width = behavior.clientWidth;
  const height = behavior.clientHeight;
  bctx.clearRect(0, 0, width, height);
  const x = width / 2;
  const y = height / 2;
  const radius = Math.min(width, height) * 0.33;
  const total = values?.reduce((sum, value) => sum + value, 0) || 0;
  const colors = ['#6aa9ff', '#36d399', '#ffd166', '#ff5d73'];
  let start = -Math.PI / 2;
  if (!total) {
    bctx.beginPath();
    bctx.arc(x, y, radius, 0, Math.PI * 2);
    bctx.arc(x, y, radius * 0.62, 0, Math.PI * 2, true);
    bctx.fillStyle = 'rgba(255,255,255,.09)';
    bctx.fill();
  } else {
    values.forEach((value, index) => {
      if (!value) return;
      const end = start + value / total * Math.PI * 2;
      bctx.beginPath();
      bctx.arc(x, y, radius, start, end);
      bctx.arc(x, y, radius * 0.62, end, start, true);
      bctx.closePath();
      bctx.fillStyle = colors[index];
      bctx.fill();
      start = end;
    });
  }
  bctx.fillStyle = '#e8f7ff';
  bctx.textAlign = 'center';
  bctx.font = '700 26px sans-serif';
  bctx.fillText(total ? `${Math.round(Math.max(...values) / total * 100)}%` : '—', x, y + 8);
  bctx.fillStyle = '#8eb3c7';
  bctx.font = '14px sans-serif';
  bctx.fillText(total ? LABELS[values.indexOf(Math.max(...values))] : '等待分析', x, y + 32);
}

function drawActivity() {
  const width = activity.clientWidth;
  const height = activity.clientHeight;
  const pad = 32;
  actx.clearRect(0, 0, width, height);
  if (width <= pad * 2 || height <= pad * 2) return;
  actx.strokeStyle = 'rgba(144,220,255,.15)';
  actx.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = pad + index * (height - 2 * pad) / 4;
    actx.beginPath();
    actx.moveTo(pad, y);
    actx.lineTo(width - pad, y);
    actx.stroke();
  }
  const threshold = Number($('#activityThreshold').value);
  const thresholdY = pad + (1 - threshold) * (height - 2 * pad);
  actx.setLineDash([5, 5]);
  actx.strokeStyle = '#ffd166';
  actx.beginPath();
  actx.moveTo(pad, thresholdY);
  actx.lineTo(width - pad, thresholdY);
  actx.stroke();
  actx.setLineDash([]);
  const series = state.series;
  if (!series.length) return;
  const start = series[0].t;
  const span = Math.max(series[series.length - 1].t - start, 1e-6);
  actx.strokeStyle = '#45d6ff';
  actx.lineWidth = 2.5;
  actx.beginPath();
  series.forEach((point, index) => {
    const x = pad + (point.t - start) / span * (width - 2 * pad);
    const y = pad + (1 - point.v) * (height - 2 * pad);
    if (index) actx.lineTo(x, y);
    else actx.moveTo(x, y);
  });
  actx.stroke();
}

function drawCharts(values) {
  if (!values && state.frame) values = behaviorCounts(state.frame.detections) || state.frame.metrics?.behavior;
  drawBehavior(values);
  drawActivity();
}

function containBounds(srcW, srcH) {
  const width = pose.clientWidth;
  const height = pose.clientHeight;
  const scale = Math.min(width / srcW, height / srcH);
  const boxW = srcW * scale;
  const boxH = srcH * scale;
  return { x: (width - boxW) / 2, y: (height - boxH) / 2, w: boxW, h: boxH };
}

function pointValid(point) {
  if (!Array.isArray(point) || !finite(point[0]) || !finite(point[1])) return false;
  if (point.length < 3 || !finite(point[2])) return true;
  return point[2] >= Number($('#confThreshold').value);
}

function drawOverlay() {
  pctx.clearRect(0, 0, pose.clientWidth, pose.clientHeight);
  if (state.source === 'demo' && state.running) {
    const width = pose.clientWidth;
    const height = pose.clientHeight;
    state.demoFish.forEach((fish, index) => {
      fish.x += fish.vx;
      fish.y += fish.vy;
      if (fish.x < 40 || fish.x > width - 40) fish.vx *= -1;
      if (fish.y < 40 || fish.y > height - 40) fish.vy *= -1;
      const points = Array.from({ length: 11 }, (_, keypoint) => [fish.x + (keypoint - 5) * 6, fish.y + Math.sin(keypoint * 0.65 + state.demoTick * 0.2 + index) * 7, 0.9]);
      drawDetection({ bbox: [fish.x - 42, fish.y - 18, 84, 36], keypoints: points }, { x: 0, y: 0, w: width, h: height }, width, height);
    });
    return;
  }
  const frame = state.frame;
  if (!frame?.detections) return;
  const srcW = frame.videoWidth || state.data?.videoWidth || video.videoWidth;
  const srcH = frame.videoHeight || state.data?.videoHeight || video.videoHeight;
  if (!srcW || !srcH) return;
  const bounds = containBounds(srcW, srcH);
  frame.detections.forEach(det => drawDetection(det, bounds, srcW, srcH));
}

function drawDetection(det, bounds, srcW, srcH) {
  const px = value => bounds.x + value * bounds.w / srcW;
  const py = value => bounds.y + value * bounds.h / srcH;
  if ($('#showBoxes').checked && det.bbox) {
    const [x, y, boxW, boxH] = det.bbox;
    pctx.strokeStyle = '#36d399';
    pctx.lineWidth = 2;
    pctx.strokeRect(px(x), py(y), boxW * bounds.w / srcW, boxH * bounds.h / srcH);
  }
  if (!$('#showSkeleton').checked || !det.keypoints) return;
  pctx.strokeStyle = '#45d6ff';
  pctx.lineWidth = 2;
  SKELETON.forEach(([start, end]) => {
    const from = det.keypoints[start];
    const to = det.keypoints[end];
    if (!pointValid(from) || !pointValid(to)) return;
    pctx.beginPath();
    pctx.moveTo(px(from[0]), py(from[1]));
    pctx.lineTo(px(to[0]), py(to[1]));
    pctx.stroke();
  });
  pctx.fillStyle = '#ff5d73';
  det.keypoints.filter(pointValid).forEach(point => {
    pctx.beginPath();
    pctx.arc(px(point[0]), py(point[1]), 3, 0, Math.PI * 2);
    pctx.fill();
  });
  if (det.id !== undefined) {
    const anchor = det.keypoints.find(pointValid) || (det.bbox ? [det.bbox[0], det.bbox[1]] : null);
    if (anchor) {
      pctx.fillStyle = '#e8f7ff';
      pctx.font = '13px sans-serif';
      pctx.fillText(String(det.id), px(anchor[0]) + 6, py(anchor[1]) - 6);
    }
  }
}

function stepDemo() {
  state.demoTick += 1;
  const time = state.demoTick * STRIDE_SECONDS;
  const score = clamp(0.52 + Math.sin(state.demoTick * 0.28) * 0.17);
  const detections = state.demoFish.map((fish, index) => ({
    id: index + 1,
    behavior: time + 1e-6 >= WINDOW_SECONDS ? index % 4 : undefined,
    keypoints: Array.from({ length: 11 }, () => [0, 0, 0.9])
  }));
  const counts = behaviorCounts(detections);
  state.frame = { time, detections, metrics: { fishCount: detections.length, activityScore: time + 1e-6 >= WINDOW_SECONDS ? score : null, behavior: counts } };
  $('#fishCount').textContent = String(detections.length);
  renderIndividuals(detections);
  applyBehaviorSummary(counts, time + 1e-6 >= WINDOW_SECONDS ? score : null, time, null);
  if (time + 1e-6 >= WINDOW_SECONDS) pushActivity(time, score);
  drawOverlay();
}

function syncFileFrame() {
  if (state.paused || state.mode !== 'playback' || !state.data || !video.videoWidth) return;
  relocatePlayback(video.currentTime, state.running);
}

function relocatePlayback(time, record) {
  if (state.lastBehaviorTime !== null && time < state.lastBehaviorTime - 0.05) {
    state.series = [];
    state.lastBehaviorTime = null;
    state.alertKey = null;
  }
  const frame = nearestFrame(time);
  const view = frame ? withVisibleBehavior(frame, time) : null;
  renderPose(view);
  const countsNow = view ? behaviorCounts(view.detections) : null;
  if (!record) {
    applyBehaviorSummary(countsNow, countsNow ? frame?.metrics?.activityScore : null, time, null);
    return;
  }
  (state.data.frames || []).forEach(item => {
    if (item.time > time + 1e-3 || !finite(item.metrics?.activityScore)) return;
    if (!item.detections.some(det => behaviorVisible(det, time))) return;
    pushActivity(item.time, item.metrics.activityScore);
  });
  if (!view || !view.detections.some(det => Number.isInteger(det.behavior) || LABELS.includes(det.behavior))) {
    if (state.lastBehaviorTime === null) applyBehaviorSummary(null, null, time, null);
    return;
  }
  if (frame.time === state.lastBehaviorTime) return;
  state.lastBehaviorTime = frame.time;
  const counts = behaviorCounts(view.detections);
  renderIndividuals(view.detections);
  applyBehaviorSummary(counts, frame.metrics?.activityScore, frame.time, frame.metrics?.latencyMs);
}

function behaviorRecordValid(record, time) {
  if (!record || !finite(record.window_end_time)) return false;
  if (record.window_end_time > time + 1e-3) return false;
  if (time - record.window_end_time > STRIDE_SECONDS + 1e-3) return false;
  return Number.isInteger(record.behavior) && record.behavior >= 0 && record.behavior < 4;
}

function applyLivePose(message) {
  if (!state.running || state.paused || state.mode !== 'analyze') return;
  const entry = {
    time: message.time,
    videoWidth: message.videoWidth,
    videoHeight: message.videoHeight,
    detections: message.detections || [],
    metrics: { fishCount: message.fishCount },
    latencyMs: message.latencyMs
  };
  state.poseBuffer.push(entry);
  state.poseBuffer = state.poseBuffer.filter(item => message.time - item.time <= WINDOW_SECONDS * 4).slice(-180);
  if (finite(message.latencyMs)) $('#latency').textContent = `${Number(message.latencyMs).toFixed(1)} ms`;
  if (state.source === 'file') {
    syncAnalyzeFrame();
    return;
  }
  renderLiveAt(message.time, entry);
}

function renderLiveAt(time, poseFrame) {
  const detectionsSource = poseFrame?.detections || [];
  if (poseFrame) {
    const seen = new Set(detectionsSource.map(det => det.id));
    Object.keys(state.behaviorById).forEach(id => {
      const key = Number.isNaN(Number(id)) ? id : Number(id);
      if (!seen.has(key) && !seen.has(id)) delete state.behaviorById[id];
      else if (!behaviorRecordValid(state.behaviorById[id], time)) delete state.behaviorById[id];
    });
  }
  const detections = detectionsSource.map(det => {
    const record = state.behaviorById[det.id];
    return behaviorRecordValid(record, time) ? { ...det, behavior: record.behavior } : { ...det, behavior: undefined };
  });
  state.frame = { detections, videoWidth: poseFrame?.videoWidth, videoHeight: poseFrame?.videoHeight, metrics: { fishCount: poseFrame?.metrics?.fishCount } };
  state.liveDetections = detections;
  renderPose(state.frame);
  const counts = behaviorCounts(detections);
  renderIndividuals(detections);
  applyBehaviorSummary(counts, counts ? state.lastActivity : null, time, poseFrame?.latencyMs);
}

function syncAnalyzeFrame() {
  if (state.mode !== 'analyze' || state.source !== 'file') return;
  const time = video.currentTime || 0;
  const past = state.poseBuffer.filter(item => finite(item.time) && item.time <= time + 1e-3);
  renderLiveAt(time, past.length ? past[past.length - 1] : null);
  state.pendingBehavior = state.pendingBehavior.filter(message => {
    if (message.windowEnd > time + 1e-3) return true;
    commitBehavior(message);
    return false;
  });
}

function commitBehavior(message) {
  if (!finite(message.windowEnd) || message.windowEnd === state.lastBehaviorTime) return;
  const now = Math.max(finite(message.time) ? message.time : 0, message.windowEnd);
  (message.tracks || []).forEach(track => {
    if (finite(track.window_end_time) && track.window_end_time <= now + 1e-3) state.behaviorById[track.id] = track;
  });
  state.lastBehaviorTime = message.windowEnd;
  if (finite(message.activityScore)) state.lastActivity = message.activityScore;
  const poseFrame = state.source === 'file'
    ? [...state.poseBuffer].reverse().find(item => item.time <= (video.currentTime || 0) + 1e-3)
    : state.poseBuffer[state.poseBuffer.length - 1];
  renderLiveAt(state.source === 'file' ? (video.currentTime || 0) : now, poseFrame || null);
  const counts = behaviorCounts(state.frame?.detections);
  applyBehaviorSummary(counts, message.activityScore, message.windowEnd, message.latencyMs);
  if (finite(message.activityScore)) pushActivity(message.windowEnd, message.activityScore);
}

function applyLiveBehavior(message) {
  if (!state.running || state.paused || state.mode !== 'analyze') return;
  if (!finite(message.windowEnd)) return;
  if (state.source === 'file' && (video.currentTime || 0) + 1e-3 < message.windowEnd) {
    if (!state.pendingBehavior.some(item => item.windowEnd === message.windowEnd)) state.pendingBehavior.push(message);
    return;
  }
  commitBehavior(message);
}

function applyServiceStatus(message) {
  state.service = message;
  if (message.state === 'running') {
    state.running = true;
    state.paused = false;
  } else if (message.state === 'paused') {
    state.running = false;
    state.paused = true;
  } else if (message.state === 'stopped' || message.state === 'error' || message.state === 'ready') {
    if (message.state !== 'ready') state.running = false;
    if (message.state === 'stopped' || message.state === 'error') state.paused = false;
  }
  updateSourceUI();
}

async function uploadVideo(file) {
  const headers = authHeaders({ 'X-Filename': encodeURIComponent(file.name) });
  const response = await fetch('/api/upload', { method: 'POST', headers, body: file });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || '视频上传失败');
    error.payload = payload;
    throw error;
  }
  state.uploadId = payload.uploadId;
  return payload.uploadId;
}

async function startMonitor() {
  const analyze = state.source === 'file' && $('#backendAnalyze').checked;
  const mode = state.source === 'demo' ? 'demo' : state.source === 'camera' ? 'preview' : state.source === 'ipc' ? 'camera' : analyze ? 'analyze' : state.data ? 'playback' : 'preview';
  if (mode === 'playback' && !state.data) {
    await addLog('系统异常', '本地结果回放需要导入分析结果。', 'warn');
    return;
  }
  if (mode === 'analyze') {
    if (!state.videoFile) throw Error('后端没有可读取的视频文件');
    const uploadId = await uploadVideo(state.videoFile);
    const source = await request(API.source, { method: 'POST', body: JSON.stringify({ type: 'file', name: state.videoFile.name, analyze: true, uploadId }) });
    state.service = source.status;
    if (source.log && source.created !== false) showLog(source.log);
  }
  const result = await request(API.start, { method: 'POST', body: JSON.stringify({ mode, uploadId: state.uploadId }) });
  state.service = result.status;
  state.mode = mode === 'preview' && state.source === 'file' ? 'preview' : mode === 'camera' ? 'analyze' : mode;
  state.running = true;
  state.paused = false;
  if (result.log && result.created !== false) showLog(result.log);
  if (state.source === 'file') video.play().catch(() => addLog('播放提示', '浏览器阻止自动播放，请使用视频控件播放。', 'warn'));
  if (state.mode === 'demo' && !state.demoFish.length) {
    const width = pose.clientWidth;
    const height = pose.clientHeight;
    state.demoFish = Array.from({ length: 9 }, (_, index) => ({ x: 60 + (index % 3) * (width - 120) / 3, y: 65 + Math.floor(index / 3) * (height - 130) / 3, vx: (index % 2 ? 1 : -1) * 0.7, vy: 0.35 }));
  }
  updateSourceUI();
}

async function pauseMonitor() {
  const result = await request(API.pause, { method: 'POST', body: '{}' });
  state.service = result.status;
  state.running = false;
  state.paused = true;
  if (state.source === 'file') video.pause();
  if (result.log && result.created !== false) showLog(result.log);
  updateSourceUI();
}

async function resumeMonitor() {
  const result = await request(API.resume, { method: 'POST', body: '{}' });
  state.service = result.status;
  state.running = true;
  state.paused = false;
  if (state.source === 'file' && state.mode === 'playback') video.play().catch(() => {});
  if (result.log && result.created !== false) showLog(result.log);
  updateSourceUI();
}

async function stopMonitor() {
  const result = await request(API.stop, { method: 'POST', body: '{}' });
  state.service = result.status;
  state.running = false;
  state.paused = false;
  state.mode = 'idle';
  if (state.source === 'file') {
    video.pause();
    video.currentTime = 0;
  }
  clearResults();
  if (result.log && result.created !== false) showLog(result.log);
  updateSourceUI();
}

function connectSocket() {
  if (location.protocol === 'file:') return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = sessionStorage.getItem('monitorToken');
  const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
  const socket = new WebSocket(`${protocol}//${location.host}${API.ws}${suffix}`);
  state.socket = socket;
  socket.onopen = () => { state.backend = true; updateSourceUI(); };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'status') applyServiceStatus(message);
    if (message.type === 'pose') applyLivePose(message);
    if (message.type === 'behavior') applyLiveBehavior(message);
  };
  socket.onclose = () => {
    state.socket = null;
    state.backend = false;
    if (state.mode === 'analyze') {
      state.running = false;
      state.paused = false;
      state.service = { ...(state.service || {}), state: 'error', engine: '未加载', poseModel: '模型加载失败', behaviorModel: '模型加载失败' };
      addLog('系统异常', '分析连接已断开，监测结果停止更新。', 'danger');
    }
    updateSourceUI();
    setTimeout(connectSocket, 2000);
  };
}

async function syncParams() {
  if (state.applyingParams || !state.backend) return;
  const body = {
    activityThreshold: Number($('#activityThreshold').value),
    turnThreshold: Number($('#turnThreshold').value),
    confThreshold: Number($('#confThreshold').value),
    fps: FPS,
    windowFrames: WINDOW_FRAMES,
    strideFrames: STRIDE_FRAMES
  };
  try {
    const result = await request(API.params, { method: 'POST', body: JSON.stringify(body) });
    if (state.service) state.service.params = result.params;
  } catch (error) {
    state.backend = false;
    updateSourceUI();
  }
}

function applyRemoteParams(params) {
  if (!params) return;
  state.applyingParams = true;
  $('#activityThreshold').value = params.activityThreshold;
  $('#turnThreshold').value = params.turnThreshold;
  $('#confThreshold').value = params.confThreshold;
  $('#activityValue').textContent = Number(params.activityThreshold).toFixed(2);
  $('#turnValue').textContent = `${params.turnThreshold}%`;
  $('#confValue').textContent = Number(params.confThreshold).toFixed(2);
  state.applyingParams = false;
}

$('#sourceSelect').addEventListener('change', event => chooseSource(event.target.value));
$('#videoInput').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  video.src = state.objectUrl;
  video.srcObject = null;
  state.data = null;
  state.videoFile = file;
  state.uploadId = '';
  clearResults();
  $('#jsonInput').value = '';
  $('#videoName').textContent = file.name;
  video.load();
  try {
    const result = await request(API.source, { method: 'POST', body: JSON.stringify({ type: 'file', name: file.name, analyze: false }) });
    state.backend = true;
    state.service = result.status;
    if (result.log && result.created !== false) showLog(result.log);
  } catch (error) {
    state.backend = false;
    await addLog('系统异常', error.message || '无法登记视频数据源。', 'danger');
  }
  updateSourceUI();
});
$('#jsonInput').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = normalizeJSON(JSON.parse(await file.text()));
    state.data = parsed;
    clearResults();
    updateSourceUI();
    await addLog('视频数据源接入', `已导入分析结果：${file.name}${parsed.purpose === 'format-test' ? '（测试数据）' : ''}`);
  } catch (error) {
    state.data = null;
    clearResults();
    updateSourceUI();
    await addLog('系统异常', error.message, 'danger');
  }
});
$('#backendAnalyze').addEventListener('change', updateSourceUI);
$('#togglePlayBtn').addEventListener('click', async () => {
  try {
    if (state.running) await pauseMonitor();
    else if (state.paused) await resumeMonitor();
    else await startMonitor();
  } catch (error) {
    state.running = false;
    state.service = error.payload?.status || state.service;
    updateSourceUI();
    if (error.payload?.log && error.payload.created !== false) showLog(error.payload.log);
    else await addLog('模型加载失败', error.message, 'danger');
  }
});
$('#stopBtn').addEventListener('click', () => stopMonitor().catch(error => addLog('系统异常', error.message, 'danger')));
$('#clearLog').addEventListener('click', async () => {
  $('#eventLog').replaceChildren();
  if (state.backend) {
    try { await request(API.logs, { method: 'DELETE' }); } catch (error) { state.backend = false; }
  }
});
['showBoxes', 'showSkeleton', 'confThreshold'].forEach(id => $('#' + id).addEventListener('input', () => {
  if (id === 'confThreshold') $('#confValue').textContent = Number($('#confThreshold').value).toFixed(2);
  if (state.frame) renderIndividuals(state.frame.detections || []);
  drawOverlay();
  if (id === 'confThreshold') syncParams();
}));
['activityThreshold', 'turnThreshold'].forEach(id => $('#' + id).addEventListener('input', () => {
  $('#activityValue').textContent = Number($('#activityThreshold').value).toFixed(2);
  $('#turnValue').textContent = `${$('#turnThreshold').value}%`;
  if (state.frame) renderFrame(state.frame, false);
  else drawCharts();
  syncParams();
}));
$$('.nav-item').forEach(item => item.addEventListener('click', () => {
  $$('.nav-item').forEach(node => node.classList.remove('active'));
  item.classList.add('active');
  document.getElementById(item.dataset.target).scrollIntoView({ behavior: 'smooth', block: 'start' });
}));
video.addEventListener('timeupdate', () => {
  if (state.paused) return;
  syncFileFrame();
  syncAnalyzeFrame();
});
video.addEventListener('seeked', () => {
  state.lastBehaviorTime = null;
  state.series = [];
  state.alertKey = null;
  if (state.mode === 'playback') relocatePlayback(video.currentTime, false);
  if (state.mode === 'analyze') syncAnalyzeFrame();
});
video.addEventListener('ended', () => {
  if (state.running && state.mode === 'playback') stopMonitor();
});
window.addEventListener('resize', () => {
  [pose, behavior, activity].forEach(resizeCanvas);
  drawCharts();
  drawOverlay();
});
[pose, behavior, activity].forEach(resizeCanvas);
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); }, 1000);
setInterval(() => { if (state.running && state.mode === 'demo') stepDemo(); }, STRIDE_SECONDS * 1000);
$('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('token')) {
    sessionStorage.setItem('monitorToken', params.get('token'));
    params.delete('token');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
  }
  try {
    const status = await request(API.status);
    state.backend = true;
    state.service = status;
    const sourceMap = { preview: 'camera', camera: 'ipc', file: 'file', demo: 'demo', none: 'none' };
    const uiSource = sourceMap[status.source?.type] || 'none';
    if (uiSource !== 'none') {
      state.source = uiSource;
      $('#sourceSelect').value = uiSource;
    }
    state.running = status.state === 'running';
    state.paused = status.state === 'paused';
    state.mode = status.state === 'running' || status.state === 'paused' ? status.mode : 'idle';
    if (state.mode === 'demo' && (state.running || state.paused) && !state.demoFish.length) {
      const width = pose.clientWidth;
      const height = pose.clientHeight;
      state.demoFish = Array.from({ length: 9 }, (_, index) => ({ x: 60 + (index % 3) * (width - 120) / 3, y: 65 + Math.floor(index / 3) * (height - 130) / 3, vx: (index % 2 ? 1 : -1) * 0.7, vy: 0.35 }));
    }
    applyRemoteParams(status.params);
    const logs = await request(`${API.logs}?limit=80`);
    logs.logs.slice().reverse().forEach(showLog);
  } catch (error) {
    state.backend = false;
    showLog({ time: new Date().toISOString(), type: '系统异常', message: '后端未连接。', level: 'danger' });
  }
  updateSourceUI();
  drawCharts();
  connectSocket();
}

boot();
