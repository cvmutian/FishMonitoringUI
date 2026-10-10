import importlib
import os
import sys
from pathlib import Path

import numpy as np

MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)
CONFIDENCE_THRESHOLD = 0.3
PROTECTED = ("models", "utils", "datasets", "engines", "data", "features")


def decode_instance(heatmaps, offsets, num_keypoints, img_size, confidence_threshold=CONFIDENCE_THRESHOLD):
    heatmaps = np.asarray(heatmaps, dtype=np.float32)
    offsets = np.asarray(offsets, dtype=np.float32)
    if heatmaps.ndim != 4 or offsets.ndim != 4:
        raise RuntimeError("姿态输出形状与 FishPose 热图模型不一致")
    _, channels, height, width = heatmaps.shape
    if channels != num_keypoints or offsets.shape[1] != num_keypoints * 2 or offsets.shape[2:] != (height, width):
        raise RuntimeError("姿态输出通道与 11 个关键点不一致")
    resized_h, resized_w = int(img_size[0]), int(img_size[1])
    stride_x = resized_w / float(width)
    stride_y = resized_h / float(height)
    flat = heatmaps[0].reshape(num_keypoints, -1)
    indices = np.argmax(flat, axis=1)
    scores = np.max(flat, axis=1)
    keypoints = np.zeros((num_keypoints, 3), dtype=np.float32)
    for joint in range(num_keypoints):
        score = float(scores[joint])
        if score < confidence_threshold:
            continue
        index = int(indices[joint])
        y_coord = index // width
        x_coord = index % width
        offset_y = float(offsets[0, joint, y_coord, x_coord])
        offset_x = float(offsets[0, num_keypoints + joint, y_coord, x_coord])
        keypoints[joint, 0] = (x_coord + offset_x) * stride_x
        keypoints[joint, 1] = (y_coord + offset_y) * stride_y
        keypoints[joint, 2] = score
    return keypoints


def map_to_original(keypoints, img_size, original_size):
    output = np.array(keypoints, dtype=np.float32, copy=True)
    resized_h, resized_w = int(img_size[0]), int(img_size[1])
    original_h, original_w = int(original_size[0]), int(original_size[1])
    if resized_w <= 0 or resized_h <= 0:
        raise RuntimeError("姿态模型输入尺寸无效")
    scale_x = original_w / float(resized_w)
    scale_y = original_h / float(resized_h)
    valid = output[:, 2] > 0
    output[valid, 0] *= scale_x
    output[valid, 1] *= scale_y
    return output


def instance_from_keypoints(keypoints):
    valid = keypoints[:, 2] > 0
    if not np.any(valid):
        return None
    points = keypoints[valid, :2]
    x0 = float(points[:, 0].min())
    y0 = float(points[:, 1].min())
    x1 = float(points[:, 0].max())
    y1 = float(points[:, 1].max())
    return {
        "bbox": [x0, y0, max(0.0, x1 - x0), max(0.0, y1 - y0)],
        "keypoints": keypoints.astype(float).tolist(),
        "score": float(keypoints[valid, 2].mean()),
    }


class PoseService:
    def __init__(self):
        self.status = "未找到模型文件"
        self.detail = "未设置 FISHPOSE_ENGINE 或 FISHPOSE_WEIGHTS"
        self.engine = "未加载"
        self.ready = False
        self.img_size = (512, 512)
        self.num_keypoints = 11
        self._runner = None

    def infer(self, frame_bgr):
        if not self.ready or self._runner is None:
            raise RuntimeError(self.detail or "姿态模型不可执行推理")
        image = np.asarray(frame_bgr)
        if image.ndim != 3 or image.shape[2] != 3:
            raise RuntimeError("输入帧无效")
        return self._runner(image)


def probe_pose():
    service = PoseService()
    engine_path = os.environ.get("FISHPOSE_ENGINE", "").strip()
    weights = os.environ.get("FISHPOSE_WEIGHTS", "").strip()
    root = os.environ.get("FISHPOSE_ROOT", "").strip()
    if engine_path:
        path = Path(engine_path)
        if not path.is_file():
            service.status = "未找到模型文件"
            service.detail = "指定的 TensorRT 引擎文件不存在"
            return service
        service.status = "模型加载中"
        try:
            runner, img_size, keypoints = _load_tensorrt(path)
            service._runner = runner
            service.img_size = img_size
            service.num_keypoints = keypoints
            service.status = "模型加载成功"
            _verify(service)
            service.engine = "TensorRT FP32" if "fp32" in path.name.lower() else "TensorRT"
        except Exception as exc:
            service.ready = False
            service._runner = None
            service.status = "模型加载失败"
            service.detail = _short(exc)
            service.engine = "未加载"
        return service
    if not weights and not root:
        return service
    weight_path = Path(weights) if weights else None
    config_path = Path(root) / "configs" / "FishPose.yaml" if root else None
    model_path = Path(root) / "models" / "fish_pose_model.py" if root else None
    if not (weight_path and weight_path.is_file() and config_path and config_path.is_file() and model_path and model_path.is_file()):
        service.status = "未找到模型文件"
        service.detail = "FishPose 权重或项目文件不存在"
        return service
    service.status = "模型加载中"
    try:
        runner, img_size, keypoints = _load_pytorch(Path(root), weight_path, config_path)
        service._runner = runner
        service.img_size = img_size
        service.num_keypoints = keypoints
        service.status = "模型加载成功"
        _verify(service)
        service.engine = "PyTorch"
        service.detail = "TensorRT 引擎未配置，当前使用 FishPose 的 PyTorch 评测入口"
    except Exception as exc:
        service.ready = False
        service._runner = None
        service.status = "模型加载失败"
        service.detail = _short(exc)
        service.engine = "未加载"
    return service


