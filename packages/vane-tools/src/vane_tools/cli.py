"""`vane` CLI: pack / unpack / info / synth / knmi."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import click

from vane_tools import container


@click.group()
def main() -> None:
    """Vane tooling: build and inspect .vane weather datasets."""


@main.command()
@click.argument("store_dir", type=click.Path(exists=True, file_okay=False))
@click.argument("out_path", type=click.Path(dir_okay=False))
def pack(store_dir: str, out_path: str) -> None:
    """Pack a Zarr v3 directory store into a single .vane file."""
    result = container.pack(store_dir, out_path)
    click.echo(f"wrote {result} ({result.stat().st_size / 1e6:.1f} MB)")


@main.command()
@click.argument("vane_path", type=click.Path(exists=True, dir_okay=False))
@click.argument("out_dir", type=click.Path(file_okay=False))
def unpack(vane_path: str, out_dir: str) -> None:
    """Expand a .vane back into a directory-layout Zarr v3 store."""
    result = container.unpack(vane_path, out_dir)
    click.echo(f"unpacked into {result}")


@main.command()
@click.argument("vane_path", type=click.Path(exists=True, dir_okay=False))
def info(vane_path: str) -> None:
    """Show header, Vane metadata and manifest of a .vane file."""
    data = container.read_info(vane_path)
    vane_attrs = data["metadata"].get("zarr.json", {}).get("attributes", {}).get("vane")
    click.echo(json.dumps({
        "header": data["header"],
        "vane": vane_attrs,
        "manifest": data["manifest"],
    }, indent=2))


@main.command()
@click.argument("out_path", type=click.Path(dir_okay=False))
@click.option("--timesteps", "nt", default=25, show_default=True)
def synth(out_path: str, nt: int) -> None:
    """Write a synthetic NL dataset (temp, wind u/v, precip) as .vane."""
    from datetime import datetime, timezone

    from vane_tools.synth import synthetic_variables
    from vane_tools.writer import write_dataset

    variables, timesteps, bbox = synthetic_variables(nt=nt)
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store.zarr"
        write_dataset(
            store,
            source="vane_synthetic_nl",
            source_type="model",
            model_run=datetime.now(timezone.utc),
            bbox=bbox,
            timesteps=timesteps,
            variables=variables,
        )
        container.pack(store, out_path)
    size = Path(out_path).stat().st_size
    click.echo(f"wrote {out_path} ({size / 1e6:.1f} MB, {nt} timesteps)")


@main.command()
@click.argument("out_path", type=click.Path(dir_okay=False))
@click.option("--api-key", envvar="KNMI_API_KEY", required=True,
              help="KNMI Open Data API key (env: KNMI_API_KEY)")
@click.option("--max-hours", default=24, show_default=True,
              help="Forecast hours to include")
@click.option("--keep-grib", type=click.Path(file_okay=False), default=None,
              help="Directory to keep the downloaded GRIB (skips re-download)")
def knmi(out_path: str, api_key: str, max_hours: int, keep_grib: str | None) -> None:
    """Download the latest KNMI Harmonie run and convert it to .vane."""
    from vane_tools.knmi import build_harmonie_vane

    build_harmonie_vane(out_path, api_key=api_key, max_hours=max_hours,
                        keep_grib=Path(keep_grib) if keep_grib else None)


if __name__ == "__main__":
    main()
