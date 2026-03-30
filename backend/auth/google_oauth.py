"""Google OAuth flow + lightweight local token/session store.

This is a pragmatic scaffold for local/dev use. For production multi-user apps,
replace file-backed storage with your database + encryption/KMS.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
from urllib.parse import quote_plus
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

# Repo root: backend/auth/google_oauth.py -> parents[2] == Socrates/
_REPO_ROOT = Path(__file__).resolve().parents[2]
_dotenv_override = (os.environ.get("JARVIS_DOTENV_PATH") or "").strip()
if _dotenv_override:
    load_dotenv(Path(_dotenv_override).expanduser(), encoding="utf-8")
else:
    # Same file as backend/config.py uses; load again so OAuth works even if import order changes.
    load_dotenv(_REPO_ROOT / ".env", encoding="utf-8")

_DEFAULT_STORE_PATH = _REPO_ROOT / ".secrets" / "google-oauth-store.json"
_LOCK = threading.Lock()
_PENDING_TTL_SEC = 10 * 60
_SESSION_TTL_SEC = 30 * 24 * 60 * 60


def _now() -> int:
    return int(time.time())


def _store_path() -> Path:
    raw = (os.environ.get("GOOGLE_OAUTH_STORE_PATH") or "").strip()
    if raw:
        return Path(raw).expanduser()
    return _DEFAULT_STORE_PATH


def _cookie_secure() -> bool:
    return (os.environ.get("GOOGLE_OAUTH_COOKIE_SECURE") or "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _frontend_base_url() -> str:
    return (
        os.environ.get("GOOGLE_OAUTH_FRONTEND_URL")
        or os.environ.get("FRONTEND_URL")
        or "http://localhost:5173"
    ).strip().rstrip("/")


def _redirect_uri() -> str:
    return (
        os.environ.get("GOOGLE_OAUTH_REDIRECT_URI")
        or "http://localhost:5173/api/auth/google/callback"
    ).strip()


def _client_id() -> str:
    return (os.environ.get("GOOGLE_OAUTH_CLIENT_ID") or "").strip().strip('"').strip("'")


def _client_secret() -> str:
    return (os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET") or "").strip().strip('"').strip("'")


def _scopes() -> str:
    raw = (os.environ.get("GOOGLE_OAUTH_SCOPES") or "").strip()
    if raw:
        return raw
    return (
        "openid email profile "
        "https://www.googleapis.com/auth/calendar "
        "https://www.googleapis.com/auth/gmail.readonly"
    )


def oauth_is_configured() -> bool:
    return bool(_client_id() and _client_secret())


def oauth_missing_config_fields() -> list[str]:
    missing = []
    if not _client_id():
        missing.append("GOOGLE_OAUTH_CLIENT_ID")
    if not _client_secret():
        missing.append("GOOGLE_OAUTH_CLIENT_SECRET")
    return missing


def oauth_redirect_uri() -> str:
    """Exact redirect_uri sent to Google; must match Authorized redirect URIs in GCP (character-for-character)."""
    return _redirect_uri()


def _empty_store() -> dict[str, Any]:
    return {"pending": {}, "sessions": {}, "users": {}}


def _load_store() -> dict[str, Any]:
    p = _store_path()
    if not p.exists():
        return _empty_store()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return _empty_store()
        data.setdefault("pending", {})
        data.setdefault("sessions", {})
        data.setdefault("users", {})
        return data
    except Exception:
        return _empty_store()


def _save_store(data: dict[str, Any]) -> None:
    p = _store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _cleanup_expired(data: dict[str, Any]) -> None:
    now = _now()
    pending = data.get("pending") or {}
    sessions = data.get("sessions") or {}
    for key, row in list(pending.items()):
        ts = int((row or {}).get("created_at") or 0)
        if now - ts > _PENDING_TTL_SEC:
            pending.pop(key, None)
    for sid, row in list(sessions.items()):
        ts = int((row or {}).get("created_at") or 0)
        if now - ts > _SESSION_TTL_SEC:
            sessions.pop(sid, None)


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")
    return verifier, challenge


def create_login_url(next_path: str | None = None) -> str:
    if not oauth_is_configured():
        missing = ", ".join(oauth_missing_config_fields())
        raise ValueError(f"Google OAuth is not configured. Missing: {missing}")

    state = secrets.token_urlsafe(24)
    verifier, challenge = _pkce_pair()
    with _LOCK:
        data = _load_store()
        _cleanup_expired(data)
        data["pending"][state] = {
            "code_verifier": verifier,
            "created_at": _now(),
            "next_path": (next_path or "/").strip() or "/",
        }
        _save_store(data)

    params = {
        "client_id": _client_id(),
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": _scopes(),
        "state": state,
        "access_type": "offline",
        "prompt": "consent",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return str(httpx.URL("https://accounts.google.com/o/oauth2/v2/auth", params=params))


def exchange_code_and_create_session(code: str, state: str) -> tuple[str, str]:
    if not oauth_is_configured():
        missing = ", ".join(oauth_missing_config_fields())
        raise ValueError(f"Google OAuth is not configured. Missing: {missing}")

    with _LOCK:
        data = _load_store()
        _cleanup_expired(data)
        pending = (data.get("pending") or {}).pop(state, None)
        _save_store(data)
    if not pending:
        raise ValueError("Invalid or expired OAuth state.")

    verifier = str(pending.get("code_verifier") or "")
    if not verifier:
        raise ValueError("OAuth verifier missing for this state.")

    token_resp = httpx.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "redirect_uri": _redirect_uri(),
            "grant_type": "authorization_code",
            "code_verifier": verifier,
        },
        timeout=20.0,
    )
    token_resp.raise_for_status()
    token_data = token_resp.json()
    access_token = token_data.get("access_token")
    if not access_token:
        raise ValueError("Google token response did not include access_token.")

    userinfo_resp = httpx.get(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20.0,
    )
    userinfo_resp.raise_for_status()
    profile = userinfo_resp.json()
    sub = str(profile.get("sub") or "").strip()
    if not sub:
        raise ValueError("Google user profile did not include subject id.")

    sid = secrets.token_urlsafe(32)
    with _LOCK:
        data = _load_store()
        _cleanup_expired(data)
        users = data.setdefault("users", {})
        sessions = data.setdefault("sessions", {})
        current = users.get(sub) or {}
        old_refresh = ((current.get("tokens") or {}).get("refresh_token") or "").strip()
        users[sub] = {
            "sub": sub,
            "email": profile.get("email"),
            "name": profile.get("name"),
            "picture": profile.get("picture"),
            "updated_at": _now(),
            "tokens": {
                "access_token": token_data.get("access_token"),
                "refresh_token": token_data.get("refresh_token") or old_refresh or None,
                "scope": token_data.get("scope"),
                "token_type": token_data.get("token_type"),
                "expires_in": token_data.get("expires_in"),
                "id_token": token_data.get("id_token"),
            },
        }
        sessions[sid] = {"sub": sub, "created_at": _now()}
        _save_store(data)

    next_path = str(pending.get("next_path") or "/").strip() or "/"
    return sid, next_path


def google_status_by_session(session_id: str | None) -> dict[str, Any]:
    if not session_id:
        return {"connected": False, "configured": oauth_is_configured(), "user": None}
    with _LOCK:
        data = _load_store()
        _cleanup_expired(data)
        sessions = data.get("sessions") or {}
        users = data.get("users") or {}
        row = sessions.get(session_id)
        if not row:
            _save_store(data)
            return {"connected": False, "configured": oauth_is_configured(), "user": None}
        user = users.get(row.get("sub")) or {}
        _save_store(data)
    if not user:
        return {"connected": False, "configured": oauth_is_configured(), "user": None}
    return {
        "connected": True,
        "configured": oauth_is_configured(),
        "user": {
            "sub": user.get("sub"),
            "email": user.get("email"),
            "name": user.get("name"),
            "picture": user.get("picture"),
        },
    }


def logout_session(session_id: str | None) -> None:
    if not session_id:
        return
    with _LOCK:
        data = _load_store()
        _cleanup_expired(data)
        (data.get("sessions") or {}).pop(session_id, None)
        _save_store(data)


def disconnect_session(session_id: str | None) -> None:
    if not session_id:
        return
    revoke_token = None
    with _LOCK:
        data = _load_store()
        _cleanup_expired(data)
        sessions = data.get("sessions") or {}
        users = data.get("users") or {}
        row = sessions.pop(session_id, None)
        if row:
            sub = row.get("sub")
            if sub in users:
                tokens = (users.get(sub) or {}).get("tokens") or {}
                revoke_token = (tokens.get("refresh_token") or tokens.get("access_token") or "").strip() or None
                users.pop(sub, None)
        _save_store(data)

    if revoke_token:
        try:
            httpx.post(
                "https://oauth2.googleapis.com/revoke",
                data={"token": revoke_token},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=15.0,
            )
        except Exception:
            # Logout should still succeed even if revoke endpoint fails.
            pass


def callback_success_redirect(next_path: str) -> str:
    base = _frontend_base_url()
    safe_next = next_path if next_path.startswith("/") else "/"
    sep = "&" if "?" in safe_next else "?"
    return f"{base}{safe_next}{sep}google_connected=1"


def callback_error_redirect(message: str) -> str:
    base = _frontend_base_url()
    return f"{base}/?google_auth_error={quote_plus(message)}"


def cookie_secure() -> bool:
    return _cookie_secure()

