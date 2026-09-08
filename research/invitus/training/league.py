"""Opponent league and persistent production-tactic bridge."""
from __future__ import annotations

import json
import os
import queue
import random
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, ".")
from engine import srszq

AgentSpec = tuple[str] | tuple[str, str | int]


@dataclass(frozen=True)
class LeagueComposition:
    bucket: str
    seats: dict[str, AgentSpec]


class TacticBridge:
    """One persistent JSONL worker with timeout, restart, and visible fallbacks."""

    def __init__(
        self,
        repo_root: str | Path,
        timeout: float = 10.0,
        command: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self.root = Path(repo_root).resolve()
        self.timeout = timeout
        worker = self.root / "research" / "invitus" / "tools" / "tactic_worker.ts"
        tsx = self.root / "node_modules" / "tsx" / "dist" / "cli.mjs"
        self.command = command or ["node", str(tsx), str(worker)]
        self.env = dict(os.environ if env is None else env)
        if os.name == "nt" and command is None:
            patch = self.root / "research" / "invitus" / "tools" / "node_user_patch.cjs"
            option = f"--require={patch}"
            self.env["NODE_OPTIONS"] = " ".join(filter(None, [self.env.get("NODE_OPTIONS", ""), option]))
        self.proc: subprocess.Popen[str] | None = None
        self.lock = threading.Lock()
        self.seq = 0
        self.responses: queue.Queue[dict[str, Any]] = queue.Queue()
        self.stderr_tail: deque[str] = deque(maxlen=20)
        self.metrics = {
            "requests": 0,
            "successfulResponses": 0,
            "fallbacks": 0,
            "timeouts": 0,
            "protocolErrors": 0,
            "processErrors": 0,
            "restarts": 0,
        }
        self.last_error: str | None = None
        self.start()

    @property
    def healthy(self) -> bool:
        return (
            self.proc is not None
            and self.proc.poll() is None
            and self.metrics["successfulResponses"] > 0
            and self.last_error is None
        )

    def start(self) -> None:
        self.responses = queue.Queue()
        self.stderr_tail.clear()
        self.proc = subprocess.Popen(
            self.command,
            cwd=self.root,
            env=self.env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        threading.Thread(target=self._read_stdout, args=(self.proc,), daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(self.proc,), daemon=True).start()

    def _read_stdout(self, process: subprocess.Popen[str]) -> None:
        assert process.stdout is not None
        for line in process.stdout:
            try:
                response = json.loads(line)
                if not isinstance(response, dict):
                    raise ValueError("response is not an object")
                self.responses.put(response)
            except Exception as error:
                self.responses.put({"_protocolError": str(error)})

    def _read_stderr(self, process: subprocess.Popen[str]) -> None:
        assert process.stderr is not None
        for line in process.stderr:
            self.stderr_tail.append(line.rstrip())

    def _stop_process(self) -> None:
        process = self.proc
        self.proc = None
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1.0)
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass

    def _restart(self) -> None:
        self.metrics["restarts"] += 1
        self._stop_process()
        self.start()

    def close(self) -> None:
        with self.lock:
            self._stop_process()

    def __enter__(self) -> "TacticBridge":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _fallback(self, legal: list[tuple[int, int]], reason: str, metric: str) -> tuple[int, int] | None:
        self.metrics[metric] += 1
        self.metrics["fallbacks"] += 1
        self.last_error = reason
        self._restart()
        return legal[0] if legal else None

    def move(self, state: dict[str, Any], player: str, spec: str | int, seed: int) -> tuple[int, int] | None:
        legal = srszq.legal_moves(state)
        if not legal:
            return None
        with self.lock:
            self.seq += 1
            request_id = str(self.seq)
            request: dict[str, Any] = {
                "id": request_id,
                "board": [["." if cell is None else cell for cell in row] for row in state["board"]],
                "turn": state["turn"],
                "player": player,
                "seed": int(seed),
            }
            if isinstance(spec, str):
                request["tactic"] = spec
            else:
                request["difficulty"] = int(spec)
            self.metrics["requests"] += 1
            try:
                if self.proc is None or self.proc.poll() is not None or self.proc.stdin is None:
                    details = "; ".join(self.stderr_tail) or "worker is not running"
                    return self._fallback(legal, details, "processErrors")
                self.proc.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
                self.proc.stdin.flush()
                try:
                    response = self.responses.get(timeout=self.timeout)
                except queue.Empty:
                    return self._fallback(legal, f"worker timeout after {self.timeout:.3f}s", "timeouts")
                if response.get("_protocolError"):
                    return self._fallback(legal, str(response["_protocolError"]), "protocolErrors")
                if response.get("id") != request_id:
                    return self._fallback(legal, "response id mismatch", "protocolErrors")
                if response.get("error"):
                    return self._fallback(legal, str(response["error"]), "processErrors")
                if response.get("pass") is True:
                    return self._fallback(legal, "worker passed while legal moves exist", "protocolErrors")
                row, col = response.get("row"), response.get("col")
                if not isinstance(row, int) or not isinstance(col, int) or (row, col) not in legal:
                    return self._fallback(legal, "worker returned an illegal move", "protocolErrors")
                self.metrics["successfulResponses"] += 1
                self.last_error = None
                return row, col
            except (BrokenPipeError, OSError, ValueError) as error:
                return self._fallback(legal, str(error), "processErrors")


def discover_historical_checkpoints(
    checkpoint_dir: str | Path,
    exclude_path: str | Path | None = None,
    limit: int = 8,
) -> tuple[list[str], dict[str, str]]:
    """Return recent unique model states using embedded metadata, never filenames."""
    import torch

    excluded = Path(exclude_path).resolve() if exclude_path else None
    candidates: dict[tuple[str, int, int, int], tuple[float, Path]] = {}
    errors: dict[str, str] = {}
    for path in sorted(Path(checkpoint_dir).glob("*.pt")):
        if excluded is not None and path.resolve() == excluded:
            continue
        try:
            checkpoint = torch.load(path, map_location="cpu", weights_only=False)
            counter = int(checkpoint["counter"])
            cfg = checkpoint.get("cfg") if isinstance(checkpoint.get("cfg"), dict) else {}
            channels = int(cfg["channels"])
            blocks = int(cfg["blocks"])
            architecture = str(checkpoint.get("net") or "InvitusNet")
            if not isinstance(checkpoint.get("model"), dict):
                raise ValueError("checkpoint model state is missing")
            key = architecture, channels, blocks, counter
            previous = candidates.get(key)
            if previous is None or path.stat().st_mtime > previous[0]:
                candidates[key] = path.stat().st_mtime, path.resolve()
        except Exception as error:
            errors[path.name] = str(error).splitlines()[0][:240]
    ordered = sorted(candidates.items(), key=lambda item: (item[0][3], item[1][0]))
    return [str(value[1]) for _, value in ordered[-max(0, limit):]], errors


def load_historical_networks(paths: list[str], device: Any) -> dict[str, Any]:
    """Load each historical checkpoint using its own recorded architecture."""
    import torch
    from model.network import InvitusNet

    networks: dict[str, Any] = {}
    for path_text in paths:
        path = Path(path_text).resolve()
        checkpoint = torch.load(path, map_location="cpu", weights_only=False)
        cfg = checkpoint.get("cfg") if isinstance(checkpoint.get("cfg"), dict) else {}
        network = InvitusNet(int(cfg["channels"]), int(cfg["blocks"])).to(device)
        network.load_state_dict(checkpoint["model"])
        network.eval()
        networks[str(path)] = network
    return networks


def sample_composition(rng: random.Random, historical_checkpoints: list[str]) -> LeagueComposition:
    if not historical_checkpoints:
        raise ValueError("opponent league requires at least one historical checkpoint")
    seats = list("ABC")
    rng.shuffle(seats)
    roll = rng.random()
    if roll < 0.50:
        agents: dict[str, AgentSpec] = {seat: ("invitus",) for seat in seats}
        return LeagueComposition("selfplay", agents)
    if roll < 0.70:
        agents = {
            seats[0]: ("invitus",),
            seats[1]: ("historical", rng.choice(historical_checkpoints)),
            seats[2]: ("historical", rng.choice(historical_checkpoints)) if rng.random() < 0.5 else ("invitus",),
        }
        return LeagueComposition("historical", agents)
    if roll < 0.90:
        strong: str | int = rng.choice(["maxn", "3ply", 5])
        agents = {seats[0]: ("invitus",), seats[1]: ("tactic", strong), seats[2]: ("tactic", strong)}
        return LeagueComposition("strong", agents)
    weak: str = rng.choice(["random", "tactical", "selfish"])
    middle: int = rng.choice([1, 2, 3, 4])
    agents = {seats[0]: ("invitus",), seats[1]: ("tactic", weak), seats[2]: ("tactic", middle)}
    return LeagueComposition("diverse", agents)


def play_league_episode(
    net: Any,
    device: Any,
    sims: int,
    rng: random.Random,
    checkpoint_id: str,
    bridge: TacticBridge,
    historical_networks: dict[str, Any],
    temperature_first: int = 8,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    from mcts.nn_mcts import NNMCTS

    started = time.monotonic()
    size = 13 if rng.random() < 0.6 else 17
    state = srszq.create_state(size)
    composition = sample_composition(rng, list(historical_networks))
    samples: list[dict[str, Any]] = []
    game_id = uuid.uuid4().hex
    move_no = 0
    guard = 0
    bridge_before = dict(bridge.metrics)
    while state["status"] == "playing" and guard < size * size + 32:
        seat = srszq.current_player(state)
        agent = composition.seats[seat]
        legal = srszq.legal_moves(state)
        if not legal:
            srszq._advance_pass_chain(state)
            guard += 1
            continue
        if agent[0] == "invitus":
            search = NNMCTS(
                net,
                device,
                sims=sims,
                exact=None,
                rng=random.Random(rng.getrandbits(32)),
                train=True,
            )
            search.search(state)
            temperature = 1.0 if move_no < temperature_first else 0.0
            move, _ = search.best_move(temperature=temperature)
            visits = {legal_move: 0.0 for legal_move in legal}
            for child_move, child in search.root.children.items():
                visits[child_move] = float(child.N)
            samples.append(
                {
                    "board": ["".join("." if cell is None else cell for cell in row) for row in state["board"]],
                    "turn": state["turn"],
                    "size": size,
                    "actor": seat,
                    "legal": [[row, col] for row, col in legal],
                    "visits": {f"{row},{col}": value for (row, col), value in visits.items()},
                    "outcome": None,
                    "game_id": game_id,
                    "cp": checkpoint_id,
                    "league_bucket": composition.bucket,
                }
            )
        elif agent[0] == "historical":
            historical_net = historical_networks[str(agent[1])]
            search = NNMCTS(
                historical_net,
                device,
                sims=max(8, sims // 2),
                exact=None,
                rng=random.Random(rng.getrandbits(32)),
                train=False,
            )
            search.search(state)
            move, _ = search.best_move(temperature=0.0)
        else:
            move = bridge.move(state, seat, agent[1], rng.getrandbits(31))
            if move is None:
                srszq._advance_pass_chain(state)
                guard += 1
                continue
        result = srszq.apply_move(state, move[0], move[1])
        if result.startswith("rejected"):
            raise RuntimeError(f"league produced illegal move {move}: {result}")
        move_no += 1
        guard += 1
    if state["status"] == "playing":
        state["status"] = "draw"
    if state["status"] == "won":
        outcome = [0.0, 0.0, 0.0, 0.0]
        outcome["ABC".index(state["winner"])] = 1.0
        terminal_result = f"{state['winner']}_WIN"
    else:
        outcome = [0.0, 0.0, 0.0, 1.0]
        terminal_result = "DRAW"
    for sample in samples:
        sample["outcome"] = outcome
    bridge_delta = {key: bridge.metrics[key] - bridge_before[key] for key in bridge.metrics}
    metadata = {
        "game_id": game_id,
        "boardSize": size,
        "result": terminal_result,
        "num_samples": len(samples),
        "mcts_sims": sims,
        "checkpoint": checkpoint_id,
        "league_bucket": composition.bucket,
        "seats": composition.seats,
        "bridge_metrics": bridge_delta,
        "seconds": round(time.monotonic() - started, 3),
    }
    return samples, metadata
