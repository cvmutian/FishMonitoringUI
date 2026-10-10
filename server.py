import base64
import hashlib
import json
import os
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
LOG_PATH = ROOT / "server_data" / "events.jsonl"
HOST = "127.0.0.1"
PORT = 8080
FPS = 30
WINDOW_FRAMES = 96
STRIDE_FRAMES = 48
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
BEHAVIOR_NAMES = ["低活动", "正常游动", "快速游动", "急转避让"]

LOCK = threading.Lock()
CLIENTS = set()
LOGS = []
RUNTIME = {
    "state": "ready",
    "source": {"type": "none", "name": "", "connected": False, "analyze": False},
    "mode": "idle",
    "params": {
        "activityThreshold": 0.72,
        "turnThreshold": 18,
        "confThreshold": 0.5,
        "fps": FPS,
        "windowFrames": WINDOW_FRAMES,
        "strideFrames": STRIDE_FRAMES,
    },
    "poseModel": "模型未加载",
    "behaviorModel": "模型未加载",
    "engine": "未加载",
    "latencyMs": None,
    "message": "",
    "behavior": None,
}


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def load_logs():
    if not LOG_PATH.is_file():
        return
    for line in LOG_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            LOGS.append(json.loads(line))
        except json.JSONDecodeError:
            continue


def add_log(event_type, message, level="info"):
    entry = {"time": now_iso(), "type": event_type, "message": message, "level": level}
    with LOCK:
        if LOGS and LOGS[-1]["type"] == entry["type"] and LOGS[-1]["message"] == entry["message"]:
            return LOGS[-1], False
        LOGS.append(entry)
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry, True


def probe_models():
    pose_status, engine = "模型未加载", "未加载"
    behavior_status = "模型未加载"
    analyzer = None
    engine_path = os.environ.get("FISHPOSE_ENGINE", "")
    weights = os.environ.get("FISHPOSE_WEIGHTS", "")
    pose_root = os.environ.get("FISHPOSE_ROOT", "")
    if engine_path:
        if not Path(engine_path).is_file():
            pose_status = "模型未加载"
        else:
            try:
                import importlib
                importlib.import_module("tensorrt")
                pose_status = "分析服务不可用"
                engine = "未加载"
            except Exception:
                pose_status = "模型未加载"
                engine = "未加载"
    elif weights or pose_root:
        pose_file = Path(pose_root) / "models" / "fish_pose_model.py" if pose_root else None
        weight_file = Path(weights) if weights else None
        if weight_file and weight_file.is_file() and pose_file and pose_file.is_file():
            pose_status = "分析服务不可用"
        else:
            pose_status = "模型未加载"
    behavior_root = os.environ.get("FISH_BEHAVIOR_ROOT", "")
    behavior_weights = os.environ.get("FISH_BEHAVIOR_WEIGHTS", "")
    if behavior_root or behavior_weights:
        weight_file = Path(behavior_weights) if behavior_weights else None
        module = Path(behavior_root) / "online_analyzer.py" if behavior_root else None
        if not (weight_file and weight_file.is_file() and module and module.is_file()):
            behavior_status = "模型未加载"
        else:
            try:
                sys.path.insert(0, behavior_root)
                from online_analyzer import OnlineBehaviorAnalyzer
                analyzer = OnlineBehaviorAnalyzer(behavior_weights)
                behavior_status = "已加载"
            except Exception:
                behavior_status = "分析服务不可用"
                analyzer = None
    return pose_status, behavior_status, engine, analyzer


def models_ready():
    return RUNTIME["poseModel"] == "已加载" and RUNTIME["behaviorModel"] == "已加载"


def public_status():
    source = RUNTIME["source"]
    return {
        "ok": True,
        "state": RUNTIME["state"],
        "mode": RUNTIME["mode"],
        "source": source,
        "sourceConnected": bool(source.get("connected")),
        "poseModel": RUNTIME["poseModel"],
        "behaviorModel": RUNTIME["behaviorModel"],
        "engine": RUNTIME["engine"],
        "latencyMs": RUNTIME["latencyMs"],
        "task": RUNTIME["state"],
        "message": RUNTIME["message"],
        "params": RUNTIME["params"],
        "windowFrames": WINDOW_FRAMES,
        "strideFrames": STRIDE_FRAMES,
        "fps": FPS,
    }


class WsClient:
    def __init__(self, writer):
        self.writer = writer
        self.lock = threading.Lock()

    def send_packet(self, packet):
        with self.lock:
            self.writer.write(packet)
            self.writer.flush()


