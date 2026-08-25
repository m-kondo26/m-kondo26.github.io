#!/usr/bin/env python3
"""Update the latest Spotify episode shown on the English and Japanese pages."""

from __future__ import annotations

import datetime as dt
import html
import pathlib
import re
import sys
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPOTIFY_BASE = "https://open.spotify.com"
USER_AGENT = "Mozilla/5.0 (compatible; KondoCTLabsPodcastUpdater/1.0)"

SHOWS = {
    "japanese": "033iFaOROrdvnzCWXiy8qE",
    "english": "033BsMJtlJp7as0DYQgvBt",
    "korean": "033vcpBzHBZpjFUtvHZlsU",
    "thai": "033vdiUosJdGqAuL0q5AVE",
}


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def text_only(fragment: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


def latest_episode(show_id: str) -> tuple[str, str]:
    show_html = fetch(f"{SPOTIFY_BASE}/show/{show_id}")
    match = re.search(
        r'<a href="/episode/([^"?]+)"[^>]*>\s*<h4[^>]*data-testid="episodeTitle"[^>]*>(.*?)</h4>',
        show_html,
        flags=re.DOTALL,
    )
    if not match:
        raise RuntimeError(f"Could not identify the latest episode for show {show_id}")

    episode_id, title_fragment = match.groups()
    title = text_only(title_fragment)
    episode_html = fetch(f"{SPOTIFY_BASE}/episode/{episode_id}")
    date_match = re.search(
        r'<meta name="music:release_date" content="(\d{4}-\d{2}-\d{2})',
        episode_html,
    )
    if not date_match:
        raise RuntimeError(f"Could not identify the release date for episode {episode_id}")

    return title, date_match.group(1)


def short_episode_label(title: str, language: str) -> str:
    number_match = re.search(r"(?:#|＃)\s*(\d+)\s*$", title)
    if not number_match:
        number_match = re.search(r"(?:episode|ep\.?|第)\s*#?\s*(\d+)(?:\s*回)?\s*$", title, re.I)
    if number_match:
        number = number_match.group(1)
        return f"第{number}回" if language == "ja" else f"Episode #{number}"
    return title


def render_latest(key: str, title: str, iso_date: str, language: str) -> str:
    date = dt.date.fromisoformat(iso_date)
    if language == "ja":
        label = "最新エピソード"
        display_date = f"{date.year}年{date.month}月{date.day}日"
    else:
        label = "Latest episode"
        display_date = f"{date:%b} {date.day}, {date.year}"
    episode = short_episode_label(title, language)
    return (
        f'<p class="podcast-latest" data-podcast="{key}">'
        f"<span>{label}</span><time datetime=\"{iso_date}\">{html.escape(display_date)}</time>"
        f"<small>{html.escape(episode)}</small></p>"
    )


def update_page(path: pathlib.Path, episodes: dict[str, tuple[str, str]], language: str) -> bool:
    source = path.read_text(encoding="utf-8")
    updated = source
    for key, (title, iso_date) in episodes.items():
        pattern = re.compile(
            rf'<p class="podcast-latest" data-podcast="{re.escape(key)}">.*?</p>',
            flags=re.DOTALL,
        )
        replacement = render_latest(key, title, iso_date, language)
        updated, count = pattern.subn(replacement, updated, count=1)
        if count != 1:
            raise RuntimeError(f"Expected one {key!r} podcast marker in {path}")
    if updated == source:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def main() -> int:
    episodes: dict[str, tuple[str, str]] = {}
    for key, show_id in SHOWS.items():
        episodes[key] = latest_episode(show_id)
        print(f"{key}: {episodes[key][0]} ({episodes[key][1]})")

    changed = [
        update_page(ROOT / "index.html", episodes, "en"),
        update_page(ROOT / "ja" / "index.html", episodes, "ja"),
    ]
    print("Podcast pages updated." if any(changed) else "Podcast pages already current.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
