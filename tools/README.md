# tools/

Circuit generation and extraction. Both scripts are Python 3 and neither one
touches the network.

## `make_toy_circuit.py`

Generates the committed toy circuit. Seeded, so the same seed always writes
byte-identical files.

```bash
python3 tools/make_toy_circuit.py --out public/data --seed 1
# or: npm run toy
```

About 400 neurons in five layered groups. It is **synthetic** — not a model of
any animal — and the cell type names echo the real auditory pathway purely for
legibility. No FlyWire root ID appears in it.

Two design decisions are load-bearing, and both are there so the app has
something it can be wrong about:

- **Connectome beats Shuffled by construction.** The Shuffled ablation is a
  degree-preserving edge swap, so it keeps every degree and the whole weight
  distribution and only changes which partner each synapse lands on. A strictly
  layered cascade loses a lot to that; a homogeneous random graph would not.
  That makes the toy circuit a sanity check on the ablation machinery rather
  than evidence about flies.
- **Local interneurons are driven by their own layer's projection neurons.**
  Their inhibition therefore lands one synaptic delay *after* the excitation it
  follows, which trims a burst down to roughly one spike per pulse. Without
  that, the synapses into the song group see bursts instead of intervals, the
  inter-pulse-interval code never arrives, and the tuning curve goes flat.

## `extract_circuit.py`

Builds a circuit from FlyWire Codex table exports **that you download
yourself**.

```bash
python3 tools/extract_circuit.py --codex ~/Downloads/flywire --out public/data
```

It writes `circuit.meta.json` and `circuit.edges.bin` into `public/data/`,
which the loader prefers over the toy circuit. Reload the app and the header
badge changes from "Toy circuit" to "Connectome".

### Getting the tables

1. Make a free account at [FlyWire Codex](https://codex.flywire.ai/).
2. Download the table exports for the release you want — at minimum a
   connections table and an annotation/classification table. A coordinates
   table is optional and enables the 3D soma cloud.
3. **Confirm the licence on the download page** (expected CC-BY 4.0) before you
   redistribute anything built from it.
4. Cite the papers. They are baked into the generated `circuit.meta.json` and
   shown in the app's About panel:
   - Dorkenwald et al. (2024) *Nature*
   - Schlegel et al. (2024) *Nature*

### What it does

1. Resolves the cell types in `circuit_config.yaml` against the annotation
   columns, and **logs every one as found, missing or ambiguous**. Codex
   annotations change between releases, so expect to edit the config; the log
   is how you find out which names need changing.
2. Expands `hops` (default 3) downstream, keeping only connections of at least
   `min_syn` (default 5) synapses.
3. Optionally takes one lateral hop.
4. Caps the circuit at `max_neurons` (default 3000) by pruning the
   weakest-connected neurons, never the seeds, and logs what went.
5. Assigns signs from transmitter labels: ACh `+1`, GABA `-1`, Glu `-1`
   (Shiu et al. convention). Anything else gets `0`, carries no weight, and is
   counted in the summary.

### Column detection

Column names are matched case- and punctuation-insensitively, with a prefix
fallback, so `pre_root_id`, `preRootId` and `pre_pt_root_id` are all the same
column. The script prints exactly which columns it chose for each file; if a
table is skipped, that line tells you why.

### A note on root IDs

FlyWire root IDs are around 7.2 × 10¹⁷, past float64's exact-integer range.
They are parsed as integers and stored as **strings** in the metadata. Anything
that routes them through a float — in Python or in JavaScript — silently
collapses thousands of distinct neurons onto the same id. The circuit still
"works", it is just quietly much smaller than it should be.

## `circuit_config.yaml`

Cell types per group, with aliases. PyYAML is used when it is installed; there
is a small built-in parser for the restricted subset this file uses, so the
script runs without it.

## MaleCNS

The adult male CNS dataset (announced September 2026) would give a male brain
from real data, which the male sing-back feature would sit on properly rather
than being female-brain-with-male-behaviour. The access route is **not
confirmed**, and it is not required for v1. If equivalent tables can be
exported, they should load through this same script with a different
`circuit_config.yaml` — the extractor makes no FAFB-specific assumptions.
