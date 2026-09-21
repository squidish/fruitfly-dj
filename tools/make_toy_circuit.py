#!/usr/bin/env python3
"""Generate the committed toy circuit.

Seeded and deterministic: the same --seed always writes byte-identical files.
Roughly 400 neurons in five layered groups with feed-forward inhibition.

The layering is deliberate. The Shuffled ablation is a degree-preserving edge
swap, so it keeps every neuron's in- and out-degree and the whole weight
distribution, and only scrambles WHICH partner each synapse lands on. A strictly
layered cascade therefore loses far more to shuffling than a homogeneous random
graph would, which is how this circuit gives the ablation machinery a sanity
check it can actually fail.

Usage:
    python3 tools/make_toy_circuit.py --out public/data --seed 1
"""

from __future__ import annotations

import argparse
import json
import random
import struct
from datetime import datetime, timezone
from pathlib import Path

# name, group, neurotransmitter, count
POPULATIONS = [
    # Johnston's organ. A/B are the vibration-sensitive classes, C/E the
    # deflection-sensitive ones.
    ("JO-A", "sensor", "ACh", 16),
    ("JO-B", "sensor", "ACh", 24),
    ("JO-C", "sensor", "ACh", 12),
    ("JO-E", "sensor", "ACh", 12),
    # First relay, AMMC.
    ("AMMC-B1", "relay1", "ACh", 40),
    ("aPN1", "relay1", "ACh", 30),
    ("AMMC-LN", "relay1", "GABA", 20),
    # Second relay, WED / VLP.
    ("WED-VLP", "relay2", "ACh", 35),
    ("vPN1", "relay2", "ACh", 25),
    ("WED-LN", "relay2", "GABA", 20),
    # Song-responsive.
    ("pC2l", "song", "ACh", 25),
    ("pC2m", "song", "ACh", 20),
    ("vpoEN", "song", "ACh", 15),
    ("vpoIN", "song", "GABA", 10),
    # Antennal grooming.
    ("aBN1", "groom", "ACh", 25),
    ("aBN2", "groom", "ACh", 20),
    ("aBN-LN", "groom", "GABA", 15),
    # Descending / unclassified.
    ("DN-misc", "other", "ACh", 20),
    ("Glu-misc", "other", "Glu", 16),
]

# Shiu et al. (Nature, 2024) sign convention.
SIGN = {"ACh": 1, "GABA": -1, "Glu": -1}

# Layer depth, for soma positions in the 3D view.
LAYER_Y = {"sensor": 0.0, "relay1": 1.0, "relay2": 2.0, "song": 3.0, "groom": 2.6, "other": 3.4}

# (source type, target type, fan-in per target, synapse count range)
PROJECTIONS = [
    # Vibration sensors drive the first relay hard and specifically.
    ("JO-A", "AMMC-B1", 6, (14, 30)),
    ("JO-B", "AMMC-B1", 8, (14, 30)),
    ("JO-A", "aPN1", 5, (10, 24)),
    ("JO-B", "aPN1", 7, (10, 24)),
    # A weak direct tap, so the local interneuron has a baseline of its own.
    ("JO-B", "AMMC-LN", 4, (8, 16)),
    # Deflection sensors carry sub-bass, and are what eventually says "enough".
    ("JO-C", "aBN1", 5, (10, 22)),
    ("JO-E", "aBN1", 5, (10, 22)),
    ("JO-C", "aBN2", 4, (8, 18)),
    # Relay 1's local inhibitory loop. The LN is driven by its OWN layer's
    # projection neurons, so its inhibition lands one synaptic delay after the
    # excitation it follows. That is what truncates a burst into a single spike
    # per pulse, and a single spike per pulse is what lets the interval between
    # pulses reach the synapses downstream at all.
    ("AMMC-B1", "AMMC-LN", 8, (14, 28)),
    ("aPN1", "AMMC-LN", 6, (12, 24)),
    ("AMMC-LN", "AMMC-B1", 6, (12, 26)),
    ("AMMC-LN", "aPN1", 5, (12, 26)),
    # Relay 1 -> relay 2, with feed-forward inhibition alongside.
    ("AMMC-B1", "WED-VLP", 8, (12, 26)),
    ("AMMC-B1", "vPN1", 6, (10, 22)),
    ("aPN1", "WED-VLP", 6, (10, 22)),
    ("aPN1", "vPN1", 6, (10, 22)),
    ("AMMC-LN", "WED-VLP", 5, (10, 20)),
    ("AMMC-LN", "vPN1", 4, (10, 20)),
    # Relay 2's local inhibitory loop, same shape as relay 1's.
    ("WED-VLP", "WED-LN", 8, (14, 28)),
    ("vPN1", "WED-LN", 6, (12, 24)),
    ("WED-LN", "WED-VLP", 6, (12, 26)),
    ("WED-LN", "vPN1", 5, (12, 26)),
    # Relay 2 -> song. This is the only layer whose input synapses carry STP.
    ("WED-VLP", "pC2l", 9, (14, 30)),
    ("WED-VLP", "pC2m", 7, (12, 26)),
    ("vPN1", "pC2l", 7, (12, 26)),
    ("vPN1", "vpoEN", 6, (12, 26)),
    ("WED-LN", "pC2l", 6, (12, 24)),
    ("WED-LN", "pC2m", 5, (12, 24)),
    # Light recurrence inside the song group, with its own local inhibition.
    ("pC2l", "pC2m", 4, (8, 18)),
    ("pC2m", "pC2l", 3, (8, 18)),
    ("pC2l", "vpoEN", 3, (8, 18)),
    ("pC2l", "vpoIN", 6, (12, 24)),
    ("pC2m", "vpoIN", 5, (12, 24)),
    ("vpoIN", "pC2l", 6, (12, 26)),
    ("vpoIN", "pC2m", 5, (12, 26)),
    # Grooming: driven by sustained relay activity, self-limited by its own LN.
    ("AMMC-LN", "aBN1", 3, (6, 14)),
    ("WED-LN", "aBN2", 3, (6, 14)),
    ("aBN1", "aBN2", 4, (8, 18)),
    ("aBN1", "aBN-LN", 4, (8, 16)),
    ("aBN-LN", "aBN1", 4, (8, 16)),
    # Outputs.
    ("pC2l", "DN-misc", 4, (8, 18)),
    ("vpoEN", "DN-misc", 3, (8, 18)),
    ("aBN2", "DN-misc", 3, (8, 18)),
    ("Glu-misc", "pC2m", 2, (6, 12)),
    ("Glu-misc", "aBN1", 2, (6, 12)),
]


