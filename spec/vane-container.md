# The `.vane` container — spec draft (v1, unfrozen)

Status: **draft**. Nothing here is frozen until the end-to-end browser read
path (zarrita + sharding codec over a ranged single-file store) is validated.

## Design

A `.vane` file is a **Zarr v3 store serialized into a single file**. All the
array logic — chunk grid, sharding, codecs, dtypes, fill values — is plain
Zarr v3; the container adds only:

1. a fixed header (magic + version + section offsets),
2. an inline copy of every JSON metadata document in the store,
3. a manifest mapping every remaining store key (shard objects) to a byte
   range in the data section,
4. the shard bytes, concatenated verbatim.

A `.vane` unpacks losslessly back into a directory-layout Zarr store.

## Layout

All integers little-endian.

```
offset  size  field
0       4     magic: ASCII "VANE" (0x56 0x41 0x4E 0x45)
4       4     spec_version: uint32 = 1
8       8     metadata_offset: uint64
16      8     metadata_length: uint64
24      8     manifest_offset: uint64
32      8     manifest_length: uint64
40      8     data_offset: uint64
48      —     (sections follow; writers SHOULD place metadata and manifest
              immediately after the header so a single small prefix fetch
              captures everything a reader needs)
```

### Metadata section

UTF-8 JSON object mapping **store key → parsed JSON document** for every
`*.json` key in the store (the root `zarr.json` and each array's
`<name>/zarr.json`):

```json
{
  "zarr.json": { "zarr_format": 3, "node_type": "group", "attributes": { "vane": { … } } },
  "temperature/zarr.json": { "zarr_format": 3, "node_type": "array", … }
}
```

### Manifest section

UTF-8 JSON object mapping **store key → `[offset, length]`**, offset relative
to `data_offset`:

```json
{
  "temperature/c/0/0/0": [0, 1834227],
  "wind_u/c/0/0/0": [1834227, 2101833]
}
```

Keys are the Zarr v3 chunk keys of the shard objects (with the default
`c/`-prefixed chunk_key_encoding). With the recommended shard layout
(all chunks of one variable in one shard) there is roughly one manifest entry
per variable.

### Data section

The shard objects' bytes, concatenated in manifest order, unmodified. The
Zarr sharding codec's own index footer inside each shard handles inner-chunk
offsets — the container does not duplicate that.

## Reader algorithm

1. Fetch bytes `0..16384` (one request). Parse header. If
   `data_offset > 16384`, fetch the remainder of the metadata + manifest
   sections.
2. Serve the Zarr store interface from memory for `*.json` keys, and for
   chunk keys translate `key + (inner range)` → one HTTP range request at
   `data_offset + manifest[key][0] + range.offset`.
3. Hand that store to any Zarr v3 implementation (zarrita.js in the
   reference reader). Suffix-range reads inside a shard (the sharding index
   footer) translate to absolute ranges since the manifest knows each
   shard's total length.

## Vane metadata convention

Lives under `attributes.vane` in the root group document. See
[vane-metadata.md](vane-metadata.md).

## Rules

- Files are **immutable**: publish under a unique name
  (`knmi_harmonie_nl_20260624T0600Z.vane`), point a small mutable
  `*_latest.json` at the newest file. Never overwrite a published `.vane` —
  CDN range caching makes in-place replacement corrupting.
- Writers MUST NOT compress the metadata/manifest sections in v1 (they are
  small; simplicity wins).
- Readers MUST ignore trailing bytes after the data section (room for future
  appended sections).
