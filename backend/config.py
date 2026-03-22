"""Load env and config paths."""
import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from project root (parent of backend/)
_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_ROOT / ".env")

# LLM provider: "openai" or "xai"
LLM_PROVIDER_FILE = _ROOT / "jarvis-llm-provider.txt"

# Default directory for GET /tools/grep when `root` is omitted (optional)
GREP_ROOT_FILE = _ROOT / "jarvis-grep-root.txt"


def get_llm_provider() -> str:
    """Current LLM provider: 'openai' or 'xai'. Default openai."""
    if LLM_PROVIDER_FILE.exists():
        p = LLM_PROVIDER_FILE.read_text(encoding="utf-8").strip().lower()
        if p in ("openai", "xai"):
            return p
    return "openai"


def set_llm_provider(provider: str) -> None:
    """Set LLM provider to 'openai' or 'xai'."""
    p = (provider or "").strip().lower()
    if p not in ("openai", "xai"):
        raise ValueError("provider must be 'openai' or 'xai'")
    LLM_PROVIDER_FILE.parent.mkdir(parents=True, exist_ok=True)
    LLM_PROVIDER_FILE.write_text(p, encoding="utf-8")


def get_openai_api_key() -> str:
    key = os.environ.get("OPENAI_API_KEY", "").strip().strip('"')
    if not key:
        raise ValueError("OPENAI_API_KEY not set. Add it to a .env file in the project root.")
    return key


def get_xai_api_key() -> str:
    key = (
        os.environ.get("xAI_API_KEY") or os.environ.get("XAI_API_KEY") or ""
    ).strip().strip('"')
    if not key:
        raise ValueError("xAI_API_KEY not set. Add it to a .env file in the project root.")
    return key


def get_llm_api_key() -> str:
    """API key for the current LLM provider."""
    if get_llm_provider() == "xai":
        return get_xai_api_key()
    return get_openai_api_key()


def chats_config_path() -> Path:
    """Path to file storing custom chats directory."""
    return _ROOT / "jarvis-chats-dir.txt"


def chats_dir() -> Path:
    """Directory where chat logs are stored."""
    p = chats_config_path()
    if p.exists():
        s = p.read_text(encoding="utf-8").strip()
        if s:
            d = Path(s)
            if d.is_dir() or not d.exists():
                return d
    return _ROOT / "chats"


def get_grep_root() -> Path | None:
    """
    Optional default search root for file grep: JARVIS_GREP_ROOT env, else jarvis-grep-root.txt.
    Returns None if unset or path is not an existing directory.
    """
    env = (os.environ.get("JARVIS_GREP_ROOT") or "").strip()
    if env:
        p = Path(env).expanduser().resolve()
        return p if p.is_dir() else None
    if GREP_ROOT_FILE.exists():
        s = GREP_ROOT_FILE.read_text(encoding="utf-8").strip()
        if s:
            p = Path(s).expanduser().resolve()
            return p if p.is_dir() else None
    return None


def get_chat_history_limit() -> int:
    """
    Max chat log messages sent to the LLM each turn (router + streaming chat).
    Override with JARVIS_CHAT_HISTORY_LIMIT (clamped 1–500). Default 120.
    """
    raw = (os.environ.get("JARVIS_CHAT_HISTORY_LIMIT") or "").strip()
    if raw.isdigit():
        return max(1, min(int(raw), 500))
    return 120


def get_memory_query_recent_turns() -> int:
    """
    How many recent messages from the log are folded into the vector-memory retrieval query string.
    Override with JARVIS_MEMORY_QUERY_RECENT_TURNS (clamped 1–80). Default 12.
    """
    raw = (os.environ.get("JARVIS_MEMORY_QUERY_RECENT_TURNS") or "").strip()
    if raw.isdigit():
        return max(1, min(int(raw), 80))
    return 12
