/**
 * `.vane` container reader: a zarrita-compatible store over a single file.
 *
 * A .vane file is a Zarr v3 sharded store serialized into one file (see
 * spec/vane-container.md). This module parses the fixed header + inline
 * metadata + manifest, and translates Zarr store keys into byte ranges so
 * zarrita's own machinery (sharding codec, zstd, crc32c) does all the array
 * work. The store only ever issues ranged reads — one small prefix fetch up
 * front, then one range per shard-index / inner-chunk read.
 */

const MAGIC = 0x56414e45; // "VANE"
const SPEC_VERSION = 1;
const HEADER_LEN = 48;
/** First fetch grabs this much; header + metadata + manifest usually fit. */
const PREFIX_LEN = 16384;

/** Reads `length` bytes at `offset` from the underlying file. */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

export interface VaneHeader {
  specVersion: number;
  metadataOffset: number;
  metadataLength: number;
  manifestOffset: number;
  manifestLength: number;
  dataOffset: number;
}

/** Per-variable entry in the Vane metadata convention. */
export interface VaneVariableMeta {
  unit: string;
  scale: number;
  offset: number;
  nodata: number;
  vector_group?: string;
  vector_component?: "u" | "v";
  default_colormap?: string;
  default_clim?: [number, number];
}

/** The `vane` block in the root group attributes (spec/vane-metadata.md). */
export interface VaneMetadata {
  vane_spec: number;
  source: string;
  source_type: "model" | "radar";
  model_run: string;
  created_at: string;
  /** [west, south, east, north] degrees */
  bbox: [number, number, number, number];
  crs: string;
  update_interval_seconds: number;
  timesteps: string[];
  levels: number[] | null;
  variables: Record<string, VaneVariableMeta>;
}

type RangeQuery = { offset: number; length: number } | { suffixLength: number };
type AbsolutePath = `/${string}`;

/**
 * zarrita `AsyncReadable` (with `getRange`) over a `.vane` file.
 * Construct with {@link VaneStore.open}.
 */
export class VaneStore {
  private constructor(
    private readonly reader: RangeReader,
    readonly header: VaneHeader,
    /** store key (no leading slash) -> parsed JSON document */
    readonly metadataDocs: Record<string, unknown>,
    /** store key -> [offset relative to data section, length] */
    readonly manifest: Record<string, [number, number]>,
  ) {}

  static async open(reader: RangeReader): Promise<VaneStore> {
    let prefix = await reader(0, PREFIX_LEN);
    if (prefix.length < HEADER_LEN) throw new Error("not a .vane file: too short");
    const header = parseHeader(prefix);
    if (prefix.length < header.dataOffset) {
      // Metadata + manifest extend past the prefix; fetch the remainder once.
      const rest = await reader(prefix.length, header.dataOffset - prefix.length);
      const all = new Uint8Array(header.dataOffset);
      all.set(prefix);
      all.set(rest, prefix.length);
      prefix = all;
    }
    const decoder = new TextDecoder();
    const metadataDocs = JSON.parse(
      decoder.decode(prefix.subarray(header.metadataOffset, header.metadataOffset + header.metadataLength)),
    );
    const manifest = JSON.parse(
      decoder.decode(prefix.subarray(header.manifestOffset, header.manifestOffset + header.manifestLength)),
    );
    return new VaneStore(reader, header, metadataDocs, manifest);
  }

  /** The Vane metadata block from the root group attributes. */
  get vane(): VaneMetadata {
    const root = this.metadataDocs["zarr.json"] as
      | { attributes?: { vane?: VaneMetadata } }
      | undefined;
    const meta = root?.attributes?.vane;
    if (!meta) throw new Error("root zarr.json has no vane attributes block");
    return meta;
  }

  async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
    const k = key.slice(1);
    if (k in this.metadataDocs) {
      return new TextEncoder().encode(JSON.stringify(this.metadataDocs[k]));
    }
    const entry = this.manifest[k];
    if (!entry) return undefined;
    return this.reader(this.header.dataOffset + entry[0], entry[1]);
  }

  async getRange(key: AbsolutePath, range: RangeQuery): Promise<Uint8Array | undefined> {
    const k = key.slice(1);
    const entry = this.manifest[k];
    if (!entry) {
      // Ranged reads of inline metadata are unexpected but easy to serve.
      const doc = await this.get(key);
      if (!doc) return undefined;
      return "suffixLength" in range
        ? doc.subarray(doc.length - range.suffixLength)
        : doc.subarray(range.offset, range.offset + range.length);
    }
    const [base, total] = entry;
    let offset: number;
    let length: number;
    if ("suffixLength" in range) {
      length = Math.min(range.suffixLength, total);
      offset = total - length;
    } else {
      offset = range.offset;
      length = Math.min(range.length, total - offset);
    }
    if (offset < 0 || offset > total) return undefined;
    return this.reader(this.header.dataOffset + base + offset, length);
  }
}

function parseHeader(bytes: Uint8Array): VaneHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== MAGIC) throw new Error("not a .vane file (bad magic)");
  const specVersion = view.getUint32(4, true);
  if (specVersion !== SPEC_VERSION) {
    throw new Error(`unsupported .vane spec version ${specVersion}`);
  }
  const u64 = (off: number) => {
    const v = view.getBigUint64(off, true);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("offset exceeds 2^53");
    return Number(v);
  };
  return {
    specVersion,
    metadataOffset: u64(8),
    metadataLength: u64(16),
    manifestOffset: u64(24),
    manifestLength: u64(32),
    dataOffset: u64(40),
  };
}

/** RangeReader over HTTP(S) using `Range` headers.
 *
 * Defensive against Safari/WebKit: once the browser cache holds a full 200
 * response (e.g. a CDN answering a cold-cache range request with the whole
 * file), WebKit serves ALL subsequent ranged fetches from that cache entry
 * as status-200 full bodies — and under concurrent requests those bodies
 * can arrive truncated. A truncated body sliced at `offset` yields corrupt
 * chunks, so 200-responses shorter than `offset + length` are retried with
 * `cache: "no-store"` to force a real network fetch.
 */
export function httpReader(url: string, init?: RequestInit): RangeReader {
  const fetchRange = async (
    offset: number,
    length: number,
    cache: RequestCache,
  ): Promise<{ status: number; bytes: Uint8Array }> => {
    const response = await fetch(url, {
      ...init,
      cache,
      headers: { ...init?.headers, Range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (!(response.status === 206 || response.status === 200)) {
      throw new Error(`range request failed: HTTP ${response.status} for ${url}`);
    }
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  };

  return async (offset, length) => {
    const { status, bytes } = await fetchRange(offset, length, "no-store");
    if (status === 200) {
      // Server ignored the Range header; slice locally.
      return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    }
    return bytes;
  };
}

/** RangeReader over an in-memory/local Blob or File (tests, drag-and-drop). */
export function blobReader(blob: Blob): RangeReader {
  return async (offset, length) =>
    new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}
