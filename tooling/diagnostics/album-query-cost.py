"""Compare actual album enrichment SQL at HEAD and in the working tree.

Uses synthetic in-memory SQLite only. VM instructions are workload evidence,
not Cloudflare D1 billable rows. Run from the repository root with Python.
"""
import json
import pathlib
import re
import sqlite3
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH = "server/src/routes/localAlbumRead.js"
BASELINE = "517dd49"
old = subprocess.check_output(["git", "show", f"{BASELINE}:{PATH}"], cwd=ROOT, text=True, encoding="utf-8")
new = (ROOT / PATH).read_text(encoding="utf-8")


def query(source, page_size):
    section = source.split("async function enrichAlbumPage", 1)[1].split("async function listAlbums", 1)[0]
    sql = re.search(r"db\.prepare\(`([\s\S]*?)`\)", section).group(1)
    playable = re.search(r'const PLAYABLE = "(.*?)";', source).group(1)
    clause = " OR ".join(["(TRIM(s.artist) = ? AND TRIM(s.album) = ?)"] * page_size)
    return sql.replace("${PLAYABLE}", playable).replace("${clause}", clause)


def measure(db, sql, params):
    steps = 0

    def tick():
        nonlocal steps
        steps += 100
        return 0

    db.set_progress_handler(tick, 100)
    result = sorted(db.execute(sql, params).fetchall())
    db.set_progress_handler(None, 0)
    return result, steps


for size in (1000, 10000, 50000):
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE Songs(id TEXT PRIMARY KEY, artist TEXT, album TEXT, audio_url TEXT, cover_url TEXT, created_at INTEGER)")
    db.executemany("INSERT INTO Songs VALUES(?,?,?,?,?,?)", (
        (f"s{i:06d}", f"artist{i % 200}", f"album{i % 200}", f"/audio/{i}",
         None if i % 7 == 0 else f"/cover/{i}", None if i % 11 == 0 else i)
        for i in range(size)
    ))
    for page_size in (10, 50):
        params = [v for i in range(page_size) for v in (f"artist{i}", f"album{i}")]
        before, old_steps = measure(db, query(old, page_size), params)
        after, new_steps = measure(db, query(new, page_size), params)
        assert before == after, "Album results changed"
        print(json.dumps({"songs": size, "page_albums": page_size, "results_equal": True,
                          "old_vm_steps": old_steps, "new_vm_steps": new_steps,
                          "reduction_percent": round((1 - new_steps / old_steps) * 100, 1)}))
    db.close()
