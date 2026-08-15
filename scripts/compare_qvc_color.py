#!/usr/bin/env python3
"""Compare aligned CS161 SDR and BS4K 221 HLG broadcasts without recording them."""

from __future__ import annotations

import argparse
import array
import dataclasses
import datetime as dt
import json
import math
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
from typing import BinaryIO


DEFAULT_BASE = "http://192.168.6.253:40772"
CS_SERVICE_ID = 700161
BS4K_SERVICE_ID = 1100221
WIDTH = 96
HEIGHT = 54
PIXELS = WIDTH * HEIGHT
FRAME_BYTES = PIXELS * 3 * 4


@dataclasses.dataclass
class Frame:
    index: int
    fingerprint: list[float]
    metrics: dict[str, object]
    preview: bytes


@dataclasses.dataclass
class Pipeline:
    name: str
    commands: list[list[str]]
    processes: list[subprocess.Popen[bytes]]
    log_files: list[BinaryIO]

    @property
    def output(self) -> BinaryIO:
        output = self.processes[-1].stdout
        if output is None:
            raise RuntimeError(f"{self.name}: FFmpeg stdout is unavailable")
        return output

    def terminate(self) -> None:
        for process in reversed(self.processes):
            if process.poll() is None:
                process.terminate()

    def wait(self, graceful: bool = False) -> list[int]:
        if graceful:
            try:
                self.processes[-1].wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.processes[-1].terminate()
        else:
            self.terminate()
        statuses = []
        for process in reversed(self.processes):
            try:
                status = process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    status = process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    status = process.wait()
            statuses.append(status)
        for log_file in self.log_files:
            log_file.close()
        return list(reversed(statuses))


def command_path(value: str, label: str) -> str:
    path = shutil.which(value)
    if path is None:
        raise RuntimeError(f"required command is not available: {label} ({value})")
    return str(Path(path).resolve())


def find_tlvdemux(requested: str | None, root: Path) -> str:
    candidates = [requested, os.environ.get("TLVDEMUX_BIN"), str(root / "build/tlvdemux")]
    candidates.extend(["tlvdemux"])
    for candidate in candidates:
        if not candidate:
            continue
        path = shutil.which(candidate)
        if path:
            return str(Path(path).resolve())
        local = Path(candidate).expanduser()
        if local.is_file() and os.access(local, os.X_OK):
            return str(local.resolve())
    raise RuntimeError(
        "tlvdemux was not found; build ./build/tlvdemux or pass --tlvdemux PATH"
    )


def filter_path(path: Path) -> str:
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def decoder_command(ffmpeg: str, input_format: str, frames: int, fps: float,
                    source: str, bs_mode: str = "source",
                    lut_path: Path | None = None) -> list[str]:
    if source == "cs":
        conversion = (
            f"fps={fps},zscale=w={WIDTH}:h={HEIGHT}:filter=bilinear:"
            "matrixin=709:transferin=709:primariesin=709:rangein=limited:"
            "matrix=gbr:transfer=linear:primaries=709:range=full:npl=100,"
            "format=gbrpf32le"
        )
    elif bs_mode == "source":
        conversion = (
            f"fps={fps},zscale=w={WIDTH}:h={HEIGHT}:filter=bilinear:"
            "matrixin=2020_ncl:transferin=arib-std-b67:primariesin=2020:"
            "rangein=limited:matrix=gbr:transfer=linear:primaries=709:"
            "range=full:npl=100,format=gbrpf32le"
        )
    else:
        if lut_path is None:
            raise RuntimeError("current-sdr analysis requires the exported 3D LUT")
        prototype = bs_mode == "prototype-sdr"
        transfer = "iec61966-2-1" if prototype else "709"
        primaries = "709" if prototype else "2020"
        conversion = (
            f"fps={fps},zscale=w={WIDTH}:h={HEIGHT}:filter=bilinear:"
            f"matrixin=2020_ncl:transferin={transfer}:primariesin={primaries}:"
            f"rangein=limited:matrix=gbr:transfer={transfer}:primaries=709:"
            "range=full:npl=100,"
            f"format=gbrpf32le,lut3d=file='{filter_path(lut_path)}':interp=trilinear,"
            f"zscale=matrixin=gbr:transferin={transfer}:primariesin=709:rangein=full:"
            "matrix=gbr:transfer=linear:primaries=709:range=full:npl=100,"
            "format=gbrpf32le"
        )
    return [
        ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "info",
        "-skip_frame", "nokey", "-f", input_format, "-i", "pipe:0",
        "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", conversion,
        "-frames:v", str(frames), "-pix_fmt", "gbrpf32le",
        "-f", "rawvideo", "pipe:1",
    ]