def broadcast(payload):
    packet = encode_ws(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    for client in list(CLIENTS):
        try:
            client.send_packet(packet)
        except Exception:
            CLIENTS.discard(client)


def publish_status():
    message = public_status()
    message["type"] = "status"
    message["timestamp"] = now_iso()
    broadcast(message)


def encode_ws(payload: bytes) -> bytes:
    length = len(payload)
    if length < 126:
        header = bytes([0x81, length])
    elif length < 65536:
        header = bytes([0x81, 126]) + length.to_bytes(2, "big")
    else:
        header = bytes([0x81, 127]) + length.to_bytes(8, "big")
    return header + payload


def read_ws_frame(reader):
    header = reader.read(2)
    if len(header) < 2:
        return None
    opcode = header[0] & 0x0F
    masked = header[1] & 0x80
    length = header[1] & 0x7F
    if length == 126:
        length = int.from_bytes(reader.read(2), "big")
    elif length == 127:
        length = int.from_bytes(reader.read(8), "big")
    mask = reader.read(4) if masked else b""
    data = reader.read(length)
    if masked and mask:
        data = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
    return opcode, data


def probe_camera(index=0):
    try:
        import cv2
    except Exception:
        return False, "未安装视频采集库"
    capture = cv2.VideoCapture(index)
    opened = bool(capture.isOpened())
    capture.release()
    if opened:
        return True, "摄像头已连接"
    return False, "摄像头不可用"


class MonitorHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/ws":
            self._websocket()
            return
        if parsed.path == "/api/status":
            self._json(public_status())
            return
        if parsed.path == "/api/logs":
            query = parse_qs(parsed.query)
            limit = int(query.get("limit", ["80"])[0] or 80)
            with LOCK:
                rows = list(reversed(LOGS[-max(1, min(limit, 200)):]))
            self._json({"ok": True, "logs": rows})
            return
        self._static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        body = self._body()
        if parsed.path == "/api/source":
            self._set_source(body)
            return
        if parsed.path == "/api/monitor/start":
            self._start(body)
            return
        if parsed.path == "/api/monitor/pause":
            self._transition("paused", "监测暂停", "监测已暂停", ("running",))
            return
        if parsed.path == "/api/monitor/resume":
            self._transition("running", "监测恢复", "监测已恢复", ("paused",))
            return
        if parsed.path == "/api/monitor/stop":
            self._stop()
            return
        if parsed.path == "/api/params":
            self._params(body)
            return
        if parsed.path == "/api/logs":
            entry, created = add_log(str(body.get("type") or "系统事件"), str(body.get("message") or ""), str(body.get("level") or "info"))
            self._json({"ok": True, "created": created, "log": entry})
            return
        if parsed.path == "/api/frame":
            self._frame()
            return
        self._json({"ok": False, "message": "未知接口"}, 404)

    def do_DELETE(self):
        if urlparse(self.path).path != "/api/logs":
            self._json({"ok": False, "message": "未知接口"}, 404)
            return
        with LOCK:
            LOGS.clear()
            if LOG_PATH.is_file():
                LOG_PATH.unlink()
        self._json({"ok": True})

    def _set_source(self, body):
        kind = str(body.get("type") or "none")
        name = str(body.get("name") or "")
        analyze = bool(body.get("analyze"))
        connected = kind in {"file", "preview", "demo"}
        message = ""
        level = "info"
        if kind == "camera":
            connected, message = probe_camera(int(body.get("index") or 0))
            level = "info" if connected else "danger"
        elif kind == "file":
            message = f"本地视频已登记：{name or '未命名'}"
        elif kind == "preview":
            message = "本机摄像头仅作预览，未执行模型推理。"
        elif kind == "demo":
            message = "界面演示数据源已登记。"
        elif kind == "none":
            message = "数据源已清空。"
        else:
            self._json({"ok": False, "message": "不支持的数据源"}, 400)
            return
        with LOCK:
            RUNTIME["source"] = {"type": kind, "name": name, "connected": connected, "analyze": analyze}
            if RUNTIME["state"] in {"stopped", "error"}:
                RUNTIME["state"] = "ready"
            RUNTIME["message"] = message
        event_type = "视频流异常" if kind == "camera" and not connected else "视频数据源接入"
        entry, created = add_log(event_type, message, level)
        publish_status()
        self._json({"ok": connected or kind in {"none", "file", "preview", "demo"}, "status": public_status(), "log": entry, "created": created})

    def _start(self, body):
        mode = str(body.get("mode") or "playback")
        if mode in {"analyze", "camera"} and not models_ready():
            with LOCK:
                RUNTIME["state"] = "error"
                RUNTIME["mode"] = mode
                RUNTIME["message"] = "模型未加载或分析服务不可用，未启动监测。"
                RUNTIME["latencyMs"] = None
            entry, created = add_log("模型加载失败", RUNTIME["message"], "danger")
            publish_status()
            self._json({"ok": False, "message": RUNTIME["message"], "status": public_status(), "log": entry, "created": created}, 409)
            return
        if mode not in {"playback", "preview", "demo", "analyze", "camera"}:
            self._json({"ok": False, "message": "不支持的监测模式"}, 400)
            return
        with LOCK:
            RUNTIME["state"] = "running"
            RUNTIME["mode"] = mode
            RUNTIME["latencyMs"] = None
            RUNTIME["message"] = "监测任务已启动。" if mode in {"analyze", "camera"} else "当前任务不调用未加载的模型。"
        entry, created = add_log("监测启动", f"监测任务已启动，模式 {mode}。", "info")
        publish_status()
        self._json({"ok": True, "status": public_status(), "log": entry, "created": created})

    def _transition(self, state, event_type, message, allowed):
        if RUNTIME["state"] not in allowed:
            self._json({"ok": False, "message": "当前状态不能执行该操作", "status": public_status()}, 409)
            return
        with LOCK:
            RUNTIME["state"] = state
            RUNTIME["message"] = message
        entry, created = add_log(event_type, message, "info")
        publish_status()
        self._json({"ok": True, "status": public_status(), "log": entry, "created": created})

    def _stop(self):
        with LOCK:
            RUNTIME["state"] = "stopped"
            RUNTIME["mode"] = "idle"
            RUNTIME["message"] = "监测任务已停止。"
            RUNTIME["latencyMs"] = None
        entry, created = add_log("监测停止", RUNTIME["message"], "info")
        publish_status()
        self._json({"ok": True, "status": public_status(), "log": entry, "created": created})

    def _params(self, body):
        allowed = {"activityThreshold", "turnThreshold", "confThreshold", "fps", "windowFrames", "strideFrames"}
        with LOCK:
            for key, value in body.items():
                if key in allowed and isinstance(value, (int, float)):
                    RUNTIME["params"][key] = value
            RUNTIME["params"]["fps"] = FPS
            RUNTIME["params"]["windowFrames"] = WINDOW_FRAMES
            RUNTIME["params"]["strideFrames"] = STRIDE_FRAMES
        publish_status()
        self._json({"ok": True, "params": RUNTIME["params"]})

    def _frame(self):
        if not models_ready() or RUNTIME["state"] != "running":
            self._json({
                "ok": False,
                "message": "模型未加载或监测未运行，已拒绝生成检测结果。",
                "poseModel": RUNTIME["poseModel"],
                "behaviorModel": RUNTIME["behaviorModel"],
            }, 409)
            return
        self._json({"ok": False, "message": "分析服务不可用"}, 409)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 8 * 1024 * 1024:
            return {}
        raw = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send(self, status, body, content_type="text/plain; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _static(self, path):
        relative = Path(path.lstrip("/"))
        if path in {"", "/"}:
            relative = Path("index.html")
        target = (ROOT / relative).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            self._send(403, b"")
            return
        if "behavior_analysis" in target.parts or "server_data" in target.parts:
            self._send(404, b"")
            return
        if not target.is_file():
            self._send(404, "未找到文件".encode("utf-8"))
            return
        types = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8"}
        body = target.read_bytes()
        self._send(200, body, types.get(target.suffix.lower(), "application/octet-stream"))

    def _websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key or self.headers.get("Upgrade", "").lower() != "websocket":
            self._send(400, b"")
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        client = WsClient(self.wfile)
        CLIENTS.add(client)
        try:
            client.send_packet(encode_ws(json.dumps({**public_status(), "type": "status", "timestamp": now_iso()}, ensure_ascii=False).encode("utf-8")))
            while True:
                frame = read_ws_frame(self.rfile)
                if frame is None:
                    break
                opcode, data = frame
                if opcode == 8:
                    break
                if opcode == 9:
                    client.send_packet(bytes([0x8A, len(data)]) + data)
        except Exception:
            pass
        finally:
            CLIENTS.discard(client)


def main():
    pose_status, behavior_status, engine, analyzer = probe_models()
    RUNTIME["poseModel"] = pose_status
    RUNTIME["behaviorModel"] = behavior_status
    RUNTIME["engine"] = engine
    RUNTIME["behavior"] = analyzer
    load_logs()
    server = ThreadingHTTPServer((HOST, PORT), MonitorHandler)
    print(f"http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
