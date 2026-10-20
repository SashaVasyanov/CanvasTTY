// Three-way merge of canvas documents (used by sync). Nodes and edges are merged by id:
// a change made on only one side is kept, a deletion on one side wins over "unchanged" on
// the other, and when both sides changed the same object the remote (newer) version wins.
// Without a common ancestor nothing is deleted: both sets are combined.
// NOTE: main/sync.js has a CommonJS copy of this function — keep them in sync.
export function mergeDocs(base, local, remote) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mergeList = (b, l, r) => {
    const bm = new Map((b || []).map((x) => [x.id, x]));
    const lm = new Map((l || []).map((x) => [x.id, x]));
    const rm = new Map((r || []).map((x) => [x.id, x]));
    const out = [];
    const ids = new Set([...rm.keys(), ...lm.keys()]);
    for (const id of ids) {
      const bv = bm.get(id), lv = lm.get(id), rv = rm.get(id);
      if (rv && lv) out.push(base && same(rv, bv) ? lv : rv);
      else if (rv && !lv) { if (!base || !bv || !same(rv, bv)) out.push(rv); } // deleted here and unchanged there → stays deleted
      else if (lv && !rv) { if (!base || !bv || !same(lv, bv)) out.push(lv); } // deleted there and unchanged here → delete
    }
    // keep the remote order, then local additions
    const order = new Map([...(r || []), ...(l || [])].map((x, i) => [x.id, i]));
    return out.sort((a, b) => order.get(a.id) - order.get(b.id));
  };
  return { ...local, ...remote, nodes: mergeList(base?.nodes, local?.nodes, remote?.nodes), edges: mergeList(base?.edges, local?.edges, remote?.edges) };
}