def start_pipeline(name: str, commands: list[list[str]], output_dir: Path) -> Pipeline:
    processes: list[subprocess.Popen[bytes]] = []
    logs: list[BinaryIO] = []
    previous_stdout: BinaryIO | None = None
    for index, command in enumerate(commands):
        log = (output_dir / f"{name}-{index + 1}.stderr.log").open("wb")
        logs.append(log)
        process = subprocess.Popen(
            command,
            stdin=previous_stdout,
            stdout=subprocess.PIPE,
            stderr=log,
            cwd=output_dir.parent,
        )
        if previous_stdout is not None:
            previous_stdout.close()
        previous_stdout = process.stdout
        processes.append(process)
    return Pipeline(name, commands, processes, logs)


def read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = stream.read(size - len(chunks))
        if not chunk:
            break
        chunks.extend(chunk)
    return bytes(chunks)


def percentile(sorted_values: list[float], ratio: float) -> float:
    position = ratio * (len(sorted_values) - 1)
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    amount = position - lower
    return sorted_values[lower] * (1.0 - amount) + sorted_values[upper] * amount


def normalize(values: list[float]) -> list[float]:
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    scale = math.sqrt(variance)
    if scale < 1e-9:
        return [0.0] * len(values)
    return [(value - mean) / scale for value in values]


def fingerprint(luma: list[float]) -> list[float]:
    grid_width = 12
    grid_height = 6
    x0, x1 = WIDTH // 10, WIDTH - WIDTH // 10
    y0, y1 = HEIGHT // 10, HEIGHT - HEIGHT // 10
    cells = []
    for grid_y in range(grid_height):
        top = y0 + (y1 - y0) * grid_y // grid_height
        bottom = y0 + (y1 - y0) * (grid_y + 1) // grid_height
        for grid_x in range(grid_width):
            left = x0 + (x1 - x0) * grid_x // grid_width
            right = x0 + (x1 - x0) * (grid_x + 1) // grid_width
            values = [luma[y * WIDTH + x]
                      for y in range(top, bottom) for x in range(left, right)]
            cells.append(sum(values) / len(values))
    return normalize(cells)


def bt709_encode(value: float) -> int:
    value = min(1.0, max(0.0, value))
    encoded = 4.5 * value if value < 0.018 else 1.099 * value ** 0.45 - 0.099
    return round(255.0 * min(1.0, max(0.0, encoded)))


