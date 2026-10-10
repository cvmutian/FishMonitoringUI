import importlib
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np

from pose_adapter import PoseService

WINDOW_FRAMES = 96
STRIDE_FRAMES = 48
FPS = 30


class TrackBank:
    def __init__(self, config):
        self.config = config
        self.active = []
        self.next_id = 1

    def reset(self):
        self.active = []
        self.next_id = 1

    def update(self, frame_number, detections):
        association_cost = importlib.import_module("data.association").association_cost
        linear_sum_assignment = importlib.import_module("data.association").linear_sum_assignment
        max_missing = int(self.config["association"]["max_missing_frames"])
        max_cost = float(self.config["association"]["max_cost"])
        matched_tracks = set()
        matched_detections = set()
        if self.active and detections:
            cost = np.zeros((len(self.active), len(detections)), dtype=np.float64)
            for row, track in enumerate(self.active):
                for col, detection in enumerate(detections):
                    cost[row, col] = association_cost(track["last"], detection["keypoints"], detection["box"], self.config)
            rows, cols = linear_sum_assignment(cost)
            for row, col in zip(rows, cols):
                if cost[row, col] > max_cost:
                    continue
                track = self.active[row]
                detection = detections[col]
                track["last"] = detection["keypoints"]
                track["missing"] = 0
                detection["id"] = track["track_id"]
                matched_tracks.add(row)
                matched_detections.add(col)
        present = []
        absent = []
        dropped = []
        survivors = []
        for row, track in enumerate(self.active):
            if row in matched_tracks:
                survivors.append(track)
                continue
            track["missing"] += 1
            if track["missing"] > max_missing:
                dropped.append(track["track_id"])
            else:
                survivors.append(track)
                absent.append(track["track_id"])
        self.active = survivors
        for col, detection in enumerate(detections):
            if col in matched_detections:
                present.append(detection)
                continue
            track_id = self.next_id
            self.next_id += 1
            detection["id"] = track_id
            self.active.append({"track_id": track_id, "last": detection["keypoints"], "missing": 0})
            present.append(detection)
        return present, absent, dropped


