"""Load env and config paths."""
import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from project root (parent of backend/)
_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_ROOT / ".env")

# LLM provider: "openai" or "xai"
LLM_PROVIDER_FILE = _ROOT / "jarvis-llm-provider.txt"


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


def chroma_dir() -> Path:
    """Persistent Chroma DB directory for cross-chat semantic memory (RAG)."""
    custom = os.environ.get("JARVIS_CHROMA_PATH", "").strip().strip('"')
    if custom:
        return Path(custom)
    return _ROOT / "jarvis-chroma"


def memory_retrieval_raw_top_n() -> int:
    """
    How many top memory hits include full chunk text in the system prompt (0 = IDs + short summaries only).
    Set JARVIS_MEMORY_RAW_CHUNKS=1..10 to expand the strongest matches inline.
    """
    raw = os.environ.get("JARVIS_MEMORY_RAW_CHUNKS", "0").strip()
    try:
        return max(0, min(10, int(raw)))
    except ValueError:
        return 0


def memory_retrieval_summary_max_chars() -> int:
    """Max characters per hit summary line in the prompt (longer chats stay token-light)."""
    raw = os.environ.get("JARVIS_MEMORY_SUMMARY_CHARS", "220").strip()
    try:
        return max(40, min(800, int(raw)))
    except ValueError:
        return 220
