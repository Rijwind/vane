"""Synthetic NL weather dataset — validates the full chain without KNMI creds.

Smooth, time-coherent fields that look plausible on a map: a drifting warm
blob for temperature, a rotating vortex + mean westerly flow for wind, and
advecting rain cells for precipitation.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np

from vane_tools.writer import VaneVariable

NL_BBOX = (3.2, 50.7, 7.3, 53.6)  # west, south, east, north


def synthetic_variables(
    nt: int = 25, ny: int = 220, nx: int = 260
) -> tuple[list[VaneVariable], list[datetime], tuple[float, float, float, float]]:
    west, south, east, north = NL_BBOX
    lon = np.linspace(west, east, nx)
    lat = np.linspace(north, south, ny)
    lon2, lat2 = np.meshgrid(lon, lat)

    t0 = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    timesteps = [t0 + timedelta(hours=h) for h in range(nt)]

    temp = np.empty((nt, ny, nx), dtype="float64")
    wind_u = np.empty_like(temp)
    wind_v = np.empty_like(temp)
    precip = np.empty_like(temp)

    for i in range(nt):
        ph = i / nt * 2 * np.pi
        # Warm blob drifting east + diurnal cycle + north-south gradient.
        blob = 8 * np.exp(
            -(((lon2 - (4.0 + 2.5 * i / nt)) ** 2) / 0.8 + ((lat2 - 52.2) ** 2) / 0.5)
        )
        temp[i] = 12 + 6 * np.sin(ph - np.pi / 2) + blob - 1.5 * (lat2 - south)

        # Vortex around a slowly moving center + mean westerly.
        cy, cx = 52.0 + 0.5 * np.sin(ph), 5.2 + 0.8 * np.cos(ph)
        dy, dx = lat2 - cy, (lon2 - cx) * np.cos(np.radians(lat2))
        r2 = dx**2 + dy**2 + 0.05
        strength = 6.0
        wind_u[i] = 5.0 + strength * (-dy / r2) * np.exp(-r2 / 1.5)
        wind_v[i] = strength * (dx / r2) * np.exp(-r2 / 1.5)

        # Two advecting rain cells, clipped to >= 0.
        rain = 6 * np.exp(
            -(((lon2 - (3.5 + 3.0 * i / nt)) ** 2) / 0.3 + ((lat2 - 51.6) ** 2) / 0.2)
        ) + 3 * np.exp(
            -(((lon2 - (6.5 - 2.0 * i / nt)) ** 2) / 0.4 + ((lat2 - 53.0) ** 2) / 0.15)
        )
        precip[i] = np.maximum(rain - 1.0, 0.0)

    variables = [
        VaneVariable(
            "temperature", temp, unit="celsius", scale=0.01, offset=-50.0,
            extra_attrs={"default_colormap": "thermal", "default_clim": [-10, 30]},
        ),
        VaneVariable(
            "wind_u", wind_u, unit="m/s", scale=0.01,
            extra_attrs={"vector_group": "wind", "vector_component": "u"},
        ),
        VaneVariable(
            "wind_v", wind_v, unit="m/s", scale=0.01,
            extra_attrs={"vector_group": "wind", "vector_component": "v"},
        ),
        VaneVariable("precipitation", precip, unit="mm/h", scale=0.01),
    ]
    return variables, timesteps, NL_BBOX