def analyze_frame(index: int, raw: bytes) -> Frame:
    values = array.array("f")
    values.frombytes(raw)
    if sys.byteorder != "little":
        values.byteswap()
    green = values[0:PIXELS]
    blue = values[PIXELS:2 * PIXELS]
    red = values[2 * PIXELS:3 * PIXELS]
    luma = [0.2126 * red[i] + 0.7152 * green[i] + 0.0722 * blue[i]
            for i in range(PIXELS)]
    ordered_luma = sorted(luma)
    mean_red = sum(red) / PIXELS
    mean_green = sum(green) / PIXELS
    mean_blue = sum(blue) / PIXELS
    mean_luma = sum(luma) / PIXELS
    saturation = sum(
        (max(red[i], green[i], blue[i]) - min(red[i], green[i], blue[i])) /
        max(max(red[i], green[i], blue[i]), 1e-9)
        for i in range(PIXELS)
    ) / PIXELS
    x_value = 0.4123908 * mean_red + 0.3575843 * mean_green + 0.1804808 * mean_blue
    y_value = 0.2126390 * mean_red + 0.7151687 * mean_green + 0.0721923 * mean_blue
    z_value = 0.0193308 * mean_red + 0.1191948 * mean_green + 0.9505322 * mean_blue
    xyz_total = x_value + y_value + z_value
    preview = bytearray(PIXELS * 3)
    for i in range(PIXELS):
        preview[i * 3] = bt709_encode(red[i])
        preview[i * 3 + 1] = bt709_encode(green[i])
        preview[i * 3 + 2] = bt709_encode(blue[i])
    metrics: dict[str, object] = {
        "mean_rgb": [mean_red, mean_green, mean_blue],
        "mean_luma": mean_luma,
        "luma_p10": percentile(ordered_luma, 0.10),
        "luma_p50": percentile(ordered_luma, 0.50),
        "luma_p90": percentile(ordered_luma, 0.90),
        "luma_p99": percentile(ordered_luma, 0.99),
        "mean_xy": [x_value / xyz_total, y_value / xyz_total]
        if xyz_total > 1e-9 else [0.0, 0.0],
        "mean_saturation": saturation,
        "below_zero_fraction": sum(value < 0.0 for value in luma) / PIXELS,
        "above_one_fraction": sum(value > 1.0 for value in luma) / PIXELS,
    }
    return Frame(index, fingerprint(luma), metrics, bytes(preview))


def capture_frames(pipeline: Pipeline, count: int) -> list[Frame]:
    frames = []
    for index in range(count):
        raw = read_exact(pipeline.output, FRAME_BYTES)
        if len(raw) != FRAME_BYTES:
            raise RuntimeError(
                f"{pipeline.name}: decoded stream ended after {len(frames)} frames; "
                f"wanted {count} (partial frame bytes={len(raw)})"
            )
        frames.append(analyze_frame(index, raw))
    return frames


def cosine(left: list[float], right: list[float]) -> float:
    numerator = sum(a * b for a, b in zip(left, right))
    denominator = math.sqrt(sum(a * a for a in left) * sum(b * b for b in right))
    return numerator / denominator if denominator > 1e-9 else 0.0


def difference(current: list[float], previous: list[float]) -> list[float]:
    return normalize([a - b for a, b in zip(current, previous)])


def alignment_score(cs: list[Frame], bs: list[Frame], shift: int) -> float:
    start = max(1, -shift + 1)
    end = min(len(cs), len(bs) - shift)
    if end - start < 10:
        return -1.0
    direct = []
    motion = []
    for cs_index in range(start, end):
        bs_index = cs_index + shift
        direct.append(cosine(cs[cs_index].fingerprint, bs[bs_index].fingerprint))
        cs_delta = difference(cs[cs_index].fingerprint, cs[cs_index - 1].fingerprint)
        bs_delta = difference(bs[bs_index].fingerprint, bs[bs_index - 1].fingerprint)
        motion.append(cosine(cs_delta, bs_delta))
    return 0.35 * (sum(direct) / len(direct)) + 0.65 * (sum(motion) / len(motion))


def align(cs: list[Frame], bs: list[Frame], max_shift: int) -> tuple[int, list[dict[str, float]]]:
    scores = [{"shift_frames": shift, "score": alignment_score(cs, bs, shift)}
              for shift in range(-max_shift, max_shift + 1)]
    best = max(scores, key=lambda item: item["score"])
    return int(best["shift_frames"]), scores