def _verify(service):
    blank = np.zeros((int(service.img_size[0]), int(service.img_size[1]), 3), dtype=np.uint8)
    result = service._runner(blank)
    if not isinstance(result, list):
        raise RuntimeError("姿态推理没有返回检测列表")
    service.ready = True
    service.status = "可执行推理"


def _short(exc):
    text = str(exc).strip() or exc.__class__.__name__
    return text[:300]


def _load_yaml(path):
    try:
        yaml = importlib.import_module("yaml")
    except Exception as exc:
        raise RuntimeError("缺少 PyYAML，无法读取 FishPose 配置") from exc
    with Path(path).open(encoding="utf-8") as handle:
        config = yaml.safe_load(handle)
    if not isinstance(config, dict):
        raise RuntimeError("FishPose 配置无效")
    return config


def _preprocess(frame_bgr, img_size):
    try:
        from PIL import Image
        from torchvision import transforms as T
    except Exception as exc:
        raise RuntimeError("姿态预处理需要与 FishPose 评测相同的 Pillow 和 torchvision") from exc
    rgb = np.ascontiguousarray(frame_bgr[:, :, ::-1])
    image = Image.fromarray(rgb)
    transform = T.Compose([
        T.Resize((int(img_size[0]), int(img_size[1]))),
        T.ToTensor(),
        T.Normalize(mean=MEAN, std=STD),
    ])
    return transform(image).unsqueeze(0)


def _outputs_to_detection(heatmaps, offsets, img_size, original_hw, num_keypoints):
    if heatmaps.min() < 0 or heatmaps.max() > 1:
        heatmaps = 1.0 / (1.0 + np.exp(-heatmaps))
    keypoints = decode_instance(heatmaps, offsets, num_keypoints, img_size)
    keypoints = map_to_original(keypoints, img_size, original_hw)
    detection = instance_from_keypoints(keypoints)
    return [] if detection is None else [detection]


def _import_fishpose(root):
    root = str(Path(root).resolve())
    saved = {}
    for name in list(sys.modules):
        if name in PROTECTED or name.startswith(tuple(item + "." for item in PROTECTED)):
            saved[name] = sys.modules.pop(name)
    sys.path.insert(0, root)
    try:
        from models.fish_pose_model import FishPoseModel
        return FishPoseModel
    finally:
        try:
            sys.path.remove(root)
        except ValueError:
            pass
        for name in list(sys.modules):
            if name in PROTECTED or name.startswith(tuple(item + "." for item in PROTECTED)):
                sys.modules.pop(name, None)
        sys.modules.update(saved)


def _load_pytorch(root, weights, config_path):
    torch = importlib.import_module("torch")
    config = _load_yaml(config_path)
    img_size = tuple(config["data"]["img_size"])
    num_keypoints = int(config["data"]["num_keypoints"])
    if num_keypoints != 11:
        raise RuntimeError("FishPose 配置的关键点数量不是 11")
    device_name = str(config.get("device", "cuda"))
    if device_name.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("FishPose 配置要求 CUDA，当前环境没有可用 CUDA")
    device = torch.device(device_name)
    model_cls = _import_fishpose(root)
    model = model_cls(config)
    try:
        blob = torch.load(str(weights), map_location=device, weights_only=False)
    except TypeError:
        blob = torch.load(str(weights), map_location=device)
    if isinstance(blob, dict):
        for key in ("state_dict", "model_state_dict", "model"):
            if key in blob and isinstance(blob[key], dict):
                blob = blob[key]
                break
    if not isinstance(blob, dict):
        raise RuntimeError("FishPose 权重格式无法识别")
    try:
        model.load_state_dict(blob, strict=True)
    except RuntimeError as exc:
        raise RuntimeError(f"权重参数与 FishPose 网络不匹配，已拒绝加载。{exc}") from exc
    model.to(device)
    model.eval()

    def runner(frame_bgr):
        tensor = _preprocess(frame_bgr, img_size).to(device)
        with torch.no_grad():
            predictions = model(tensor)
        heatmaps = predictions["pose_heatmap"].detach().float().cpu().numpy()
        offsets = predictions["offsets"].detach().float().cpu().numpy()
        return _outputs_to_detection(heatmaps, offsets, img_size, frame_bgr.shape[:2], num_keypoints)

    return runner, img_size, num_keypoints


