"""Offline regression tests: real bridge HTTP requests, fake native ComfyUI only."""
import base64
import importlib.util
import json
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("lmd_bridge", Path(__file__).with_name("bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k6eUAAAAASUVORK5CYII=")
DATA = "data:image/png;base64," + base64.b64encode(PNG).decode()


def object_info():
    info = {}
    for model in [*bridge.MODELS, *bridge.IMAGE_MODELS]:
        for node in bridge.load_workflow(model).values():
            schema = info.setdefault(node["class_type"], {"input": {"required": {}}})["input"]["required"]
            if node["class_type"] in {"UNETLoader", "VAELoader", "CLIPLoader", "MiniMaxH3TurboLoRA"}:
                for key, value in node["inputs"].items():
                    if key.endswith("_name") and isinstance(value, str):
                        schema.setdefault(key, [[]])[0].append(value)
    info.update({"LoadImage": {"input": {}}, "MiniMaxH3AddGuide": {"input": {}}, "EmptyLatentImage": {"input": {}}})
    info["TextEncodeQwenImage21"]["input"]["required"]["images"] = ["COMFY_AUTOGROW_V3", {
        "template": {"names": [f"image_{i}" for i in range(1, 17)], "min": 0}}]
    return info


class NativeHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, value, status=200):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        state = self.server.state
        state["headers"].append(dict(self.headers))
        if self.path == "/object_info":
            self.respond(state["info"])
        elif self.path.startswith("/history/"):
            self.respond(state["history"])
        elif self.path == "/queue":
            self.respond(state["queue"])
        else:
            self.respond({}, 404)

    def do_POST(self):
        state = self.server.state
        state["headers"].append(dict(self.headers))
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/upload/image":
            message = BytesParser(policy=default).parsebytes(
                b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw)
            parts = {part.get_param("name", header="content-disposition"): part for part in message.iter_parts()}
            state["uploads"].append({"bytes": parts["image"].get_payload(decode=True),
                                     "type": parts["type"].get_content().strip(),
                                     "subfolder": parts["subfolder"].get_content().strip()})
            self.respond({"name": f"server-renamed-{len(state['uploads'])}.png", "subfolder": "actual/input", "type": "input"})
        elif self.path == "/prompt":
            state["prompts"].append(json.loads(raw))
            if state["reject"]:
                self.respond({"error": "bad graph", "node_errors": {"131": {"error": "invalid image"}}}, 400)
            else:
                self.respond({"prompt_id": "native-prompt-id", "number": 1, "node_errors": {}})
        else:
            self.respond({}, 404)


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.native = ThreadingHTTPServer(("127.0.0.1", 0), NativeHandler)
        cls.thread = threading.Thread(target=cls.native.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.native.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.native.shutdown()
        cls.native.server_close()
        cls.thread.join(2)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = bridge.BridgeService(self.temp.name)
        self.state = self.native.state = {"info": object_info(), "uploads": [], "prompts": [], "headers": [],
                                          "history": {}, "queue": {"queue_pending": [], "queue_running": []}, "reject": False}
        self.options = {"comfyui_url": self.url, "model": bridge.MODEL_H3, "prompt": "test video movement",
                        "duration": 5, "aspect_ratio": "9:16", "seed": 42}

    def submit(self, **changes):
        return self.service.submit({**self.options, **changes})

    def complete(self, node="92", field="images"):
        self.state["history"] = {"native-prompt-id": {"status": {"status_str": "success", "completed": True},
            "outputs": {node: {field: [{"filename": "镜头 1.mp4", "subfolder": "video/lmd sample", "type": "output"}]}}}}

    def test_h3_references_and_endpoint_guides_keep_order_and_audio(self):
        result = self.submit(reference_urls=[DATA, DATA], first_frame_url=DATA, last_frame_url=DATA,
                             prompt="@图片1 walks past <Picture 2>")
        graph = self.state["prompts"][0]["prompt"]
        self.assertEqual(graph["136"]["inputs"]["value"], "<Picture 1> walks past <Picture 2>")
        self.assertEqual(graph["131"]["inputs"]["ref_images.ref_image_0"], ["lmd_image_1", 0])
        self.assertEqual(graph["131"]["inputs"]["ref_images.ref_image_1"], ["lmd_image_2", 0])
        self.assertEqual(graph["lmd_image_1"]["inputs"]["image"], "actual/input/server-renamed-1.png")
        self.assertEqual(graph["lmd_guide_1"]["inputs"]["frame_idx"], 0)
        self.assertEqual(graph["lmd_guide_2"]["inputs"]["frame_idx"], -1)
        self.assertEqual(graph["lmd_guide_2"]["inputs"]["positive"], ["lmd_guide_1", 0])
        self.assertEqual(graph["126"]["inputs"]["conditioning"], ["lmd_guide_2", 0])
        self.assertEqual(graph["125"]["inputs"]["latent_image"], ["131", 1])
        self.assertEqual(graph["130"]["inputs"]["audio"], ["121", 0])
        self.assertEqual(graph["129"]["inputs"]["noise_seed"], 42)
        self.assertTrue(all(item["bytes"] == PNG for item in self.state["uploads"]))
        self.assertEqual(len(self.state["uploads"]), 4)
        self.assertEqual(result["metadata"]["frame_count"], 124)
        self.assertLess(result["metadata"]["width"], result["metadata"]["height"])

    def test_h3_only_endpoint_frames_are_not_unordered_references(self):
        self.submit(first_frame_url=DATA, last_frame_url=DATA)
        graph = self.state["prompts"][0]["prompt"]
        self.assertFalse(any(key.startswith("ref_images.") for key in graph["131"]["inputs"]))
        self.assertEqual(graph["lmd_guide_1"]["inputs"]["image"], ["lmd_image_1", 0])
        self.assertEqual(graph["lmd_guide_2"]["inputs"]["image"], ["lmd_image_2", 0])

    def test_h3_primary_image_is_independent_reference_with_separate_explicit_frame(self):
        self.submit(image_url=DATA)
        graph = self.state["prompts"][0]["prompt"]
        self.assertEqual(graph["131"]["inputs"]["ref_images.ref_image_0"], ["lmd_image_1", 0])
        self.assertNotIn("lmd_guide_1", graph)
        self.submit(image_url=DATA, reference_urls=[DATA], first_frame_url=DATA)
        graph = self.state["prompts"][1]["prompt"]
        self.assertEqual(graph["lmd_guide_1"]["inputs"]["image"], ["lmd_image_2", 0])
        before = len(self.state["uploads"])
        with self.assertRaisesRegex(bridge.BridgeError, "编号"):
            self.submit(image_url="https://example.invalid/other.png", reference_urls=[DATA])
        self.assertEqual(len(self.state["uploads"]), before)

    def test_fractional_duration_matches_firebao_rounding(self):
        _, metadata = bridge.build_workflow(bridge.MODEL_WAN, {**self.options, "duration": 4.75}, [], "sample")
        self.assertEqual(metadata["frame_count"], 117)
        _, h3 = bridge.build_workflow(bridge.MODEL_H3, {**self.options, "duration": 0.9375}, [], "sample")
        self.assertEqual(h3["frame_count"], 22)

    def test_h3_nine_references_allowed_ten_rejected_without_upload(self):
        self.submit(reference_urls=[DATA] * 9)
        self.assertEqual(len(self.state["uploads"]), 9)
        with self.assertRaisesRegex(bridge.BridgeError, "9"):
            self.submit(reference_urls=[DATA] * 10)
        self.assertEqual(len(self.state["prompts"]), 1)

    def test_h3_reference_tag_validation_blocks_submission(self):
        with self.assertRaisesRegex(bridge.BridgeError, "对应参考图"):
            self.submit(reference_urls=[DATA], prompt="@图片2 moves")
        self.assertEqual(self.state["uploads"], [])
        self.assertEqual(self.state["prompts"], [])

    def test_wan_text_and_single_first_image_preserve_sampler_and_negative(self):
        result = self.submit(model=bridge.MODEL_WAN, first_frame_url=DATA)
        graph = self.state["prompts"][0]["prompt"]
        self.assertEqual(graph["7"]["inputs"]["start_image"], ["lmd_image_1", 0])
        self.assertEqual(graph["7"]["inputs"]["length"], 121)
        self.assertEqual(graph["8"]["inputs"]["seed"], 42)
        self.assertEqual(graph["8"]["inputs"]["steps"], 30)
        self.assertIn("闪烁", graph["6"]["inputs"]["text"])
        self.assertEqual(result["metadata"]["fps"], 24)
        self.submit(model=bridge.MODEL_WAN)
        self.assertNotIn("start_image", self.state["prompts"][1]["prompt"]["7"]["inputs"])

    def test_wan_one_reference_array_is_one_first_frame(self):
        self.submit(model=bridge.MODEL_WAN, reference_urls=[DATA], first_frame_url=DATA)
        self.assertEqual(len(self.state["uploads"]), 1)
        self.assertIn("start_image", self.state["prompts"][0]["prompt"]["7"]["inputs"])

    def test_wan_tail_and_distinct_images_fail_before_native_calls(self):
        for options in ({"last_frame_url": DATA}, {"reference_urls": [DATA, "https://example.invalid/second.png"]}):
            with self.assertRaises(bridge.BridgeError):
                self.submit(model=bridge.MODEL_WAN, **options)
        self.assertEqual(self.state["headers"], [])

    def test_corrupt_later_reference_does_not_upload_earlier_image(self):
        with self.assertRaisesRegex(bridge.BridgeError, "PNG"):
            self.submit(reference_urls=[DATA, "data:image/png;base64,YmFk"])
        self.assertEqual(self.state["uploads"], [])
        self.assertEqual(self.state["prompts"], [])

    def test_missing_models_and_nodes_fail_before_upload(self):
        del self.state["info"]["MiniMaxH3AddGuide"]
        with self.assertRaisesRegex(bridge.BridgeError, "缺少工作流节点"):
            self.submit(first_frame_url=DATA)
        self.state["info"] = object_info()
        self.state["info"]["UNETLoader"]["input"]["required"]["unet_name"] = [["different.safetensors"]]
        with self.assertRaisesRegex(bridge.BridgeError, "缺少模型文件"):
            self.submit(reference_urls=[DATA])
        self.assertEqual(self.state["uploads"], [])

    def test_validate_endpoint_never_uploads_or_submits(self):
        preview = self.service.submit({**self.options, "reference_urls": [DATA], "last_frame_url": DATA}, preview=True)
        self.assertTrue(preview["valid"])
        self.assertEqual(preview["reference_count"], 1)
        self.assertEqual(preview["guide_count"], 1)
        self.assertEqual(preview["workflow"]["lmd_guide_1"]["inputs"]["frame_idx"], -1)
        self.assertEqual(self.state["uploads"], [])
        self.assertEqual(self.state["prompts"], [])

    def test_completed_native_savevideo_images_is_downloadable_video(self):
        result = self.submit()
        self.complete()
        polled = self.service.poll(result["task_id"])
        self.assertEqual(polled["status"], "completed")
        self.assertIn("/view?filename=%E9%95%9C%E5%A4%B4+1.mp4", polled["video_url"])
        self.assertIn("subfolder=video%2Flmd+sample", polled["video_url"])

    def test_alternative_video_and_gif_output_collections(self):
        for model, node, field in ((bridge.MODEL_WAN, "11", "videos"), (bridge.MODEL_H3, "92", "gifs")):
            result = self.submit(model=model)
            self.complete(node=node, field=field)
            self.assertEqual(self.service.poll(result["task_id"])["status"], "completed")

    def test_execution_error_wins_over_stale_output(self):
        result = self.submit()
        self.complete()
        self.state["history"]["native-prompt-id"]["status"] = {"status_str": "error", "completed": True,
            "messages": [["execution_error", {"node_id": "125", "exception_message": "CUDA out of memory"}]]}
        output = self.service.poll(result["task_id"])
        self.assertEqual(output["status"], "failed")
        self.assertIn("CUDA out of memory", output["error"])
        self.assertNotIn("video_url", output)

    def test_success_without_video_is_failure(self):
        result = self.submit()
        self.state["history"] = {"native-prompt-id": {"status": {"completed": True}, "outputs": {"92": {"images": [{"filename": "preview.png"}]}}}}
        self.assertIn("未找到", self.service.poll(result["task_id"])["error"])

    def test_queued_running_and_lost_task_states(self):
        result = self.submit()
        task_id = result["task_id"]
        self.state["queue"]["queue_pending"] = [[7, "other", {}, {}], [8, "native-prompt-id", {}, {}]]
        self.assertEqual(self.service.poll(task_id)["queue_position"], 2)
        self.state["queue"] = {"queue_running": [[8, "native-prompt-id", {}, {}]], "queue_pending": []}
        self.assertEqual(self.service.poll(task_id)["queue_position"], 0)
        task = self.service.get(task_id)
        task["created_at"] -= 120
        self.service.save(task)
        self.state["queue"] = {}
        self.assertEqual(self.service.poll(task_id)["status"], "failed")

    def test_restart_recovers_task_without_persisting_secret_or_prompt(self):
        result = self.submit(comfyui_token="private-native-token")
        stored = Path(self.temp.name, result["task_id"] + ".json").read_text(encoding="utf-8")
        self.assertNotIn("private-native-token", stored)
        self.assertNotIn(self.options["prompt"], stored)
        self.complete()
        restarted = bridge.BridgeService(self.temp.name)
        self.assertEqual(restarted.poll(result["task_id"], "private-native-token")["status"], "completed")
        self.assertEqual(self.state["headers"][-1]["Authorization"], "Bearer private-native-token")

    def test_submit_error_does_not_create_fake_processing_task(self):
        self.state["reject"] = True
        with self.assertRaisesRegex(bridge.BridgeError, "HTTP 400"):
            self.submit()
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_dimensions_seed_and_duration_validation(self):
        for changes in ({"duration": 0}, {"duration": "nan"}, {"seed": -2}, {"seed": 1.5},
                        {"aspect_ratio": "0:16"}, {"resolution": "huge"}):
            with self.assertRaises(bridge.BridgeError):
                self.submit(**changes)
        self.assertEqual(self.state["headers"], [])
        graph, data = bridge.build_workflow(bridge.MODEL_H3, {**self.options, "resolution": "480x864"}, [], "sample")
        self.assertEqual((data["width"], data["height"]), (480, 864))
        self.assertEqual(graph["131"]["inputs"]["height"], 864)

    def test_image_references_keep_order_and_first_image_geometry(self):
        result = self.submit(model=bridge.MODEL_QWEN_REFERENCE, size="1664x928", reference_urls=[DATA] * 5)
        graph = self.state["prompts"][0]["prompt"]
        self.assertEqual(len(self.state["uploads"]), 5)
        for index in range(1, 6):
            self.assertEqual(graph[f"lmd_image_{index}"]["inputs"]["image"], f"actual/input/server-renamed-{index}.png")
            self.assertEqual(graph["5"]["inputs"][f"images.image_{index}"], ["10" if index == 1 else f"lmd_image_{index}", 0])
        self.assertEqual(graph["10"]["inputs"]["image"], ["lmd_image_1", 0])
        self.assertEqual(graph["7"]["inputs"]["latent_image"], ["5", 2])
        self.assertEqual(graph["11"]["inputs"]["width"], 1664)
        self.assertEqual(graph["11"]["inputs"]["height"], 928)
        self.assertEqual(result["metadata"]["reference_count"], 5)
        self.assertEqual(result["metadata"]["steps"], 40)
        self.assertEqual(result["metadata"]["cfg"], 1)

    def test_image_input_schema_boundary_never_silently_discards(self):
        options = {**self.options, "model": bridge.MODEL_QWEN_REFERENCE, "reference_urls": [DATA] * 16}
        preview = self.service.submit(options, preview=True)
        self.assertEqual(preview["reference_count"], 16)
        self.assertIn("images.image_16", preview["workflow"]["5"]["inputs"])
        self.assertEqual(self.state["uploads"], [])
        options["reference_urls"].append(DATA)
        with self.assertRaisesRegex(bridge.BridgeError, "实际支持 16.*传入 17"):
            self.service.submit(options)
        self.assertEqual(self.state["uploads"], [])
        self.assertEqual(self.state["prompts"], [])
        # Capacity follows the actual live schema rather than a hardcoded quality cap.
        self.state["info"]["TextEncodeQwenImage21"]["input"]["required"]["images"][1]["template"]["names"].append("image_17")
        preview = self.service.submit(options, preview=True)
        self.assertEqual(preview["reference_count"], 17)
        self.assertIn("images.image_17", preview["workflow"]["5"]["inputs"])

    def test_image_without_references_uses_requested_aspect_latent(self):
        result = self.submit(model=bridge.MODEL_QWEN_REFERENCE, size="864x1536")
        graph = self.state["prompts"][0]["prompt"]
        self.assertFalse(any(node["class_type"] == "LoadImage" for node in graph.values()))
        self.assertNotIn("10", graph)
        self.assertEqual(graph["7"]["inputs"]["latent_image"], ["lmd_empty", 0])
        self.assertLess(graph["lmd_empty"]["inputs"]["width"], graph["lmd_empty"]["inputs"]["height"])
        self.assertEqual(result["metadata"]["reference_count"], 0)
        self.assertEqual(self.state["uploads"], [])

    def test_image_completed_output_and_restart_recovery(self):
        result = self.submit(model=bridge.MODEL_QWEN_REFERENCE, reference_urls=[DATA, DATA])
        self.state["history"] = {"native-prompt-id": {"status": {"completed": True}, "outputs": {
            "9": {"images": [{"filename": "镜头 1.png", "subfolder": "image/lmd sample", "type": "output"}]}}}}
        restarted = bridge.BridgeService(self.temp.name)
        output = restarted.poll(result["task_id"])
        self.assertEqual(output["status"], "completed")
        self.assertIn("subfolder=image%2Flmd+sample", output["image_url"])
        self.assertNotIn("video_url", output)

    def test_image_preview_or_execution_error_is_not_success(self):
        result = self.submit(model=bridge.MODEL_QWEN_REFERENCE)
        self.state["history"] = {"native-prompt-id": {"status": {"completed": True}, "outputs": {
            "9": {"images": [{"filename": "preview.png", "type": "temp"}]}}}}
        self.assertEqual(self.service.poll(result["task_id"])["status"], "failed")
        result = self.submit(model=bridge.MODEL_QWEN_REFERENCE)
        self.complete(node="9")
        self.state["history"]["native-prompt-id"]["status"]["messages"] = [["execution_error", {
            "node_id": "5", "exception_message": "encoder failed"}]]
        self.assertIn("encoder failed", self.service.poll(result["task_id"])["error"])

    def test_image_invalid_size_and_missing_dependency_do_not_upload(self):
        for size in ("bad", "0x1024", "20000x1024"):
            with self.assertRaises(bridge.BridgeError):
                self.submit(model=bridge.MODEL_QWEN_REFERENCE, size=size, reference_urls=[DATA])
        del self.state["info"]["TextEncodeQwenImage21"]
        with self.assertRaisesRegex(bridge.BridgeError, "TextEncodeQwenImage21"):
            self.submit(model=bridge.MODEL_QWEN_REFERENCE, reference_urls=[DATA])
        self.assertEqual(self.state["uploads"], [])
        self.assertEqual(self.state["prompts"], [])

    def test_http_health_auth_and_zero_generation_validation(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.handler_for(self.service, "test-secret", 1234))
        worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        worker.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            with urlopen(base + "/health") as response:
                health = json.load(response)
                self.assertEqual(health["service"], bridge.SERVICE)
                self.assertNotIn("auth_proof", health)
                self.assertNotIn("parent_pid", health)
            challenge = "ab" * 32
            request = Request(base + "/health", headers={"X-LMD-Bridge-Challenge": challenge})
            with urlopen(request) as response:
                health = json.load(response)
                payload = f"v1:{challenge}:{health['pid']}:1234:{health['launcher_pid']}".encode()
                self.assertEqual(health["auth_proof"], bridge.hmac.new(b"test-secret", payload, bridge.hashlib.sha256).hexdigest())
                self.assertNotIn("test-secret", json.dumps(health))
            request = Request(base + "/video/generations", data=b"{}", headers={"Content-Type": "application/json"})
            with self.assertRaises(HTTPError) as caught:
                urlopen(request)
            self.assertEqual(caught.exception.code, 401)
            caught.exception.close()
            request = Request(base + "/video/validate", data=json.dumps(self.options).encode(),
                              headers={"Content-Type": "application/json", "Authorization": "Bearer test-secret"})
            with urlopen(request) as response:
                self.assertTrue(json.load(response)["valid"])
            self.assertEqual(self.state["prompts"], [])
            image_options = {**self.options, "model": bridge.MODEL_QWEN_REFERENCE, "reference_urls": [DATA] * 3}
            request = Request(base + "/image/validate", data=json.dumps(image_options).encode(),
                              headers={"Content-Type": "application/json", "Authorization": "Bearer test-secret"})
            with urlopen(request) as response:
                preview = json.load(response)
                self.assertTrue(preview["valid"])
                self.assertEqual(preview["reference_count"], 3)
            self.assertEqual(self.state["prompts"], [])
            self.assertEqual(self.state["uploads"], [])
            request = Request(base + "/image/generations", data=json.dumps(image_options).encode(),
                              headers={"Content-Type": "application/json", "Authorization": "Bearer test-secret"})
            with urlopen(request) as response:
                result = json.load(response)
            self.assertEqual(result["status"], "processing")
            request = Request(base + "/image/task/" + result["task_id"], headers={"Authorization": "Bearer test-secret"})
            with urlopen(request) as response:
                self.assertEqual(json.load(response)["status"], "processing")
        finally:
            server.shutdown()
            server.server_close()
            worker.join(2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