def paired_metrics(cs_frame: Frame, bs_frame: Frame) -> dict[str, object]:
    cs_luma = float(cs_frame.metrics["mean_luma"])
    bs_luma = float(bs_frame.metrics["mean_luma"])
    cs_xy = cs_frame.metrics["mean_xy"]
    bs_xy = bs_frame.metrics["mean_xy"]
    assert isinstance(cs_xy, list) and isinstance(bs_xy, list)
    return {
        "cs_frame": cs_frame.index,
        "bs4k_frame": bs_frame.index,
        "structure_similarity": cosine(cs_frame.fingerprint, bs_frame.fingerprint),
        "cs": cs_frame.metrics,
        "bs4k": bs_frame.metrics,
        "difference": {
            "mean_luma_ratio_bs4k_over_cs": bs_luma / cs_luma if cs_luma > 1e-9 else None,
            "mean_luma_ev_bs4k_minus_cs": math.log2(bs_luma / cs_luma)
            if cs_luma > 1e-9 and bs_luma > 1e-9 else None,
            "mean_xy_bs4k_minus_cs": [bs_xy[0] - cs_xy[0], bs_xy[1] - cs_xy[1]],
            "mean_saturation_bs4k_minus_cs":
                float(bs_frame.metrics["mean_saturation"]) -
                float(cs_frame.metrics["mean_saturation"]),
        },
    }


def aggregate_pairs(records: list[dict[str, object]]) -> dict[str, object]:
    differences = [record["difference"] for record in records]
    assert all(isinstance(value, dict) for value in differences)

    def numbers(key: str) -> list[float]:
        return [float(value[key]) for value in differences
                if isinstance(value, dict) and value[key] is not None]

    def distribution(values: list[float]) -> dict[str, float]:
        ordered = sorted(values)
        return {
            "mean": sum(ordered) / len(ordered),
            "p10": percentile(ordered, 0.10),
            "p50": percentile(ordered, 0.50),
            "p90": percentile(ordered, 0.90),
        }

    xy = [value["mean_xy_bs4k_minus_cs"] for value in differences
          if isinstance(value, dict)]
    similarities = [float(record["structure_similarity"]) for record in records]
    return {
        "mean_structure_similarity": sum(similarities) / len(similarities),
        "mean_luma_ev_bs4k_minus_cs": distribution(
            numbers("mean_luma_ev_bs4k_minus_cs")),
        "mean_luma_ratio_bs4k_over_cs": distribution(
            numbers("mean_luma_ratio_bs4k_over_cs")),
        "mean_saturation_bs4k_minus_cs": distribution(
            numbers("mean_saturation_bs4k_minus_cs")),
        "mean_xy_bs4k_minus_cs": [
            sum(float(value[0]) for value in xy) / len(xy),
            sum(float(value[1]) for value in xy) / len(xy),
        ],
    }


def write_snapshots(output_dir: Path, pairs: list[tuple[Frame, Frame]], fps: float,
                    interval: int, bs_label: str) -> list[dict[str, object]]:
    selected = []
    next_second = 0.0
    for pair_index, (cs_frame, bs_frame) in enumerate(pairs):
        second = pair_index / fps
        if second + 1e-9 < next_second:
            continue
        filename = f"aligned-{round(second):04d}s.ppm"
        pixels = bytearray()
        for row in range(HEIGHT):
            begin = row * WIDTH * 3
            end = begin + WIDTH * 3
            pixels.extend(cs_frame.preview[begin:end])
            pixels.extend(bs_frame.preview[begin:end])
        with (output_dir / filename).open("wb") as image:
            image.write(f"P6\n{WIDTH * 2} {HEIGHT}\n255\n".encode())
            image.write(pixels)
        selected.append({
            "elapsed_seconds": second,
            "file": filename,
            "layout": f"left=CS161 SDR, right={bs_label}; both linearized to BT.709",
            "cs_frame": cs_frame.index,
            "bs4k_frame": bs_frame.index,
        })
        next_second += interval
    return selected


def write_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def observed_video_signalling(log: Path) -> str | None:
    for line in log.read_text(errors="replace").splitlines():
        if "Video:" in line and "rawvideo" not in line:
            return line.strip()
    return None


