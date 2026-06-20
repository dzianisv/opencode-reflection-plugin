import glob, os
from collections import Counter
import xml.etree.ElementTree as ET
from xml.dom import minidom

files = glob.glob(os.path.join(os.path.dirname(__file__), "..", ".dataset", "*.xml"))
bad = 0
st = Counter(); reac = Counter(); ap = 0; ex = 0
for p in files:
    try:
        minidom.parse(p)
    except Exception as e:
        bad += 1; print("MALFORMED", os.path.basename(p), str(e)[:50]); continue
    root = ET.parse(p).getroot()
    for c in root.iter("classification"):
        ex += 1
        st[c.get("stop_type")] += 1
        reac[c.get("followup_reaction")] += 1
        if c.get("antipattern") == "true": ap += 1
print(f"files={len(files)} malformed={bad} examples={ex} antipatterns={ap}")
print("stop_type:", dict(st.most_common()))
print("followup_reaction:", dict(reac.most_common()))