def _load_tensorrt(path):
    try:
        trt = importlib.import_module("tensorrt")
    except Exception as exc:
        raise RuntimeError("未安装 TensorRT") from exc
    torch = importlib.import_module("torch")
    if not torch.cuda.is_available():
        raise RuntimeError("TensorRT 推理需要 CUDA")
    logger = trt.Logger(trt.Logger.ERROR)
    runtime = trt.Runtime(logger)
    engine = runtime.deserialize_cuda_engine(path.read_bytes())
    if engine is None:
        raise RuntimeError("TensorRT 引擎无法反序列化")
    context = engine.create_execution_context()
    names = _tensor_names(engine)
    input_name = _find_input(engine, names)
    input_shape = _tensor_shape(engine, input_name)
    if len(input_shape) != 4 or int(input_shape[1]) != 3:
        raise RuntimeError("TensorRT 输入不是 NCHW 图像")
    img_size = (int(input_shape[2]), int(input_shape[3]))
    output_names = [name for name in names if name != input_name]
    heatmap_name, offset_name = _match_outputs(engine, output_names)
    stream = torch.cuda.Stream()

    def runner(frame_bgr):
        tensor = _preprocess(frame_bgr, img_size).cuda().contiguous()
        heatmap, offsets = _execute_engine(engine, context, input_name, heatmap_name, offset_name, tensor, stream)
        return _outputs_to_detection(heatmap, offsets, img_size, frame_bgr.shape[:2], 11)

    return runner, img_size, 11


def _tensor_names(engine):
    if hasattr(engine, "num_io_tensors"):
        return [engine.get_tensor_name(index) for index in range(engine.num_io_tensors)]
    return [engine.get_binding_name(index) for index in range(engine.num_bindings)]


def _tensor_shape(engine, name):
    if hasattr(engine, "get_tensor_shape"):
        return tuple(int(item) for item in engine.get_tensor_shape(name))
    return tuple(int(item) for item in engine.get_binding_shape(engine.get_binding_index(name)))


def _is_input(engine, name):
    if hasattr(engine, "get_tensor_mode"):
        trt = importlib.import_module("tensorrt")
        return engine.get_tensor_mode(name) == trt.TensorIOMode.INPUT
    return engine.binding_is_input(engine.get_binding_index(name))


def _find_input(engine, names):
    inputs = [name for name in names if _is_input(engine, name)]
    if len(inputs) != 1:
        raise RuntimeError("TensorRT 引擎输入数量与 FishPose 单图像模型不一致")
    return inputs[0]


def _match_outputs(engine, names):
    heatmap_name = None
    offset_name = None
    for name in names:
        shape = _tensor_shape(engine, name)
        if len(shape) == 4 and int(shape[1]) == 11:
            heatmap_name = name
        elif len(shape) == 4 and int(shape[1]) == 22:
            offset_name = name
    if heatmap_name is None or offset_name is None:
        raise RuntimeError("TensorRT 输出与 FishPose 热图和偏移不一致")
    return heatmap_name, offset_name


def _execute_engine(engine, context, input_name, heatmap_name, offset_name, tensor, stream):
    torch = importlib.import_module("torch")
    outputs = {}
    if hasattr(context, "set_input_shape"):
        context.set_input_shape(input_name, tuple(tensor.shape))
        context.set_tensor_address(input_name, int(tensor.data_ptr()))
        for name in (heatmap_name, offset_name):
            shape = tuple(int(item) for item in context.get_tensor_shape(name))
            buffer = torch.empty(shape, dtype=torch.float32, device=tensor.device)
            context.set_tensor_address(name, int(buffer.data_ptr()))
            outputs[name] = buffer
        if not context.execute_async_v3(stream.cuda_stream):
            raise RuntimeError("TensorRT 推理执行失败")
    else:
        bindings = [0] * engine.num_bindings
        bindings[engine.get_binding_index(input_name)] = int(tensor.data_ptr())
        for name in (heatmap_name, offset_name):
            shape = tuple(int(item) for item in context.get_binding_shape(engine.get_binding_index(name)))
            buffer = torch.empty(shape, dtype=torch.float32, device=tensor.device)
            bindings[engine.get_binding_index(name)] = int(buffer.data_ptr())
            outputs[name] = buffer
        if not context.execute_async_v2(bindings, stream.cuda_stream):
            raise RuntimeError("TensorRT 推理执行失败")
    stream.synchronize()
    heatmap = outputs[heatmap_name].detach().float().cpu().numpy()
    offsets = outputs[offset_name].detach().float().cpu().numpy()
    return heatmap, offsets
