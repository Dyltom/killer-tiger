import json, sys, base64, struct, os
import numpy as np
p = sys.argv[1]
d = json.load(open(p))
root = os.path.dirname(p)
bufs = [open(os.path.join(root, b["uri"]), "rb").read() for b in d["buffers"]]
CT = {5120:'b',5121:'B',5122:'h',5123:'H',5125:'I',5126:'f'}
NC = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
def acc(i):
    a = d["accessors"][i]
    bv = d["bufferViews"][a["bufferView"]]
    n = NC[a["type"]]; dt = np.dtype(CT[a["componentType"]])
    off = bv.get("byteOffset",0) + a.get("byteOffset",0)
    stride = bv.get("byteStride") or n*dt.itemsize
    raw = bufs[bv.get("buffer",0)]
    out = np.zeros((a["count"], n), dtype=dt)
    for k in range(a["count"]):
        out[k] = np.frombuffer(raw, dtype=dt, count=n, offset=off+k*stride)
    return out
nodes = d["nodes"]
print("skins:", len(d.get("skins",[])))
for si,sk in enumerate(d.get("skins",[])):
    ibm = acc(sk["inverseBindMatrices"]).reshape(-1,4,4)
    print(f" skin{si} joints={len(sk['joints'])} skeleton={sk.get('skeleton')} names={[nodes[j].get('name') for j in sk['joints']][:4]}...")
    # scale of each ibm
    s = np.linalg.norm(ibm[:,:3,:3], axis=(1,2))
    print("   ibm frob range", float(s.min()), float(s.max()))
for mi,m in enumerate(d["meshes"]):
    for pi,pr in enumerate(m["primitives"]):
        at = pr["attributes"]
        line = f" mesh {m.get('name')} prim{pi} attrs={sorted(at)}"
        if "JOINTS_0" in at:
            J = acc(at["JOINTS_0"]); W = acc(at["WEIGHTS_0"]).astype(np.float64)
            sums = W.sum(1)
            line += f" maxJoint={int(J.max())} wsum[{sums.min():.3f},{sums.max():.3f}] zero={(sums<1e-4).sum()}"
            line += f" sets={'JOINTS_1' in at}"
        print(line)
# which node uses which mesh/skin
for n in nodes:
    if "mesh" in n:
        print(f"  node {n.get('name')} mesh={d['meshes'][n['mesh']].get('name')} skin={n.get('skin')} T={n.get('translation')} S={n.get('scale')} R={n.get('rotation')}")
