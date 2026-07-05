import pytest
import queue
import subprocess

import backend.main as main
from backend.utils import sanitize_filename

@pytest.mark.parametrize("input_title,expected_output", [
    ("Song Title", "song-title"),
    ("My SoNg", "my-song"),
    ("Song! @#$%^&*()Title", "song-title"),
    ("Song   Title", "song-title"),
    ("Song---Title", "song-title"),
    ("Song - - Title", "song-title"),
    ("  Song Title  ", "song-title"),
    ("--Song Title--", "song-title"),
    ("Song 123", "song-123"),
    ("", "untitled-song"),
    ("!!! @#$ %^&", "untitled-song"),
    (" - - ", "untitled-song"),
    ("123 abc", "123-abc"),
])
def test_sanitize_filename(input_title, expected_output):
    assert sanitize_filename(input_title) == expected_output


def test_enqueue_content_sync_records_saved_locally(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "ensure_sync_worker_started", lambda: None)
    monkeypatch.setattr(main, "sync_job_queue", queue.Queue())
    with main.sync_jobs_lock:
        main.sync_jobs.clear()

    status = main.enqueue_content_sync(str(tmp_path / "amazing-grace.pro"), "Update song")

    assert status["status"] == "saved_locally"
    assert status["filename"] == "amazing-grace.pro"
    assert status["ok"] is None
    assert main.sync_job_queue.get_nowait() == status["job_id"]


@pytest.mark.parametrize("path,expected", [
    ("assets/index-abc123.js", "public, max-age=31536000, immutable"),
    ("data/songs.index.json", "public, max-age=0, must-revalidate"),
    ("index.html", "no-cache"),
    ("logo-black-96.png", "public, max-age=86400"),
])
def test_cache_control_for_static_path(path, expected):
    assert main.cache_control_for_static_path(path) == expected


@pytest.mark.parametrize("path,expected", [
    ("/api/version", True),
    ("/assets/index-abc123.js", True),
    ("/data/songs.index.json", True),
    ("/logo-black-96.png", False),
])
def test_should_gzip_path(path, expected):
    assert main.should_gzip_path(path) is expected


def test_run_sync_job_marks_failed_when_rebuild_fails(monkeypatch, tmp_path):
    job_id = "job-1"
    changed_path = str(tmp_path / "song.pro")
    with main.sync_jobs_lock:
        main.sync_jobs.clear()
        main.sync_jobs[job_id] = {
            "job_id": job_id,
            "status": "saved_locally",
            "action": "Update song",
            "changed_path": changed_path,
            "message": "Saved locally.",
            "ok": None,
            "pushed": False,
            "created_at": 1,
            "updated_at": 1,
        }

    monkeypatch.setattr(main, "rebuild_songs", lambda: {"ok": False, "message": "Build failed"})
    monkeypatch.setattr(
        main,
        "sync_content_repo",
        lambda *_args, **_kwargs: pytest.fail("sync should not run after a failed rebuild"),
    )

    main.run_sync_job(job_id)

    with main.sync_jobs_lock:
        job = main.sync_jobs[job_id]
    assert job["status"] == "failed"
    assert job["ok"] is False
    assert job["message"] == "Build failed"


def run_git(cwd, *args):
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


def init_content_repo(tmp_path):
    remote = tmp_path / "remote.git"
    repo = tmp_path / "content"
    run_git(tmp_path, "init", "--bare", str(remote))
    run_git(tmp_path, "init", "-b", "main", str(repo))
    run_git(repo, "config", "user.name", "Test User")
    run_git(repo, "config", "user.email", "test@example.com")
    run_git(repo, "remote", "add", "origin", str(remote))

    songs_dir = repo / "songs"
    songs_dir.mkdir()
    song_path = songs_dir / "country-roads.pro"
    song_path.write_text("{title: Country Roads}\n", encoding="utf-8")
    run_git(repo, "add", "songs/country-roads.pro")
    run_git(repo, "commit", "-m", "Initial song")
    run_git(repo, "push", "-u", "origin", "main")
    return repo, remote, song_path


def test_untracked_files_do_not_block_content_repo_rebase(monkeypatch, tmp_path):
    repo, _remote, _song_path = init_content_repo(tmp_path)
    (repo / ".DS_Store").write_text("finder metadata", encoding="utf-8")
    monkeypatch.setattr(main, "CONTENT_REPO_DIR", str(repo))

    assert main.content_repo_has_uncommitted_tracked_changes() is False


def test_sync_pushes_pending_local_commits_when_file_has_no_new_diff(monkeypatch, tmp_path):
    repo, remote, song_path = init_content_repo(tmp_path)
    song_path.write_text("{title: Country Roads}\n{key: A}\n", encoding="utf-8")
    run_git(repo, "add", "songs/country-roads.pro")
    run_git(repo, "commit", "-m", "Update song: country-roads.pro via Holy Songs editor")
    (repo / ".DS_Store").write_text("finder metadata", encoding="utf-8")

    monkeypatch.setattr(main, "CONTENT_REPO_DIR", str(repo))
    monkeypatch.setattr(main, "rebuild_songs", lambda: {"ok": True, "message": "rebuilt"})
    monkeypatch.setenv("CONTENT_REPO_PUSH_REMOTE", "origin")
    monkeypatch.setenv("CONTENT_REPO_PUSH_BRANCH", "main")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("CONTENT_REPO_PUSH_REMOTE_URL", raising=False)

    result = main.sync_content_repo(str(song_path), "Update song")

    assert result["ok"] is True
    assert result["pushed"] is True
    remote_log = run_git(remote, "log", "--oneline", "main").stdout
    assert "Update song: country-roads.pro via Holy Songs editor" in remote_log


def test_recover_pending_content_repo_backup_commits_and_pushes_saved_song(monkeypatch, tmp_path):
    repo, remote, song_path = init_content_repo(tmp_path)
    song_path.write_text("{title: Country Roads}\n{key: A}\n", encoding="utf-8")
    (repo / ".DS_Store").write_text("finder metadata", encoding="utf-8")

    monkeypatch.setattr(main, "CONTENT_REPO_DIR", str(repo))
    monkeypatch.setattr(main, "SONGS_DIR", str(repo / "songs"))
    monkeypatch.setattr(main, "rebuild_songs", lambda: {"ok": True, "message": "rebuilt"})
    monkeypatch.setenv("CONTENT_REPO_PUSH_REMOTE", "origin")
    monkeypatch.setenv("CONTENT_REPO_PUSH_BRANCH", "main")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("CONTENT_REPO_PUSH_REMOTE_URL", raising=False)

    result = main.recover_pending_content_repo_backup()

    assert result["ok"] is True
    assert result["pushed"] is True
    remote_show = run_git(remote, "show", "main:songs/country-roads.pro").stdout
    assert "{key: A}" in remote_show
    assert ".DS_Store" not in run_git(remote, "ls-tree", "-r", "--name-only", "main").stdout


def test_ensure_content_repo_safe_directory_adds_missing_path(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "CONTENT_REPO_DIR", "/app/songs")

    def fake_run(args, **kwargs):
        calls.append(args)
        if args[:4] == ["git", "config", "--global", "--get-all"]:
            return subprocess.CompletedProcess(args, 1, stdout="/other/repo\n", stderr="")
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(main.subprocess, "run", fake_run)

    main.ensure_content_repo_safe_directory()

    assert ["git", "config", "--global", "--add", "safe.directory", "/app/songs"] in calls
