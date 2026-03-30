"""Gmail API (per-user OAuth access token)."""
from __future__ import annotations

import httpx


def fetch_gmail_profile(access_token: str) -> dict:
    """GET users/me/profile — requires gmail.readonly (or broader Gmail scope)."""
    r = httpx.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20.0,
    )
    r.raise_for_status()
    return r.json()
