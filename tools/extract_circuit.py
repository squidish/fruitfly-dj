#!/usr/bin/env python3
"""Extract a Fly DJ circuit from FlyWire Codex table exports.

THIS SCRIPT DOWNLOADS NOTHING. You export the tables yourself from FlyWire
Codex with a free account, confirm the licence (expected CC-BY 4.0), and point
this at the directory. Hard rules 1 and 2.

    python3 tools/extract_circuit.py --codex ~/Downloads/flywire --out public/data

Inputs (CSV or CSV.GZ, names are matched loosely):
    connections*.csv   pre_root_id, post_root_id, syn_count, and usually nt_type
    classification*.csv / neurons*.csv / cell_types*.csv
                       root_id plus at least one annotation column
    coordinates*.csv   root_id plus a position column          (optional)

Outputs:
    <out>/circuit.meta.json    neurons, sex, provenance, citations
    <out>/circuit.edges.bin    uint32 n, Uint32 pre[n], Uint32 post[n],
                               Uint16 syn[n], Int8 sign[n]   (little-endian)

Everything it decided is logged: which configured types resolved, which did
not, which were ambiguous, what transmitters it could not sign, and exactly
what it pruned to fit the neuron cap.

Cite: Dorkenwald et al. (2024) and Schlegel et al. (2024).
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
import struct
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

try:
    import yaml
except ImportError:  # pragma: no cover - only hit without PyYAML
    yaml = None

CITATIONS = [
    "Dorkenwald et al. (2024) Nature — FlyWire: whole-brain connectome of the adult Drosophila brain.",
    "Schlegel et al. (2024) Nature — Whole-brain annotation and multi-connectome cell typing of Drosophila.",
    "Shiu et al. (2024) Nature — leaky integrate-and-fire simulation and the transmitter sign convention.",
]

GROUP_ORDER = ["sensor", "relay1", "relay2", "song", "groom", "other"]

# Column-name candidates, matched after normalisation.
PRE_COLS = ["prerootid", "preptrootid", "preid", "pre", "source", "presynapticrootid"]
POST_COLS = ["postrootid", "postptrootid", "postid", "post", "target", "postsynapticrootid"]
SYN_COLS = ["syncount", "synapsecount", "count", "weight", "nsyn", "synapses"]
NT_COLS = ["nttype", "neurotransmitter", "nt", "topnt", "ntpredicted"]
ROOT_COLS = ["rootid", "rootid783", "id", "ptrootid"]
TYPE_COLS = ["celltype", "hemibraintype", "type", "cellclass", "class", "malecnstype", "subclass", "supertype"]
POS_COLS = ["position", "somaposition", "pos", "xyz", "somacoordinates", "coordinates"]


def norm(text: str) -> str:
    """Case- and punctuation-insensitive key for matching annotations."""
    return re.sub(r"[^a-z0-9]", "", str(text).lower())


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------------------
# config


def parse_simple_yaml(text: str):
    """Tiny YAML subset, so PyYAML stays optional.

    Handles nested mappings by indentation, `- item` lists, inline `[a, b]`
    lists and scalar ints/floats/bools. That is the whole of what
    circuit_config.yaml uses. If it ever needs more, install PyYAML.
    """
    root: dict = {}
    stack: list[tuple[int, object]] = [(-1, root)]

    def scalar(raw: str):
        raw = raw.strip()
        if raw.startswith("[") and raw.endswith("]"):
            return [scalar(p) for p in raw[1:-1].split(",") if p.strip()]
        if raw.startswith(('"', "'")) and raw[-1:] == raw[0]:
            return raw[1:-1]
        low = raw.lower()
        if low in ("true", "yes"):
            return True
        if low in ("false", "no"):
            return False
        try:
            return int(raw)
        except ValueError:
            pass
        try:
            return float(raw)
        except ValueError:
            return raw

    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        body = line.strip()
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]

        if body.startswith("- "):
            if not isinstance(parent, list):
                raise ValueError(f"list item outside a list: {body}")
            parent.append(scalar(body[2:]))
            continue

        if ":" not in body:
            raise ValueError(f"cannot parse config line: {body}")
        key, _, rest = body.partition(":")
        key = key.strip()
        rest = rest.strip()
        if not isinstance(parent, dict):
            raise ValueError(f"mapping inside a list: {body}")
        if rest == "":
            child: dict = {}
            parent[key] = child
            stack.append((indent, child))
        elif rest.startswith("[") or not rest.startswith("-"):
            parent[key] = scalar(rest)
        else:
            parent[key] = scalar(rest)

    # Second pass: a mapping whose only children were "- " items is a list.
    def fix(node):
        if isinstance(node, dict):
            return {k: fix(v) for k, v in node.items()}
        return node

    return fix(root)


def load_config(path: Path) -> dict:
    text = path.read_text()
    if yaml is not None:
        return yaml.safe_load(text)
    log("! PyYAML is not installed; using the built-in minimal parser.")
    return parse_simple_yaml(text)


# ---------------------------------------------------------------------------
# table reading


def open_table(path: Path) -> Iterator[dict]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", newline="", encoding="utf-8-sig") as fh:  # type: ignore[operator]
        reader = csv.DictReader(fh)
        for row in reader:
            yield row


def find_tables(root: Path, *patterns: str) -> list[Path]:
    hits: list[Path] = []
    for pattern in patterns:
        for p in sorted(root.rglob(f"*{pattern}*")):
            if p.is_file() and p.suffix in (".csv", ".gz") and p not in hits:
                hits.append(p)
    return hits


def pick_column(fieldnames: Iterable[str], candidates: list[str]) -> str | None:
    lookup = {norm(f): f for f in fieldnames if f}
    for cand in candidates:
        if cand in lookup:
            return lookup[cand]
    # Fall back to a prefix match, which catches versioned columns.
    for cand in candidates:
        for key, original in lookup.items():
            if key.startswith(cand):
                return original
    return None


# ---------------------------------------------------------------------------
# extraction


class Extractor:
    def __init__(self, config: dict, args: argparse.Namespace) -> None:
        self.config = config
        self.args = args
        exp = config.get("expansion", {}) or {}
        self.hops = args.hops if args.hops is not None else int(exp.get("hops", 3))
        self.min_syn = args.min_syn if args.min_syn is not None else int(exp.get("min_syn", 5))
        self.lateral = bool(exp.get("lateral", True)) if args.lateral is None else args.lateral
        self.max_neurons = args.max_neurons or int(exp.get("max_neurons", 3000))

        self.nt_sign = {norm(k): int(v) for k, v in (config.get("transmitters") or {}).items()}

        # Annotation key -> group name, built from types plus aliases.
        self.type_map: dict[str, tuple[str, str]] = {}
        for group, spec in (config.get("groups") or {}).items():
            spec = spec or {}
            aliases = spec.get("aliases") or {}
            for canonical in spec.get("types") or []:
                names = [canonical, *(aliases.get(canonical) or [])]
                for name in names:
                    key = norm(name)
                    if key in self.type_map and self.type_map[key][1] != canonical:
                        log(f"! ambiguous alias '{name}' claimed by {self.type_map[key][1]} and {canonical}")
                    self.type_map[key] = (group, canonical)

        self.annotation: dict[int, str] = {}
        self.nt: dict[int, str] = {}
        self.pos: dict[int, tuple[float, float, float]] = {}
        self.seeds: dict[str, set[int]] = defaultdict(set)
        self.resolved: dict[str, int] = defaultdict(int)
        self.edges: list[tuple[int, int, int]] = []
        self.adj_out: dict[int, list[tuple[int, int]]] = defaultdict(list)
        self.adj_in: dict[int, list[tuple[int, int]]] = defaultdict(list)
        self.unsigned_nt: dict[str, int] = defaultdict(int)

    # -- loading ----------------------------------------------------------

    def load_annotations(self, root: Path) -> None:
        tables = find_tables(root, "classification", "cell_type", "celltype", "neurons", "annotation")
        if not tables:
            raise SystemExit(
                f"No annotation table found under {root}. Export classification.csv "
                "(or neurons.csv) from FlyWire Codex first."
            )
        for path in tables:
            rows = open_table(path)
            try:
                first = next(rows)
            except StopIteration:
                continue
            fields = list(first.keys())
            root_col = pick_column(fields, ROOT_COLS)
            if not root_col:
                log(f"  skipping {path.name}: no root id column")
                continue
            type_cols = [c for c in (pick_column(fields, [t]) for t in TYPE_COLS) if c]
            nt_col = pick_column(fields, NT_COLS)
            pos_col = pick_column(fields, POS_COLS)
            log(f"  {path.name}: root='{root_col}' types={type_cols or 'none'} nt='{nt_col}' pos='{pos_col}'")

            count = 0
            for row in self._chain(first, rows):
                rid = self._int(row.get(root_col))
                if rid is None:
                    continue
                count += 1
                for col in type_cols:
                    value = (row.get(col) or "").strip()
                    if value and rid not in self.annotation:
                        self.annotation[rid] = value
                    if value and norm(value) in self.type_map:
                        # A recognised type always wins over a generic class.
                        self.annotation[rid] = value
                        break
                if nt_col and rid not in self.nt:
                    value = (row.get(nt_col) or "").strip()
                    if value:
                        self.nt[rid] = value
                if pos_col and rid not in self.pos:
                    parsed = self._parse_pos(row.get(pos_col))
                    if parsed:
                        self.pos[rid] = parsed
            log(f"    read {count} rows")

    def load_connections(self, root: Path) -> None:
        tables = find_tables(root, "connection", "synapse", "edges")
        if not tables:
            raise SystemExit(f"No connections table found under {root}.")
        for path in tables:
            rows = open_table(path)
            try:
                first = next(rows)
            except StopIteration:
                continue
            fields = list(first.keys())
            pre_col = pick_column(fields, PRE_COLS)
            post_col = pick_column(fields, POST_COLS)
            syn_col = pick_column(fields, SYN_COLS)
            nt_col = pick_column(fields, NT_COLS)
            if not (pre_col and post_col and syn_col):
                log(f"  skipping {path.name}: needs pre/post/syn columns, found {fields[:6]}")
                continue
            log(f"  {path.name}: pre='{pre_col}' post='{post_col}' syn='{syn_col}' nt='{nt_col}'")

            kept = 0
            dropped = 0
            for row in self._chain(first, rows):
                pre = self._int(row.get(pre_col))
                post = self._int(row.get(post_col))
                syn = self._int(row.get(syn_col))
                if pre is None or post is None or syn is None or pre == post:
                    continue
                if syn < self.min_syn:
                    dropped += 1
                    continue
                if nt_col and pre not in self.nt:
                    value = (row.get(nt_col) or "").strip()
                    if value:
                        self.nt[pre] = value
                self.edges.append((pre, post, syn))
                self.adj_out[pre].append((post, syn))
                self.adj_in[post].append((pre, syn))
                kept += 1
            log(f"    kept {kept} connections, dropped {dropped} below min_syn={self.min_syn}")

    @staticmethod
    def _chain(first: dict, rest: Iterator[dict]) -> Iterator[dict]:
        yield first
        yield from rest

    @staticmethod
    def _int(value) -> int | None:
        """Parse an id or count.

        Never route a root id through float(). FlyWire root ids are around
        7.2e17, well past float64's 2**53 exact-integer limit, so int(float(x))
        quietly rounds thousands of distinct neurons onto the same id and the
        circuit silently collapses.
        """
        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        try:
            return int(text)
        except ValueError:
            pass
        # Only decimals like "12.0" reach here; ids are never written that way.
        try:
            as_float = float(text)
        except ValueError:
            return None
        if as_float != int(as_float):
            return None
        return int(as_float)

    @staticmethod
    def _parse_pos(value) -> tuple[float, float, float] | None:
        if not value:
            return None
        nums = re.findall(r"-?\d+(?:\.\d+)?", str(value))
        if len(nums) < 3:
            return None
        return (float(nums[0]), float(nums[1]), float(nums[2]))

    # -- resolution -------------------------------------------------------

    def resolve_seeds(self) -> None:
        log("\nResolving configured cell types:")
        for rid, annotation in self.annotation.items():
            hit = self.type_map.get(norm(annotation))
            if hit:
                group, canonical = hit
                self.seeds[group].add(rid)
                self.resolved[canonical] += 1

        missing: list[str] = []
        for group, spec in (self.config.get("groups") or {}).items():
            for canonical in (spec or {}).get("types") or []:
                n = self.resolved.get(canonical, 0)
                if n > 0:
                    log(f"  found    {group:8s} {canonical:12s} {n:5d} neurons")
                else:
                    missing.append(f"{group}/{canonical}")
                    log(f"  MISSING  {group:8s} {canonical:12s}     0  — check the name against your export")
        if missing:
            log(f"\n! {len(missing)} configured type(s) did not resolve: {', '.join(missing)}")
            log("  Edit tools/circuit_config.yaml. Codex annotations change between releases.")

        total = sum(len(v) for v in self.seeds.values())
        if total == 0:
            raise SystemExit(
                "No configured cell type resolved to a single neuron. The annotation column "
                "probably differs from what this script looked for; the log above lists the "
                "columns it used."
            )
        log(f"\nSeed neurons: {total}")

    def expand(self) -> dict[int, str]:
        """N hops downstream from the seeds, plus optionally one lateral hop."""
        assigned: dict[int, str] = {}
        for group, members in self.seeds.items():
            for rid in members:
                assigned[rid] = group

        frontier = set(assigned)
        for hop in range(self.hops):
            nxt: set[int] = set()
            for rid in frontier:
                for post, _syn in self.adj_out.get(rid, ()):
                    if post not in assigned:
                        assigned[post] = "other"
                        nxt.add(post)
            log(f"  hop {hop + 1}: +{len(nxt)} neurons (total {len(assigned)})")
            frontier = nxt
            if not frontier:
                break

        if self.lateral:
            lateral_added = 0
            for rid in list(assigned):
                for pre, _syn in self.adj_in.get(rid, ()):
                    if pre not in assigned:
                        assigned[pre] = "other"
                        lateral_added += 1
            log(f"  lateral hop: +{lateral_added} neurons (total {len(assigned)})")

        return assigned

    def prune(self, assigned: dict[int, str]) -> dict[int, str]:
        """Cap the circuit, dropping the weakest-connected neurons first."""
        if len(assigned) <= self.max_neurons:
            return assigned

        protected = {rid for members in self.seeds.values() for rid in members}
        strength: dict[int, int] = defaultdict(int)
        for pre, post, syn in self.edges:
            if pre in assigned and post in assigned:
                strength[pre] += syn
                strength[post] += syn

        candidates = sorted(
            (rid for rid in assigned if rid not in protected),
            key=lambda r: strength.get(r, 0),
        )
        drop_count = len(assigned) - self.max_neurons
        if drop_count > len(candidates):
            log(
                f"! Cap of {self.max_neurons} is below the {len(protected)} seed neurons; "
                "keeping all seeds and pruning everything else."
            )
        dropped = set(candidates[:drop_count])
        weakest = strength.get(candidates[0], 0) if candidates else 0
        strongest_dropped = strength.get(candidates[min(drop_count, len(candidates)) - 1], 0) if dropped else 0
        log(
            f"\nPruning to the {self.max_neurons}-neuron cap: dropped {len(dropped)} neurons "
            f"with total synapse mass from {weakest} to {strongest_dropped}. "
            f"All {len(protected)} seed neurons kept."
        )
        return {rid: group for rid, group in assigned.items() if rid not in dropped}

    def sign_for(self, rid: int) -> int:
        nt = self.nt.get(rid, "")
        key = norm(nt)
        if key in self.nt_sign:
            return self.nt_sign[key]
        self.unsigned_nt[nt or "(none)"] += 1
        return 0

    # -- output -----------------------------------------------------------

    def build(self, assigned: dict[int, str]) -> tuple[dict, list[tuple[int, int, int, int]]]:
        order = sorted(assigned, key=lambda r: (GROUP_ORDER.index(assigned[r]), self.annotation.get(r, ""), r))
        index = {rid: i for i, rid in enumerate(order)}

        neurons = []
        for rid in order:
            entry = {
                "id": index[rid],
                "root_id": str(rid),
                "type": self.annotation.get(rid) or "unclassified",
                "group": assigned[rid],
                "nt": self.nt.get(rid, "unknown"),
            }
            if rid in self.pos:
                entry["pos"] = list(self.pos[rid])
            neurons.append(entry)

        out_edges: list[tuple[int, int, int, int]] = []
        for pre, post, syn in self.edges:
            if pre not in index or post not in index:
                continue
            sign = self.sign_for(pre)
            if sign == 0:
                continue
            out_edges.append((index[pre], index[post], min(syn, 65535), sign))
        out_edges.sort(key=lambda e: (e[0], e[1]))

        counts: dict[str, int] = defaultdict(int)
        for rid in order:
            counts[assigned[rid]] += 1

        meta = {
            "format": 1,
            "name": self.args.name,
            "sex": self.args.sex,
            "sexSelectable": False,
            "source": f"FlyWire Codex export at {self.args.codex}",
            "provenance": (
                f"Extracted by tools/extract_circuit.py on "
                f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')} from user-supplied FlyWire Codex "
                f"tables. {self.hops} hops downstream of the configured seed types, min_syn="
                f"{self.min_syn}, lateral={'on' if self.lateral else 'off'}, capped at "
                f"{self.max_neurons} neurons. Signs from transmitter labels using the Shiu et al. "
                "convention (ACh +1, GABA -1, Glu -1); other transmitters carry no weight. "
                "Confirm the licence of your export (expected CC-BY 4.0) before redistributing."
            ),
            "citations": CITATIONS,
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "notes": [
                f"Group sizes: " + ", ".join(f"{g}={counts.get(g, 0)}" for g in GROUP_ORDER),
                f"Neurons with soma positions: {sum(1 for r in order if r in self.pos)} of {len(order)}",
            ],
            "neurons": neurons,
        }
        return meta, out_edges


def write_edges(path: Path, edges: list[tuple[int, int, int, int]]) -> None:
    n = len(edges)
    with path.open("wb") as fh:
        fh.write(struct.pack("<I", n))
        fh.write(struct.pack(f"<{n}I", *[e[0] for e in edges]))
        fh.write(struct.pack(f"<{n}I", *[e[1] for e in edges]))
        fh.write(struct.pack(f"<{n}H", *[e[2] for e in edges]))
        fh.write(struct.pack(f"<{n}b", *[e[3] for e in edges]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--codex", required=True, help="directory holding your FlyWire Codex CSV exports")
    ap.add_argument("--config", default="tools/circuit_config.yaml")
    ap.add_argument("--out", default="public/data")
    ap.add_argument("--name", default="flywire-fafb")
    ap.add_argument("--sex", default="female", choices=["female", "male", "unknown"])
    ap.add_argument("--hops", type=int, default=None)
    ap.add_argument("--min-syn", dest="min_syn", type=int, default=None)
    ap.add_argument("--max-neurons", dest="max_neurons", type=int, default=None)
    ap.add_argument("--lateral", dest="lateral", action="store_true", default=None)
    ap.add_argument("--no-lateral", dest="lateral", action="store_false")
    args = ap.parse_args()

    codex = Path(args.codex).expanduser()
    if not codex.is_dir():
        raise SystemExit(f"{codex} is not a directory. Export the Codex tables there first.")

    config = load_config(Path(args.config))
    ex = Extractor(config, args)

    log("Reading annotations:")
    ex.load_annotations(codex)
    log("\nReading connections:")
    ex.load_connections(codex)

    ex.resolve_seeds()
    log("\nExpanding:")
    assigned = ex.expand()
    assigned = ex.prune(assigned)

    meta, edges = ex.build(assigned)

    if ex.unsigned_nt:
        log("\nTransmitters with no sign (these edges carry no weight):")
        for nt, count in sorted(ex.unsigned_nt.items(), key=lambda kv: -kv[1]):
            log(f"  {nt or '(blank)':24s} {count} edges")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "circuit.meta.json").write_text(json.dumps(meta, indent=1) + "\n")
    write_edges(out / "circuit.edges.bin", edges)

    log("")
    print(f"neurons: {len(meta['neurons'])}")
    print(f"edges:   {len(edges)}")
    print(meta["notes"][0])
    print(f"wrote:   {out / 'circuit.meta.json'}")
    print(f"wrote:   {out / 'circuit.edges.bin'}")
    print("\nReload the app: the header badge should now read 'Connectome'.")


if __name__ == "__main__":
    main()
