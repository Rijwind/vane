"""`vane-pipeline` CLI.

Storage is configured via env (see storage.py):

    VANE_STORAGE=local:./vane-data           # dev
    VANE_STORAGE=s3:vane-data                # production bucket
    VANE_S3_ENDPOINT=https://…               # UpCloud / R2 / MinIO endpoint
    AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY

    KNMI_API_KEY=…                           # KNMI Open Data API key
"""

from __future__ import annotations

import os
from pathlib import Path

import click

from vane_pipeline.jobs import run_harmonie, run_icon_eu, run_radar
from vane_pipeline.storage import storage_from_env


def _api_key() -> str:
    key = os.environ.get("KNMI_API_KEY")
    if not key:
        raise click.UsageError("KNMI_API_KEY is not set")
    return key


@click.group()
def main() -> None:
    """Vane data pipeline: fetch, convert, publish."""


@main.command()
@click.option("--max-hours", default=48, show_default=True)
@click.option("--keep-days", default=7, show_default=True)
def harmonie(max_hours: int, keep_days: int) -> None:
    """Publish the latest KNMI Harmonie run (no-op if already current)."""
    run_harmonie(
        storage_from_env(), api_key=_api_key(), max_hours=max_hours, keep_days=keep_days
    )


@main.command()
@click.option("--keep-days", default=7, show_default=True)
def radar(keep_days: int) -> None:
    """Publish the latest KNMI radar nowcast (no-op if already current)."""
    run_radar(storage_from_env(), api_key=_api_key(), keep_days=keep_days)


@main.command("icon-eu")
@click.option("--max-hours", default=48, show_default=True)
@click.option("--keep-days", default=7, show_default=True)
def icon_eu(max_hours: int, keep_days: int) -> None:
    """Publish the latest DWD ICON-EU run (no-op if already current)."""
    run_icon_eu(storage_from_env(), max_hours=max_hours, keep_days=keep_days)


@main.command()
@click.option("--harmonie-minutes", default=10, show_default=True,
              help="How often to check for a new Harmonie run")
@click.option("--radar-minutes", default=3, show_default=True,
              help="How often to check for a new radar nowcast")
@click.option("--icon-minutes", default=20, show_default=True,
              help="How often to check for a new ICON-EU run")
@click.option("--max-hours", default=48, show_default=True)
@click.option("--keep-days", default=7, show_default=True)
def daemon(harmonie_minutes: int, radar_minutes: int, icon_minutes: int,
           max_hours: int, keep_days: int) -> None:
    """Run forever: poll for new runs and publish them.

    Polling is cheap (one list call + pointer read when nothing changed),
    so short intervals mostly bound publish latency, not cost.
    """
    from apscheduler.schedulers.blocking import BlockingScheduler

    storage = storage_from_env()
    api_key = _api_key()

    # Liveness heartbeat: a file the Docker HEALTHCHECK checks the age of.
    # Touched by a 60s scheduler job, so it goes stale if the process dies
    # OR the scheduler wedges — an HTTP "I exist" endpoint can't see the
    # second failure mode.
    heartbeat_path = Path(os.environ.get("VANE_HEARTBEAT", "/tmp/vane-heartbeat"))

    def beat() -> None:
        try:
            heartbeat_path.touch()
        except OSError as e:
            print(f"heartbeat: ERROR {e}")

    def guarded(name: str, job) -> None:
        try:
            job()
        except Exception as e:  # keep the scheduler alive on transient failures
            print(f"{name}: ERROR {e}")
        beat()

    def harmonie_tick() -> None:
        guarded("harmonie", lambda: run_harmonie(
            storage, api_key=api_key, max_hours=max_hours, keep_days=keep_days))

    def radar_tick() -> None:
        guarded("radar", lambda: run_radar(storage, api_key=api_key, keep_days=keep_days))

    def icon_tick() -> None:
        guarded("icon-eu", lambda: run_icon_eu(
            storage, max_hours=max_hours, keep_days=keep_days))

    scheduler = BlockingScheduler(timezone="UTC")
    # NB: no next_run_time=None here — in APScheduler that means "add the
    # job PAUSED" (it never fires), not "first run after one interval".
    # That exact mistake shipped 2026-07-02: the daemon only ever published
    # via the boot ticks below, once per (re)deploy. An interval job's
    # first fire is now+interval by default, which is what we want.
    scheduler.add_job(harmonie_tick, "interval", minutes=harmonie_minutes)
    scheduler.add_job(radar_tick, "interval", minutes=radar_minutes)
    scheduler.add_job(icon_tick, "interval", minutes=icon_minutes)
    scheduler.add_job(beat, "interval", seconds=60)
    print(f"vane-pipeline daemon: harmonie every {harmonie_minutes}m, "
          f"radar every {radar_minutes}m, icon-eu every {icon_minutes}m")
    beat()
    harmonie_tick()
    radar_tick()
    icon_tick()
    scheduler.start()


if __name__ == "__main__":
    main()
