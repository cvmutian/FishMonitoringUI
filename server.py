import base64
import hashlib
import hmac
import json
import os
import threading
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from analysis_task import FPS, STRIDE_FRAMES, TASK, WINDOW_FRAMES, probe_behavior
from pose_adapter import probe_pose


ROOT = Path(__file__).resolve().parent
LOG_PATH = ROOT / "server_data" / "events.jsonl"
UPLOAD_DIR = ROOT / "server_data" / "uploads"
PORT = 8080
MAX_UPLOAD = 256 * 1024 * 1024
VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".avi", ".mkv"}
STATIC_SUFFIXES = {".html", ".css", ".js", ".json", ".png", ".svg", ".ico", ".webp", ".gif", ".jpg", ".jpeg"}
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

LOCK = threading.Lock()
CLIENTS = set()
LOGS = []
UPLOADS = {}
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
    "poseModel": "未找到模型文件",
    "behaviorModel": "未找到模型文件",
    "poseDetail": "",
    "behaviorDetail": "",
    "engine": "未加载",
    "latencyMs": None,
    "message": "",
    "behavior": None,
}


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def listen_address():
    token = os.environ.get("MONITOR_TOKEN", "")
    if os.environ.get("MONITOR_LAN", "") == "1":
        if not token:
            raise SystemExit("局域网监听需要环境变量 MONITOR_TOKEN，服务未启动。")
        return "0.0.0.0"
    host = os.environ.get("MONITOR_HOST", "127.0.0.1").strip() or "127.0.0.1"
    if host == "0.0.0.0" and not token:
        raise SystemExit("监听 0.0.0.0 需要环境变量 MONITOR_TOKEN，服务未启动。")
    return host


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


def models_ready():
    return RUNTIME["poseModel"] == "可执行推理" and RUNTIME["behaviorModel"] == "可执行推理"


