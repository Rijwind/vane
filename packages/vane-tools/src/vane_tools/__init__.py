"""vane-tools: write Vane (.vane) weather datasets.

A Vane dataset is a Zarr v3 sharded store with a Vane metadata block;
`.vane` is a single-file container over that store. See spec/ in the repo.
"""

from vane_tools.container import pack, unpack, read_info
from vane_tools.writer import VaneVariable, write_dataset

__all__ = ["VaneVariable", "write_dataset", "pack", "unpack", "read_info"]

VANE_SPEC_VERSION = 1