def self_test() -> None:
    def fake(index: int, content: int) -> Frame:
        values = [math.sin(content * 0.71 + cell * 0.37) for cell in range(72)]
        return Frame(index, normalize(values), {"mean_luma": 1.0}, b"")
    cs = [fake(index, index) for index in range(80)]
    bs = [fake(index, index - 4) for index in range(80)]
    shift, _ = align(cs, bs, 10)
    if shift != 4:
        raise AssertionError(f"alignment test failed: expected 4, got {shift}")
    summary = aggregate_pairs([{
        "structure_similarity": 0.9,
        "difference": {
            "mean_luma_ev_bs4k_minus_cs": 1.0,
            "mean_luma_ratio_bs4k_over_cs": 2.0,
            "mean_saturation_bs4k_minus_cs": 0.1,
            "mean_xy_bs4k_minus_cs": [0.01, -0.02],
        },
    }])
    if summary["mean_luma_ev_bs4k_minus_cs"]["p50"] != 1.0:
        raise AssertionError("aggregate test failed")
    command = decoder_command("ffmpeg", "mp4", 10, 1.0, "bs", "current-sdr",
                              Path("current.cube"))
    if "lut3d=" not in command[command.index("-vf") + 1]:
        raise AssertionError("current SDR filter test failed")
    prototype_command = decoder_command(
        "ffmpeg", "mp4", 10, 1.0, "bs", "prototype-sdr",
        Path("prototype.cube"))
    if "primariesin=709" not in prototype_command[prototype_command.index("-vf") + 1]:
        raise AssertionError("prototype carrier filter test failed")
    print("qvc color comparison self-test passed")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Align and compare live CS161 SDR with BS4K 221 HLG. Raw streams are "
            "never written to disk and the project HLG-to-SDR LUT is not applied."
        )
    )
    parser.add_argument("--mirakurun-base", default=DEFAULT_BASE)
    parser.add_argument("--duration", type=int, default=600, help="analysis seconds (default: 600)")
    parser.add_argument("--fps", type=float, default=1.0, help="sample frames per second")
    parser.add_argument("--max-offset", type=int, default=30, help="maximum alignment offset in seconds")
    parser.add_argument("--snapshot-interval", type=int, default=60)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--tlvdemux")
    parser.add_argument("--video-packet-id", help="optional BS4K MMTP video packet ID")
    parser.add_argument(
        "--bs-mode", choices=["source", "current-sdr", "prototype-sdr"],
        default="source",
        help="compare the HLG source baseline or the current tlvdemux SDR result",
    )
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = arguments()
    if args.self_test:
        self_test()
        return 0
    if args.duration <= 0 or args.fps <= 0 or args.max_offset < 0:
        raise RuntimeError("duration/fps must be positive and max-offset must be non-negative")

    root = Path(__file__).resolve().parents[1]
    timestamp = dt.datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    output_dir = (args.output or root / "color-comparisons" / timestamp).resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    curl = command_path("curl", "curl")
    ffmpeg = command_path("ffmpeg", "FFmpeg")
    tlvdemux = find_tlvdemux(args.tlvdemux, root)
    frames = math.ceil(args.duration * args.fps)
    max_shift = math.ceil(args.max_offset * args.fps)
    base = args.mirakurun_base.rstrip("/")
    cs_url = f"{base}/api/services/{CS_SERVICE_ID}/stream?decode=0"
    bs_url = f"{base}/api/services/{BS4K_SERVICE_ID}/stream?decode=0"

    lut_path: Path | None = None
    lut_command: list[str] | None = None
    if args.bs_mode != "source":
        lut_path = output_dir / "current-hlg-sdr.cube"
        lut_command = [tlvdemux, "hlg-sdr-lut"]
        if args.bs_mode == "prototype-sdr":
            lut_command.append("--prototype")
        with lut_path.open("wb") as output, \
                (output_dir / "hlg-sdr-lut.stderr.log").open("wb") as error:
            result = subprocess.run(lut_command, stdout=output, stderr=error, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"tlvdemux hlg-sdr-lut exited with {result.returncode}")

    curl_cs = [curl, "--fail", "--silent", "--show-error", "--no-buffer", cs_url]
    curl_bs = [curl, "--fail", "--silent", "--show-error", "--no-buffer", bs_url]
    # The Mirakurun endpoint already selects service 221. libaribtlv's
    # --service option addresses its local package context (currently 1), not
    # the broadcast service_id, so selecting 221 here would suppress all media.
    pipe_bs = [tlvdemux, "pipe", "--video-only"]
    if args.bs_mode == "current-sdr":
        pipe_bs.append("--sdr-in-hlg")
    elif args.bs_mode == "prototype-sdr":
        pipe_bs.append("--hlg-sdr-prototype")
    if args.video_packet_id:
        pipe_bs.extend(["--video-packet-id", args.video_packet_id])
    pipe_bs.append("-")
    cs_commands = [curl_cs, decoder_command(ffmpeg, "mpegts", frames, args.fps, "cs")]
    bs_commands = [
        curl_bs, pipe_bs,
        decoder_command(ffmpeg, "mp4", frames, args.fps, "bs", args.bs_mode,
                        lut_path),
    ]
    manifest: dict[str, object] = {
        "status": "running",
        "started_at": dt.datetime.now().astimezone().isoformat(),
        "working_directory": str(root),
        "output_directory": str(output_dir),
        "duration_seconds": args.duration,
        "sample_fps": args.fps,
        "raw_streams_saved": False,
        "project_sdr_conversion_applied": args.bs_mode != "source",
        "bs_mode": args.bs_mode,
        "analysis_space": {
            "encoding": "linear RGB",
            "primaries": "BT.709",
            "nominal_peak_luminance": 100,
            "cs_input": "BT.709/BT.709/BT.709 limited",
            "bs4k_input": (
                "BT.2020/HLG/BT.2020 non-constant limited"
                if args.bs_mode == "source" else
                ("BT.709/sRGB/BT.2020 non-constant limited, then prototype 3D LUT"
                 if args.bs_mode == "prototype-sdr" else
                 "BT.2020/BT.709/BT.2020 non-constant limited, then current 3D LUT")
            ),
        },
        "commands": {"cs161": cs_commands, "bs4k221": bs_commands},
        "logs": {
            "cs161": ["cs161-1.stderr.log", "cs161-2.stderr.log"],
            "bs4k221": ["bs4k221-1.stderr.log", "bs4k221-2.stderr.log",
                         "bs4k221-3.stderr.log"],
        },
    }
    if lut_command is not None:
        manifest["commands"]["hlg_sdr_lut"] = [lut_command]
        manifest["logs"]["hlg_sdr_lut"] = ["hlg-sdr-lut.stderr.log"]
    write_json(output_dir / "run.json", manifest)

    pipelines: list[Pipeline] = []
    results: dict[str, list[Frame]] = {}
    completions: queue.Queue[tuple[str, list[Frame] | None, BaseException | None]] = queue.Queue()
    try:
        pipelines = [
            start_pipeline("bs4k221", bs_commands, output_dir),
            start_pipeline("cs161", cs_commands, output_dir),
        ]
        manifest["pipelines_started_at"] = dt.datetime.now().astimezone().isoformat()
        write_json(output_dir / "run.json", manifest)

        def worker(pipeline: Pipeline) -> None:
            try:
                completions.put((pipeline.name, capture_frames(pipeline, frames), None))
            except BaseException as error:  # Preserve the other pipeline's evidence before exit.
                completions.put((pipeline.name, None, error))

        threads = [threading.Thread(target=worker, args=(pipeline,), daemon=True)
                   for pipeline in pipelines]
        for thread in threads:
            thread.start()
        for _ in pipelines:
            name, captured, error = completions.get()
            if error is not None:
                for pipeline in pipelines:
                    pipeline.terminate()
                raise error
            assert captured is not None
            results[name] = captured
        for thread in threads:
            thread.join()

        shift, scores = align(results["cs161"], results["bs4k221"], max_shift)
        start = max(0, -shift)
        end = min(len(results["cs161"]), len(results["bs4k221"]) - shift)
        pairs = [(results["cs161"][index], results["bs4k221"][index + shift])
                 for index in range(start, end)]
        pair_records = [paired_metrics(cs_frame, bs_frame) for cs_frame, bs_frame in pairs]
        with (output_dir / "aligned-frames.jsonl").open("w") as records:
            for record in pair_records:
                records.write(json.dumps(record, ensure_ascii=False) + "\n")
        bs_label = ("BS4K221 HLG" if args.bs_mode == "source" else
                    ("BS4K221 prototype tlvdemux SDR"
                     if args.bs_mode == "prototype-sdr" else
                     "BS4K221 current tlvdemux SDR"))
        snapshots = write_snapshots(
            output_dir, pairs, args.fps, args.snapshot_interval, bs_label)
        cs_signalling = observed_video_signalling(output_dir / "cs161-2.stderr.log")
        bs_signalling = observed_video_signalling(output_dir / "bs4k221-3.stderr.log")
        expected_bs_signalling = (
            "bt2020nc/bt2020/arib-std-b67" if args.bs_mode == "source" else
            ("bt2020nc/bt709/iec61966-2-1"
             if args.bs_mode == "prototype-sdr" else
             "bt2020nc/bt2020/bt709")
        )
        signalling_matches = bool(cs_signalling and "bt709" in cs_signalling and
                                  bs_signalling and expected_bs_signalling in bs_signalling)
        best_score = max(item["score"] for item in scores)
        alternatives = [item["score"] for item in scores
                        if abs(item["shift_frames"] - shift) > max(1, round(args.fps))]
        report = {
            "alignment": {
                "definition": "matching bs4k_frame = cs_frame + shift_frames",
                "shift_frames": shift,
                "bs4k_content_delay_seconds": shift / args.fps,
                "best_score": best_score,
                "score_margin_outside_one_second":
                    best_score - max(alternatives) if alternatives else None,
                "all_scores": scores,
            },
            "captured_frames": {name: len(value) for name, value in results.items()},
            "aligned_frames": len(pairs),
            "summary": aggregate_pairs(pair_records),
            "source_signalling": {
                "matches_analysis_assumptions": signalling_matches,
                "cs161": cs_signalling,
                "bs4k221": bs_signalling,
            },
            "snapshots": snapshots,
            "frame_records": "aligned-frames.jsonl",
            "interpretation": [
                ("No tlvdemux HLG-to-SDR LUT or SDR-in-HLG rewrite was applied."
                 if args.bs_mode == "source" else
                 ("The BS4K path used the tlvdemux prototype carrier and its exact exported 8-bit 3D LUT."
                  if args.bs_mode == "prototype-sdr" else
                  "The BS4K path used tlvdemux SDR-in-HLG signalling and the exact exported 8-bit 3D LUT.")),
                "Both sources were linearized and converted to BT.709 primaries for analysis.",
                "The 100-nit normalization makes the luma comparison reproducible; it is not a display tone map.",
                ("FFmpeg trilinear LUT application reproduces the project transform but not the browser's exact video-texture pipeline."
                 if args.bs_mode != "source" else
                 "The source baseline does not measure the current project SDR output."),
                "CS161 is bitrate-limited MPEG-2: use it as a low-frequency SDR luma reference, not as spatial-detail or local-chroma ground truth.",
                "Inspect the complete process logs before trusting results if source signalling differs from the declared inputs.",
            ],
        }
        write_json(output_dir / "report.json", report)
        manifest["status"] = "complete"
        manifest["completed_at"] = dt.datetime.now().astimezone().isoformat()
        manifest["report"] = "report.json"
        print(output_dir)
        return 0
    except BaseException as error:
        manifest["status"] = "failed"
        manifest["failed_at"] = dt.datetime.now().astimezone().isoformat()
        manifest["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        statuses = {}
        for pipeline in pipelines:
            statuses[pipeline.name] = pipeline.wait(manifest.get("status") == "complete")
        if statuses:
            manifest["exit_statuses"] = statuses
            manifest["exit_status_note"] = (
                "FFmpeg should exit 0. Continuous curl/tlvdemux upstream processes may "
                "report broken-pipe or termination statuses after the requested frames."
            )
        write_json(output_dir / "run.json", manifest)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("interrupted; partial logs and run.json were retained", file=sys.stderr)
        raise SystemExit(130)
    except Exception as error:
        print(f"compare_qvc_color: {error}", file=sys.stderr)
        raise SystemExit(2)