def public_status():
    source = RUNTIME["source"]
    visible = {key: value for key, value in source.items() if key != "path"}
    return {
        "ok": True,
        "state": RUNTIME["state"],
        "mode": RUNTIME["mode"],
        "source": visible,
        "sourceConnected": bool(source.get("connected")),
        "poseModel": RUNTIME["poseModel"],
        "behaviorModel": RUNTIME["behaviorModel"],
        "poseDetail": RUNTIME.get("poseDetail") or "",
        "behaviorDetail": RUNTIME.get("behaviorDetail") or "",
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


def model_block_message():
    parts = []
    if RUNTIME["poseModel"] != "可执行推理":
        parts.append(f"姿态模型{RUNTIME['poseModel']}")
        if RUNTIME.get("poseDetail"):
            parts.append(RUNTIME["poseDetail"])
    if RUNTIME["behaviorModel"] != "可执行推理":
        parts.append(f"行为模型{RUNTIME['behaviorModel']}")
        if RUNTIME.get("behaviorDetail"):
            parts.append(RUNTIME["behaviorDetail"])
    return "，".join(parts) + "，未启动监测。"


class MonitorHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _authorized(self):
        expected = os.environ.get("MONITOR_TOKEN", "")
        if not expected:
            return True
        supplied = self.headers.get("X-Monitor-Token", "")
        if not supplied:
            supplied = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        try:
            return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))
        except Exception:
            return False

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
        if not self._authorized():
            self._json({"ok": False, "message": "控制接口需要访问令牌"}, 401)
            return
        if parsed.path == "/api/upload":
            self._upload()
            return
        body = self._body()
        if parsed.path == "/api/source":
            self._set_source(body)
            return
        if parsed.path == "/api/monitor/start":
            self._start(body)
            return
        if parsed.path == "/api/monitor/pause":
            self._transition("paused", "监测暂停", "监测已暂停", ("running",))
            if RUNTIME["state"] == "paused":
                TASK.pause()
            return
        if parsed.path == "/api/monitor/resume":
            self._transition("running", "监测恢复", "监测已恢复", ("paused",))
            if RUNTIME["state"] == "running":
                TASK.resume()
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
        if not self._authorized():
            self._json({"ok": False, "message": "控制接口需要访问令牌"}, 401)
            return
        if urlparse(self.path).path != "/api/logs":
            self._json({"ok": False, "message": "未知接口"}, 404)
            return
        with LOCK:
            LOGS.clear()
            if LOG_PATH.is_file():
                LOG_PATH.unlink()
        self._json({"ok": True})

    def _set_source(self, body):
        TASK.stop()
        kind = str(body.get("type") or "none")
        name = Path(str(body.get("name") or "")).name
        analyze = bool(body.get("analyze"))
        upload_id = str(body.get("uploadId") or "")
        connected = kind in {"file", "preview", "demo"}
        message = ""
        level = "info"
        if kind == "camera":
            connected, message = probe_camera(int(body.get("index") or 0))
            level = "info" if connected else "danger"
        elif kind == "file":
            if analyze:
                path = UPLOADS.get(upload_id)
                connected = bool(path and Path(path).is_file())
                message = "视频文件已上传，等待后端分析。" if connected else "后端没有收到视频文件。"
                level = "info" if connected else "warn"
            else:
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
            RUNTIME["source"] = {
                "type": kind,
                "name": name,
                "connected": connected,
                "analyze": analyze and connected,
                "uploadId": upload_id if connected else "",
                "index": int(body.get("index") or 0),
            }
            if RUNTIME["state"] in {"stopped", "error"}:
                RUNTIME["state"] = "ready"
                RUNTIME["mode"] = "idle"
            RUNTIME["message"] = message
        event_type = "视频流异常" if (kind == "camera" and not connected) or (kind == "file" and analyze and not connected) else "视频数据源接入"
        entry, created = add_log(event_type, message, level)
        publish_status()
        accepted = connected or kind in {"none", "file", "preview", "demo"}
        if kind == "file" and analyze:
            accepted = connected
        self._json({"ok": accepted, "status": public_status(), "log": entry, "created": created}, 200 if accepted else 409)

    def _start(self, body):
        mode = str(body.get("mode") or "playback")
        if mode not in {"playback", "preview", "demo", "analyze", "camera"}:
            self._json({"ok": False, "message": "不支持的监测模式"}, 400)
            return
        if mode in {"playback", "preview", "demo"}:
            TASK.stop()
            with LOCK:
                RUNTIME["state"] = "running"
                RUNTIME["mode"] = mode
                RUNTIME["latencyMs"] = None
                RUNTIME["message"] = "当前任务不调用未加载的模型。"
            entry, created = add_log("监测启动", f"监测任务已启动，模式 {mode}。", "info")
            publish_status()
            self._json({"ok": True, "status": public_status(), "log": entry, "created": created})
            return
        if not models_ready():
            message = model_block_message()
            with LOCK:
                RUNTIME["state"] = "error"
                RUNTIME["mode"] = mode
                RUNTIME["message"] = message
                RUNTIME["latencyMs"] = None
            entry, created = add_log("模型加载失败", message, "danger")
            publish_status()
            self._json({"ok": False, "message": message, "status": public_status(), "log": entry, "created": created}, 409)
            return
        with LOCK:
            RUNTIME["state"] = "running"
            RUNTIME["mode"] = mode
            RUNTIME["latencyMs"] = None
            RUNTIME["message"] = "监测任务已启动。"
        try:
            if mode == "analyze":
                upload_id = str(body.get("uploadId") or RUNTIME["source"].get("uploadId") or "")
                path = UPLOADS.get(upload_id)
                if not path or not Path(path).is_file():
                    raise RuntimeError("后端没有可读取的视频文件")
                TASK.start_file(path)
            else:
                if not RUNTIME["source"].get("connected"):
                    raise RuntimeError(RUNTIME["message"] or "摄像头不可用")
                TASK.start_camera(int(RUNTIME["source"].get("index") or 0))
        except RuntimeError as exc:
            TASK.stop()
            message = str(exc)
            with LOCK:
                RUNTIME["state"] = "error"
                RUNTIME["mode"] = mode
                RUNTIME["message"] = message
                RUNTIME["latencyMs"] = None
            entry, created = add_log("视频流异常" if "视频" in message or "摄像头" in message or "采集" in message else "模型加载失败", message, "danger")
            publish_status()
            self._json({"ok": False, "message": message, "status": public_status(), "log": entry, "created": created}, 409)
            return
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
        TASK.stop()
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
        self._json({
            "ok": False,
            "message": "逐帧结果由后端视频任务经过 WebSocket 推送。",
            "poseModel": RUNTIME["poseModel"],
            "behaviorModel": RUNTIME["behaviorModel"],
        }, 409)

    def _upload(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD:
            self._json({"ok": False, "message": "视频文件为空或超过 256MB"}, 400)
            return
        filename = unquote(self.headers.get("X-Filename", ""))
        safe_name = Path(filename).name
        if not safe_name or safe_name != filename.replace("\\", "/").split("/")[-1]:
            self._json({"ok": False, "message": "视频文件名无效"}, 400)
            return
        suffix = Path(safe_name).suffix.lower()
        if suffix not in VIDEO_SUFFIXES:
            self._json({"ok": False, "message": "仅支持 mp4、webm、mov、avi、mkv"}, 400)
            return
        payload = self.rfile.read(length)
        if len(payload) != length:
            self._json({"ok": False, "message": "视频上传不完整"}, 400)
            return
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        stored = UPLOAD_DIR / f"{uuid.uuid4().hex}{suffix}"
        stored.write_bytes(payload)
        resolved = stored.resolve()
        if UPLOAD_DIR.resolve() not in resolved.parents:
            stored.unlink(missing_ok=True)
            self._json({"ok": False, "message": "视频保存路径无效"}, 400)
            return
        upload_id = resolved.name
        UPLOADS[upload_id] = str(resolved)
        self._json({"ok": True, "uploadId": upload_id, "name": safe_name})

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
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _static(self, path):
        relative = Path(unquote(path.lstrip("/")))
        if path in {"", "/"}:
            relative = Path("index.html")
        if any(part in {"..", "behavior_analysis", "server_data"} for part in relative.parts):
            self._send(404, b"")
            return
        target = (ROOT / relative).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            self._send(403, b"")
            return
        if target.suffix.lower() not in STATIC_SUFFIXES or not target.is_file():
            self._send(404, "未找到文件".encode("utf-8"))
            return
        types = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8"}
        self._send(200, target.read_bytes(), types.get(target.suffix.lower(), "application/octet-stream"))

    def _websocket(self):
        if not self._authorized():
            self._send(401, "控制接口需要访问令牌".encode("utf-8"))
            return
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
                    try:
                        client.send_packet(bytes([0x88, 0x00]))
                    except Exception:
                        pass
                    break
                if opcode == 9:
                    client.send_packet(bytes([0x8A, len(data)]) + data)
        except Exception:
            pass
        finally:
            CLIENTS.discard(client)
            if not CLIENTS and RUNTIME["mode"] in {"analyze", "camera"} and RUNTIME["state"] in {"running", "paused"}:
                with LOCK:
                    RUNTIME["message"] = "监测连接已断开。"
                add_log("系统异常", "监测连接已断开。", "danger")
                publish_status()


def main():
    pose = probe_pose()
    behavior_status, analyzer, behavior_detail, _config = probe_behavior()
    RUNTIME["poseModel"] = pose.status
    RUNTIME["poseDetail"] = pose.detail
    RUNTIME["behaviorModel"] = behavior_status
    RUNTIME["behaviorDetail"] = behavior_detail
    RUNTIME["engine"] = pose.engine
    RUNTIME["behavior"] = analyzer
    RUNTIME["message"] = "；".join(item for item in (pose.detail, behavior_detail) if item)
    TASK.bind(RUNTIME, LOCK, broadcast, add_log, pose)
    load_logs()
    if pose.status != "可执行推理":
        add_log("模型加载失败" if pose.status == "模型加载失败" else "系统事件", f"姿态模型{pose.status}。{pose.detail}", "danger" if pose.status == "模型加载失败" else "warn")
    if behavior_status != "可执行推理":
        add_log("模型加载失败" if behavior_status == "模型加载失败" else "系统事件", f"行为模型{behavior_status}。{behavior_detail}", "danger" if behavior_status == "模型加载失败" else "warn")
    host = listen_address()
    server = ThreadingHTTPServer((host, PORT), MonitorHandler)
    print(f"http://{host}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