class AnalysisTask:
    def __init__(self):
        self.runtime = None
        self.lock = None
        self.broadcast = None
        self.add_log = None
        self.pose = PoseService()
        self.stop_event = threading.Event()
        self.pause_event = threading.Event()
        self.thread = None
        self.capture = None
        self.tracks = None

    def bind(self, runtime, lock, broadcast, add_log, pose):
        self.runtime = runtime
        self.lock = lock
        self.broadcast = broadcast
        self.add_log = add_log
        self.pose = pose

    def busy(self):
        return self.thread is not None and self.thread.is_alive()

    def start_file(self, path):
        self._start({"kind": "file", "path": str(path)})

    def start_camera(self, index):
        self._start({"kind": "camera", "index": int(index)})

    def pause(self):
        self.pause_event.set()

    def resume(self):
        self.pause_event.clear()

    def stop(self):
        self.stop_event.set()
        self.pause_event.clear()
        thread = self.thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=3)
        self._release()
        self._reset_tracks()

    def _start(self, source):
        self.stop()
        if not self.pose.ready:
            raise RuntimeError(self.pose.detail or "姿态模型不可执行推理")
        analyzer = self.runtime.get("behavior")
        if analyzer is None:
            raise RuntimeError(self.runtime.get("behaviorDetail") or "行为模型不可执行推理")
        try:
            importlib.import_module("cv2")
        except Exception as exc:
            raise RuntimeError("未安装视频采集库") from exc
        self.stop_event = threading.Event()
        self.pause_event = threading.Event()
        self.tracks = TrackBank(analyzer.config)
        self.thread = threading.Thread(target=self._loop, args=(source,), daemon=True)
        self.thread.start()

    def _loop(self, source):
        cv2 = importlib.import_module("cv2")
        capture = None
        try:
            capture = cv2.VideoCapture(source["path"] if source["kind"] == "file" else int(source["index"]))
            self.capture = capture
            if not capture.isOpened():
                self._fail("视频流异常", "视频读取失败")
                return
            reported = float(capture.get(cv2.CAP_PROP_FPS) or 0)
            behavior_fps = abs(reported - FPS) < 1.0
            if not behavior_fps:
                self.add_log("视频流异常", "视频帧率不是 30，已停止行为分析。", "warn")
            frame_idx = 0
            while not self.stop_event.is_set():
                if self.pause_event.is_set() or self.runtime.get("state") == "paused":
                    time.sleep(0.05)
                    continue
                if self.runtime.get("state") != "running":
                    break
                started = time.perf_counter()
                ok, frame = capture.read()
                if not ok or frame is None:
                    self._finish("视频读取结束，监测已停止。")
                    return
                self._process(frame, frame_idx, behavior_fps, (time.perf_counter() - started) * 1000.0)
                frame_idx += 1
                if behavior_fps:
                    remain = (1.0 / FPS) - (time.perf_counter() - started)
                    if remain > 0:
                        time.sleep(remain)
        except Exception as exc:
            self._fail("系统异常", str(exc)[:300])
        finally:
            if capture is not None:
                capture.release()
            if self.capture is capture:
                self.capture = None

    def _process(self, frame, frame_idx, behavior_fps, latency_ms):
        detections = self.pose.infer(frame)
        height, width = frame.shape[:2]
        prepared = []
        for detection in detections:
            keypoints = np.asarray(detection["keypoints"], dtype=np.float32)
            if keypoints.shape != (11, 3):
                raise RuntimeError("姿态结果不是 11 个关键点")
            x, y, box_w, box_h = detection["bbox"]
            prepared.append({
                "keypoints": keypoints,
                "box": np.asarray([x, y, x + box_w, y + box_h], dtype=np.float64),
                "bbox": [float(x), float(y), float(box_w), float(box_h)],
                "score": float(detection.get("score") or 0),
            })
        present, absent_ids, dropped_ids = self.tracks.update(frame_idx, prepared)
        analyzer = self.runtime.get("behavior")
        behavior_rows = []
        current = []
        updated = False
        if analyzer is not None and behavior_fps:
            for track_id in dropped_ids:
                analyzer._drop(track_id)
            for track_id in absent_ids:
                analyzer.update(track_id, None, frame_idx)
            for detection in present:
                result = analyzer.update(detection["id"], detection["keypoints"], frame_idx)
                if result.get("updated"):
                    updated = True
                if _current_behavior(result, frame_idx):
                    current.append(result)
                    behavior_rows.append(_behavior_row(result, analyzer))
            analyzer.cleanup(frame_idx)
        stamp = frame_idx / float(FPS)
        self.broadcast({
            "type": "pose",
            "frame": frame_idx,
            "time": stamp,
            "videoWidth": int(width),
            "videoHeight": int(height),
            "fishCount": len(present),
            "latencyMs": round(float(latency_ms), 1),
            "detections": [{
                "id": detection["id"],
                "bbox": detection["bbox"],
                "keypoints": detection["keypoints"].astype(float).tolist(),
                "score": detection["score"],
            } for detection in present],
        })
        if not updated:
            return
        summary = analyzer.summarize(current)
        names = list(analyzer.behavior_names)
        counts = [int(summary["behaviors"][name]["count"]) for name in names]
        ratios = [float(summary["behaviors"][name]["ratio"]) for name in names]
        window_end = (frame_idx + 1) / float(analyzer.fps)
        self.broadcast({
            "type": "behavior",
            "time": window_end,
            "windowEnd": window_end,
            "tracks": behavior_rows,
            "counts": counts,
            "ratios": ratios,
            "dominant": summary["activity"].get("dominant_behavior"),
            "activityScore": _activity_score(current, analyzer.config),
            "latencyMs": round(float(latency_ms), 1),
        })
        with self.lock:
            self.runtime["latencyMs"] = round(float(latency_ms), 1)

    def _finish(self, message):
        with self.lock:
            if self.runtime.get("state") == "running":
                self.runtime["state"] = "stopped"
                self.runtime["mode"] = "idle"
                self.runtime["message"] = message
                self.runtime["latencyMs"] = None
        self.add_log("监测停止", message, "info")
        self.broadcast({"type": "status", **_public(self.runtime)})

    def _fail(self, event_type, message):
        with self.lock:
            self.runtime["state"] = "error"
            self.runtime["message"] = message
            self.runtime["latencyMs"] = None
        self.add_log(event_type, message, "danger")
        self.broadcast({"type": "status", **_public(self.runtime)})

    def _release(self):
        capture = self.capture
        self.capture = None
        if capture is not None:
            capture.release()

    def _reset_tracks(self):
        if self.tracks is not None:
            self.tracks.reset()
        analyzer = None if self.runtime is None else self.runtime.get("behavior")
        if analyzer is None:
            return
        for track_id in list(getattr(analyzer, "buffers", {})):
            analyzer._drop(track_id)


