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

import click

from vane_pipeline.jobs import run_harmonie
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
@click.option("--interval-minutes", default=10, show_default=True,
              help="How often to check for a new Harmonie run")
@click.option("--max-hours", default=48, show_default=True)
@click.option("--keep-days", default=7, show_default=True)
def daemon(interval_minutes: int, max_hours: int, keep_days: int) -> None:
    """Run forever: poll for new runs and publish them.

    Polling is cheap (one list call + pointer read when nothing changed),
    so a short interval mostly bounds publish latency, not cost.
    """
    from apscheduler.schedulers.blocking import BlockingScheduler

    storage = storage_from_env()
    api_key = _api_key()

    def tick() -> None:
        try:
            run_harmonie(storage, api_key=api_key, max_hours=max_hours, keep_days=keep_days)
        except Exception as e:  # keep the scheduler alive on transient failures
            print(f"harmonie: ERROR {e}")

    scheduler = BlockingScheduler(timezone="UTC")
    scheduler.add_job(tick, "interval", minutes=interval_minutes, next_run_time=None)
    print(f"vane-pipeline daemon: harmonie every {interval_minutes}m")
    tick()  # once at startup
    scheduler.start()


if __name__ == "__main__":
    main()