def build(seed: int, sex: str):
    rng = random.Random(seed)

    neurons = []
    by_type: dict[str, list[int]] = {}
    for tname, group, nt, count in POPULATIONS:
        members = []
        for _ in range(count):
            idx = len(neurons)
            members.append(idx)
            # Positions are cosmetic: a tidy layered cloud for the 3D view.
            angle = rng.uniform(0, 2 * 3.141592653589793)
            radius = rng.uniform(0.0, 1.0) ** 0.5
            neurons.append(
                {
                    "id": idx,
                    "type": tname,
                    "group": group,
                    "nt": nt,
                    "pos": [
                        round(radius * 40000 * (1 if rng.random() < 0.5 else -1) * abs(rng.gauss(0.6, 0.25)), 1),
                        round(LAYER_Y[group] * 28000 + rng.gauss(0, 3500), 1),
                        round(radius * 30000 * (1 if angle > 3.14 else -1), 1),
                    ],
                }
            )
        by_type[tname] = members

    pre_list: list[int] = []
    post_list: list[int] = []
    syn_list: list[int] = []
    sign_list: list[int] = []
    seen: set[tuple[int, int]] = set()
    nt_of = {n["id"]: n["nt"] for n in neurons}

    for src_type, dst_type, fan_in, syn_range in PROJECTIONS:
        sources = by_type[src_type]
        targets = by_type[dst_type]
        if not sources or not targets:
            continue
        for tgt in targets:
            k = min(len(sources), max(1, fan_in))
            for src in rng.sample(sources, k):
                if src == tgt or (src, tgt) in seen:
                    continue
                seen.add((src, tgt))
                pre_list.append(src)
                post_list.append(tgt)
                syn_list.append(rng.randint(*syn_range))
                sign_list.append(SIGN[nt_of[src]])

    # Sort by (pre, post) so the file is a canonical function of the seed.
    order = sorted(range(len(pre_list)), key=lambda i: (pre_list[i], post_list[i]))
    pre_list = [pre_list[i] for i in order]
    post_list = [post_list[i] for i in order]
    syn_list = [syn_list[i] for i in order]
    sign_list = [sign_list[i] for i in order]

    meta = {
        "format": 1,
        "name": "toy",
        "sex": sex,
        "sexSelectable": True,
        "source": "tools/make_toy_circuit.py",
        "provenance": (
            "Synthetic. Layered groups with feed-forward inhibition, generated so that the "
            "Connectome mode beats Shuffled by construction. It is a sanity check on the "
            "ablation machinery, not a model of any real animal."
        ),
        "citations": [
            "Shiu et al. (2024) Nature — sign convention (ACh +1, GABA -1, Glu -1).",
        ],
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "seed": seed,
        "notes": [
            "Cell type names echo the real auditory pathway for legibility only.",
            "No FlyWire root IDs: nothing here came from a connectome.",
        ],
        "neurons": neurons,
    }
    return meta, (pre_list, post_list, syn_list, sign_list)


def write_edges(path: Path, edges) -> None:
    pre, post, syn, sign = edges
    n = len(pre)
    with path.open("wb") as f:
        f.write(struct.pack("<I", n))
        f.write(struct.pack(f"<{n}I", *pre))
        f.write(struct.pack(f"<{n}I", *post))
        f.write(struct.pack(f"<{n}H", *syn))
        f.write(struct.pack(f"<{n}b", *sign))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="public/data", help="output directory")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--sex", default="female", choices=["female", "male", "unknown"])
    ap.add_argument("--prefix", default="toy_circuit")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta, edges = build(args.seed, args.sex)

    (out / f"{args.prefix}.meta.json").write_text(json.dumps(meta, indent=1, sort_keys=False) + "\n")
    write_edges(out / f"{args.prefix}.edges.bin", edges)

    groups: dict[str, int] = {}
    for nrn in meta["neurons"]:
        groups[nrn["group"]] = groups.get(nrn["group"], 0) + 1
    inhib = sum(1 for s in edges[3] if s < 0)
    print(f"neurons: {len(meta['neurons'])}  " + "  ".join(f"{g}={c}" for g, c in groups.items()))
    print(f"edges:   {len(edges[0])} ({inhib} inhibitory, {len(edges[0]) - inhib} excitatory)")
    print(f"wrote:   {out / (args.prefix + '.meta.json')}")
    print(f"wrote:   {out / (args.prefix + '.edges.bin')}")


if __name__ == "__main__":
    main()