def probe_behavior():
    root = os.environ.get("FISH_BEHAVIOR_ROOT", "").strip()
    weights = os.environ.get("FISH_BEHAVIOR_WEIGHTS", "").strip()
    if not root:
        sibling = Path(__file__).resolve().parent / "behavior_analysis" / "online_analyzer.py"
        if sibling.is_file():
            root = str(sibling.parent)
    if not weights or not root:
        return "未找到模型文件", None, "未设置 FISH_BEHAVIOR_WEIGHTS 或行为分析项目", None
    weight_path = Path(weights)
    module = Path(root) / "online_analyzer.py"
    if not weight_path.is_file() or not module.is_file():
        return "未找到模型文件", None, "行为分析权重或项目文件不存在", None
    try:
        if root not in sys.path:
            sys.path.insert(0, root)
        analyzer_cls = importlib.import_module("online_analyzer").OnlineBehaviorAnalyzer
        analyzer = analyzer_cls(str(weight_path))
        if int(analyzer.window_size) != WINDOW_FRAMES or int(analyzer.stride) != STRIDE_FRAMES:
            raise RuntimeError("行为模型窗口不是 96 帧、步长不是 48 帧")
        if list(analyzer.behavior_names) != ["低活动", "正常游动", "快速游动", "急转避让"]:
            raise RuntimeError("行为类别与四类定义不一致")
        if not hasattr(analyzer, "predictor") or analyzer.predictor.model is None:
            raise RuntimeError("行为模型未完成初始化")
    except Exception as exc:
        text = str(exc).strip() or exc.__class__.__name__
        return "模型加载失败", None, text[:300], None
    return "可执行推理", analyzer, "", analyzer.config


def _current_behavior(result, frame_idx):
    if int(result.get("behavior_id", -1)) < 0 or result.get("update_frame") is None:
        return False
    return 0 <= int(frame_idx) - int(result["update_frame"]) <= STRIDE_FRAMES


def _behavior_row(result, analyzer):
    end = int(result["update_frame"])
    start = end - (int(analyzer.window_size) - 1)
    fps = float(analyzer.fps)
    return {
        "id": result["track_id"],
        "behavior": int(result["behavior_id"]),
        "confidence": float(result["confidence"]),
        "window_start_frame": start,
        "window_end_frame": end,
        "window_start_time": start / fps,
        "window_end_time": (end + 1) / fps,
    }


def _activity_score(rows, config):
    speeds = []
    for row in rows:
        kinematics = row.get("kinematics") or {}
        if "speed" in kinematics:
            speeds.append(float(kinematics["speed"]))
    if not speeds:
        return None
    scale = float((config.get("aux_norm") or {}).get("speed") or 0)
    if scale <= 0:
        return None
    return max(0.0, min(1.0, sum(speeds) / len(speeds) / scale))


def _public(runtime):
    source = runtime.get("source") or {}
    return {
        "ok": True,
        "state": runtime.get("state"),
        "mode": runtime.get("mode"),
        "source": {key: value for key, value in source.items() if key != "path"},
        "sourceConnected": bool(source.get("connected")),
        "poseModel": runtime.get("poseModel"),
        "behaviorModel": runtime.get("behaviorModel"),
        "poseDetail": runtime.get("poseDetail") or "",
        "behaviorDetail": runtime.get("behaviorDetail") or "",
        "engine": runtime.get("engine"),
        "latencyMs": runtime.get("latencyMs"),
        "task": runtime.get("state"),
        "message": runtime.get("message") or "",
        "params": runtime.get("params"),
        "windowFrames": WINDOW_FRAMES,
        "strideFrames": STRIDE_FRAMES,
        "fps": FPS,
    }


TASK = AnalysisTask()
