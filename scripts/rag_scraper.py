#!/usr/bin/env python3
"""SmallCode RAG scraper.

Clones/pulls curated or user-provided repositories, extracts symbol-sized code
snippets (not whole files), and emits JSONL records consumed by bin/rag-index.js.
The implementation is intentionally dependency-free so a fresh checkout can run
it with only Python 3 and git.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
CURATED_PATH = ROOT / "src" / "rag" / "curated_repos.json"

SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "target",
    "coverage", ".next", ".nuxt", ".venv", "venv", "__pycache__", ".pytest_cache",
    "bin", "obj", ".gradle", ".idea", ".vscode", "Pods", ".dart_tool",
}

LANG_BY_EXT = {
    ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".cjs": "javascript", ".ts": "typescript", ".tsx": "typescript", ".go": "go",
    ".rs": "rust", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
    ".cs": "csharp", ".php": "php", ".rb": "ruby", ".c": "c", ".h": "c",
    ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".swift": "swift", ".dart": "dart", ".scala": "scala", ".clj": "clojure",
    ".ex": "elixir", ".exs": "elixir", ".erl": "erlang", ".hrl": "erlang",
    ".lua": "lua", ".sh": "shell", ".bash": "shell", ".zsh": "shell",
}

SYMBOL_PATTERNS: Dict[str, re.Pattern[str]] = {
    "python": re.compile(r"^\s*(?:async\s+def|def|class)\s+([A-Za-z_][\w]*)"),
    "javascript": re.compile(r"^\s*(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function))"),
    "typescript": re.compile(r"^\s*(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function))"),
    "go": re.compile(r"^\s*(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)|type\s+([A-Za-z_][\w]*)\s+(?:struct|interface))"),
    "rust": re.compile(r"^\s*(?:pub\s+)?(?:async\s+)?(?:fn\s+([A-Za-z_][\w]*)|struct\s+([A-Za-z_][\w]*)|enum\s+([A-Za-z_][\w]*)|trait\s+([A-Za-z_][\w]*)|impl\b)"),
    "java": re.compile(r"^\s*(?:public|private|protected|static|final|abstract|\s)*\s*(?:class|interface|enum|record)\s+([A-Za-z_][\w]*)|^\s*(?:public|private|protected|static|final|synchronized|abstract|native|\s)+[\w<>\[\], ?]+\s+([A-Za-z_][\w]*)\s*\("),
    "csharp": re.compile(r"^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|async|\s)*\s*(?:class|interface|enum|record|struct)\s+([A-Za-z_][\w]*)|^\s*(?:public|private|protected|internal|static|async|override|virtual|\s)+[\w<>\[\], ?]+\s+([A-Za-z_][\w]*)\s*\("),
    "php": re.compile(r"^\s*(?:final\s+|abstract\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_][\w]*)|^\s*(?:public|private|protected|static|final|abstract|\s)*function\s+([A-Za-z_][\w]*)"),
    "ruby": re.compile(r"^\s*(?:class|module|def)\s+([A-Za-z_][\w:!?=]*)"),
    "cpp": re.compile(r"^\s*(?:template\s*<[^>]+>\s*)?(?:class|struct|enum)\s+([A-Za-z_][\w]*)|^\s*(?:inline\s+|static\s+|constexpr\s+|virtual\s+)*[\w:<>&*\s]+\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)"),
    "c": re.compile(r"^\s*(?:static\s+|inline\s+)*[\w\s\*]+\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?:\{|$)"),
}

DEFAULT_SYMBOL_PATTERN = re.compile(r"^\s*(?:function|class|def|func|fn)\s+([A-Za-z_][\w]*)")

@dataclass
class RepoSpec:
    url: str
    tags: List[str]
    name: Optional[str] = None
    max_files: Optional[int] = None
    max_snippets: Optional[int] = None


def run_git(args: Sequence[str], cwd: Optional[Path] = None) -> None:
    subprocess.run(["git", *args], cwd=str(cwd) if cwd else None, check=True, stdout=subprocess.DEVNULL)


def safe_repo_name(url: str) -> str:
    if os.path.exists(url):
        return Path(url).resolve().name
    clean = url.rstrip("/").removesuffix(".git")
    parts = clean.split("/")[-2:]
    return "__".join(parts) if len(parts) == 2 else hashlib.sha1(url.encode()).hexdigest()[:12]


def ensure_repo(spec: RepoSpec, cache_dir: Path) -> Path:
    if os.path.isdir(spec.url) and not spec.url.startswith(("http://", "https://", "git@")):
        return Path(spec.url).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    dest = cache_dir / safe_repo_name(spec.url)
    if (dest / ".git").exists():
        run_git(["pull", "--ff-only"], dest)
    else:
        run_git(["clone", "--depth=1", "--filter=blob:none", spec.url, str(dest)], cache_dir)
    return dest


def iter_code_files(root: Path, max_bytes: int, languages: Optional[set[str]]) -> Iterator[Tuple[Path, str]]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for filename in filenames:
            path = Path(dirpath) / filename
            lang = LANG_BY_EXT.get(path.suffix.lower())
            if not lang or (languages and lang not in languages):
                continue
            try:
                if path.stat().st_size > max_bytes:
                    continue
            except OSError:
                continue
            yield path, lang


def symbol_name(match: re.Match[str]) -> str:
    for group in match.groups():
        if group:
            return group
    return "symbol"


def find_symbols(lines: List[str], lang: str) -> List[Tuple[int, str]]:
    pat = SYMBOL_PATTERNS.get(lang, DEFAULT_SYMBOL_PATTERN)
    out = []
    for idx, line in enumerate(lines):
        m = pat.search(line)
        if m:
            out.append((idx, symbol_name(m)))
    return out


def trim_chunk(lines: List[str], max_lines: int) -> List[str]:
    if len(lines) <= max_lines:
        return lines
    return lines[:max_lines]


def sliding_chunks(lines: List[str], chunk_lines: int, overlap: int) -> Iterator[Tuple[int, List[str]]]:
    step = max(1, chunk_lines - overlap)
    for start in range(0, len(lines), step):
        chunk = lines[start:start + chunk_lines]
        if len("\n".join(chunk).strip()) >= 80:
            yield start, chunk


def chunk_file(text: str, lang: str, chunk_lines: int, overlap: int, min_chars: int) -> Iterator[Dict[str, object]]:
    lines = text.splitlines()
    symbols = find_symbols(lines, lang)
    emitted = 0
    used_ranges: List[Tuple[int, int]] = []

    for pos, (start, name) in enumerate(symbols):
        next_start = symbols[pos + 1][0] if pos + 1 < len(symbols) else len(lines)
        end = min(next_start, start + chunk_lines)
        chunk = trim_chunk(lines[start:end], chunk_lines)
        code = "\n".join(chunk).strip()
        if len(code) < min_chars:
            continue
        used_ranges.append((start, end))
        emitted += 1
        yield {
            "kind": "symbol",
            "symbol": name,
            "startLine": start + 1,
            "endLine": start + len(chunk),
            "code": code,
        }

    # Fallback/window chunks keep files without obvious symbols useful, while
    # still indexing snippets rather than complete files.
    if emitted == 0:
        for start, chunk in sliding_chunks(lines, chunk_lines, overlap):
            code = "\n".join(chunk).strip()
            if len(code) >= min_chars:
                yield {"kind": "window", "symbol": None, "startLine": start + 1, "endLine": start + len(chunk), "code": code}


def snippet_id(repo: str, rel: str, start: int, code: str) -> str:
    return hashlib.sha1(f"{repo}:{rel}:{start}:{code}".encode("utf-8", "ignore")).hexdigest()


def scrape_repo(spec: RepoSpec, repo_root: Path, options: argparse.Namespace) -> Iterator[Dict[str, object]]:
    max_files = spec.max_files or options.max_files_per_repo
    max_snippets = spec.max_snippets or options.max_snippets_per_repo
    languages = set(options.languages.split(",")) if options.languages else None
    file_count = 0
    snippet_count = 0
    for file_path, lang in iter_code_files(repo_root, options.max_file_bytes, languages):
        if file_count >= max_files or snippet_count >= max_snippets:
            break
        file_count += 1
        try:
            text = file_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel = str(file_path.relative_to(repo_root)).replace(os.sep, "/")
        for chunk in chunk_file(text, lang, options.chunk_lines, options.overlap, options.min_chars):
            if snippet_count >= max_snippets:
                break
            code = str(chunk["code"])
            record = {
                "id": snippet_id(spec.url, rel, int(chunk["startLine"]), code),
                "repo": spec.url,
                "repoName": spec.name or safe_repo_name(spec.url),
                "tags": spec.tags,
                "path": rel,
                "lang": lang,
                **chunk,
            }
            snippet_count += 1
            yield record


def load_curated(preset: str) -> List[RepoSpec]:
    data = json.loads(CURATED_PATH.read_text(encoding="utf-8"))
    items = data.get(preset)
    if not isinstance(items, list):
        raise SystemExit(f"Unknown RAG preset '{preset}'. Available: {', '.join(sorted(data))}")
    return [RepoSpec(url=i["url"], tags=list(i.get("tags", [])), name=i.get("name")) for i in items]


def load_config(path: Optional[Path], preset_override: Optional[str]) -> Tuple[Dict[str, object], List[RepoSpec]]:
    cfg: Dict[str, object] = {}
    if path and path.exists():
        cfg = json.loads(path.read_text(encoding="utf-8"))
    preset = preset_override if preset_override is not None else str(cfg.get("preset", "none" if cfg.get("repos") else "starter"))
    specs: List[RepoSpec] = []
    if preset and preset != "none":
        specs.extend(load_curated(preset))
    for item in cfg.get("repos", []) or []:
        if isinstance(item, str):
            specs.append(RepoSpec(url=item, tags=[]))
        elif isinstance(item, dict) and item.get("url"):
            specs.append(RepoSpec(
                url=str(item["url"]),
                tags=list(item.get("tags", [])),
                name=item.get("name"),
                max_files=item.get("maxFiles"),
                max_snippets=item.get("maxSnippets"),
            ))
    # Stable de-dupe by URL.
    seen = set()
    unique = []
    for spec in specs:
        if spec.url in seen:
            continue
        seen.add(spec.url)
        unique.append(spec)
    return cfg, unique


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Scrape curated GitHub/local repos into SmallCode RAG JSONL snippets.")
    ap.add_argument("--config", type=Path, default=None, help="Path to .smallcode/rag/repos.json")
    ap.add_argument("--cache-dir", type=Path, default=Path(".smallcode/rag/repos"))
    ap.add_argument("--out", type=Path, required=True, help="Output JSONL file")
    ap.add_argument("--preset", default=None, help="Curated preset: starter, broad, or none")
    ap.add_argument("--repo", action="append", default=[], help="Extra Git URL or local path to scrape")
    ap.add_argument("--languages", default="", help="Optional comma-separated language allowlist")
    ap.add_argument("--max-files-per-repo", type=int, default=1000)
    ap.add_argument("--max-snippets-per-repo", type=int, default=4000)
    ap.add_argument("--max-file-bytes", type=int, default=250_000)
    ap.add_argument("--chunk-lines", type=int, default=80)
    ap.add_argument("--overlap", type=int, default=20)
    ap.add_argument("--min-chars", type=int, default=120)
    return ap.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    cfg, specs = load_config(args.config, args.preset)
    if cfg:
        args.cache_dir = Path(str(cfg.get("cacheDir", args.cache_dir)))
        args.max_files_per_repo = int(cfg.get("maxFilesPerRepo", args.max_files_per_repo))
        args.max_snippets_per_repo = int(cfg.get("maxSnippetsPerRepo", args.max_snippets_per_repo))
        args.max_file_bytes = int(cfg.get("maxFileBytes", args.max_file_bytes))
        args.chunk_lines = int(cfg.get("chunkLines", args.chunk_lines))
        args.overlap = int(cfg.get("overlap", args.overlap))
        args.min_chars = int(cfg.get("minChars", args.min_chars))
        if cfg.get("languages") and not args.languages:
            args.languages = ",".join(cfg.get("languages")) if isinstance(cfg.get("languages"), list) else str(cfg.get("languages"))
    for repo in args.repo:
        specs.append(RepoSpec(url=repo, tags=[]))
    if not specs:
        print("No repositories configured. Use --preset starter/broad or add repos to repos.json.", file=sys.stderr)
        return 2

    args.out.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with args.out.open("w", encoding="utf-8") as fh:
        for spec in specs:
            print(f"scraping {spec.url}", file=sys.stderr)
            try:
                repo_root = ensure_repo(spec, args.cache_dir)
                count = 0
                for rec in scrape_repo(spec, repo_root, args):
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    count += 1
                total += count
                print(f"  snippets: {count}", file=sys.stderr)
            except (subprocess.CalledProcessError, OSError) as exc:
                print(f"  skipped: {exc}", file=sys.stderr)
    print(json.dumps({"snippets": total, "out": str(args.out)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
