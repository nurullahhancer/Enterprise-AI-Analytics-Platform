from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("ML_INTERNAL_API_KEY", "ci-ml-key-9F4k2L8m7Q1v6Z3p5R0x8N2w")
