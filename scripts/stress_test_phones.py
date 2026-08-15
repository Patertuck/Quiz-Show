#!/usr/bin/env python3
"""Stress-test the quiz server with concurrent virtual phone clients.

Examples:
  python scripts/stress_test_phones.py
  python scripts/stress_test_phones.py --phones 15 --duration 10 --transport sse
  python scripts/stress_test_phones.py --base-url https://example.trycloudflare.com --transport polling
"""

from __future__ import annotations

import argparse
import concurrent.futures
import http.client
import json
import math
import statistics
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path


SSE_PATHS = (
    "/api/presentation/events",
    "/api/buzzer/events",
    "/api/ordering/events?teamIndex={team}",
    "/api/listing/events?teamIndex={team}",
    "/api/sync/events?deviceId={device}",
    "/api/team-lobby/events?deviceId={device}",
)
EXPECTED_SNAPSHOT_KEYS = {"presentation", "teamLobby", "buzzer", "ordering", "listing", "sync"}


def percentile(values: list[float], percentage: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil((percentage / 100) * len(ordered)) - 1)
    return ordered[index]


def request_json(url: str, timeout: float) -> tuple[dict, float]:
    started = time.perf_counter()
    request = urllib.request.Request(url, headers={"Cache-Control": "no-store", "User-Agent": "quiz-phone-stress-test"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        payload = json.load(response)
    return payload, (time.perf_counter() - started) * 1000


def discover_team_count(base_url: str, timeout: float) -> int:
    payload, _latency = request_json(f"{base_url}/api/live-state", timeout)
    teams = payload.get("buzzer", {}).get("teams", [])
    return max(1, len(teams))


def start_local_server(base_url: str, timeout: float) -> subprocess.Popen | None:
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.hostname not in {"127.0.0.1", "localhost"} or (parsed.port or 80) != 8000:
        return None
    repository = Path(__file__).resolve().parent.parent
    server_code = (
        "import main; "
        "main.BUZZER.sync_teams(main.load_current_state()); "
        "server = main.LocalQuizServer((main.BIND_HOST, main.PORT), main.QuizRequestHandler); "
        "server.serve_forever()"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", server_code],
        cwd=repository,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + max(5, timeout)
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return None
        try:
            discover_team_count(base_url, min(1, timeout))
            return process
        except Exception:  # noqa: BLE001 - retry until the local server is ready
            time.sleep(0.2)
    process.terminate()
    process.wait(timeout=2)
    return None


def run_polling(args: argparse.Namespace, team_count: int) -> tuple[int, int, list[float], list[str]]:
    barrier = threading.Barrier(args.phones)

    def phone(phone_index: int) -> tuple[int, int, list[float], list[str]]:
        successes = 0
        failures = 0
        latencies: list[float] = []
        errors: list[str] = []
        device = f"stress-device-{phone_index:04d}"
        client = f"stress-client-{phone_index:04d}"
        team = phone_index % team_count
        parameters = urllib.parse.urlencode({"teamIndex": team, "deviceId": device, "clientId": client})
        barrier.wait()
        deadline = time.monotonic() + args.duration
        while time.monotonic() < deadline:
            try:
                payload, latency = request_json(f"{args.base_url}/api/live-state?{parameters}", args.timeout)
                missing = EXPECTED_SNAPSHOT_KEYS.difference(payload)
                if missing:
                    raise RuntimeError(f"snapshot missing {', '.join(sorted(missing))}")
                successes += 1
                latencies.append(latency)
            except Exception as error:  # noqa: BLE001 - the report must include all client failures
                failures += 1
                errors.append(f"phone {phone_index + 1}: {error}")
            time.sleep(args.interval)
        return successes, failures, latencies, errors

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.phones) as executor:
        results = list(executor.map(phone, range(args.phones)))
    return (
        sum(item[0] for item in results),
        sum(item[1] for item in results),
        [latency for item in results for latency in item[2]],
        [error for item in results for error in item[3]],
    )


def run_sse(args: argparse.Namespace, team_count: int) -> tuple[int, int, list[float], list[str]]:
    parsed = urllib.parse.urlsplit(args.base_url)
    connection_class = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    barrier = threading.Barrier(args.phones)

    def phone(phone_index: int) -> tuple[int, list[float], list[str]]:
        device = urllib.parse.quote(f"stress-device-{phone_index:04d}")
        team = phone_index % team_count
        paths = [path.format(team=team, device=device) for path in SSE_PATHS]
        connections: list[http.client.HTTPConnection] = []
        latencies: list[float] = []
        errors: list[str] = []
        try:
            barrier.wait()
            for path in paths:
                connection = connection_class(parsed.hostname, parsed.port, timeout=args.timeout)
                try:
                    started = time.perf_counter()
                    connection.request("GET", path, headers={
                        "Accept": "text/event-stream", "User-Agent": "quiz-phone-stress-test"
                    })
                    response = connection.getresponse()
                    if response.status != 200:
                        raise RuntimeError(f"HTTP {response.status} for {path}")
                    received_data = False
                    while True:
                        line = response.readline()
                        if not line:
                            raise RuntimeError(f"stream closed before first event: {path}")
                        if line.startswith(b"data:"):
                            json.loads(line[5:].strip())
                            received_data = True
                        if received_data and line in {b"\n", b"\r\n"}:
                            break
                    latencies.append((time.perf_counter() - started) * 1000)
                    connections.append(connection)
                except Exception as error:  # noqa: BLE001
                    connection.close()
                    errors.append(f"phone {phone_index + 1}: {error}")
            time.sleep(args.duration)
        except Exception as error:  # noqa: BLE001 - the report must include all stream failures
            errors.append(f"phone {phone_index + 1}: {error}")
        finally:
            for connection in connections:
                connection.close()
        return len(latencies), latencies, errors

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.phones) as executor:
        results = list(executor.map(phone, range(args.phones)))
    latencies = [latency for _successes, phone_latencies, _errors in results for latency in phone_latencies]
    errors = [error for _successes, _latencies, phone_errors in results for error in phone_errors]
    return sum(item[0] for item in results), len(errors), latencies, errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Simulate concurrent phones connected to a running Quizshow server.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000", help="Quiz server URL (default: %(default)s)")
    parser.add_argument("--phones", type=int, default=15, help="Number of virtual phones (default: %(default)s)")
    parser.add_argument("--duration", type=float, default=10, help="Seconds to keep clients connected (default: %(default)s)")
    parser.add_argument("--transport", choices=("sse", "polling"), default="sse", help="Player live transport (default: %(default)s)")
    parser.add_argument("--interval", type=float, default=0.75, help="Polling interval in seconds (default: %(default)s)")
    parser.add_argument("--timeout", type=float, default=5, help="Connection timeout in seconds (default: %(default)s)")
    parser.add_argument("--no-auto-start", action="store_true", help="Do not start a missing local server automatically")
    args = parser.parse_args()
    args.base_url = args.base_url.rstrip("/")
    if args.phones < 1 or args.duration <= 0 or args.interval <= 0 or args.timeout <= 0:
        parser.error("phones, duration, interval, and timeout must be positive")
    return args


def main() -> int:
    args = parse_args()
    owned_server = None
    try:
        team_count = discover_team_count(args.base_url, args.timeout)
    except Exception as error:  # noqa: BLE001
        if not args.no_auto_start:
            print("No local quiz server found; starting a temporary instance …")
            owned_server = start_local_server(args.base_url, args.timeout)
        if owned_server is None:
            print(f"FAIL: server discovery failed: {error}")
            return 2
        team_count = discover_team_count(args.base_url, args.timeout)
    try:
        print(f"Simulating {args.phones} phones via {args.transport} for {args.duration:g}s ({team_count} teams) …")
        started = time.perf_counter()
        if args.transport == "sse":
            successes, failures, latencies, errors = run_sse(args, team_count)
            expected = args.phones * len(SSE_PATHS)
            unit = "streams"
        else:
            successes, failures, latencies, errors = run_polling(args, team_count)
            expected = successes + failures
            unit = "requests"
        elapsed = time.perf_counter() - started
        print(f"Completed in {elapsed:.2f}s: {successes}/{expected} successful {unit}, {failures} failures")
        if latencies:
            print(
                "First-response latency: "
                f"mean {statistics.fmean(latencies):.1f} ms, "
                f"p50 {percentile(latencies, 50):.1f} ms, "
                f"p95 {percentile(latencies, 95):.1f} ms, "
                f"max {max(latencies):.1f} ms"
            )
        for error in errors[:10]:
            print(f"  ERROR {error}")
        if len(errors) > 10:
            print(f"  … and {len(errors) - 10} more errors")
        if failures:
            print("FAIL: at least one virtual phone connection failed")
            return 1
        print("PASS: all virtual phones connected and received valid live state")
        return 0
    finally:
        if owned_server is not None:
            owned_server.terminate()
            try:
                owned_server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                owned_server.kill()
                owned_server.wait(timeout=3)


if __name__ == "__main__":
    raise SystemExit(main())
