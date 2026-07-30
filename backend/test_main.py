import asyncio
import os
import pytest
import queue
import subprocess
from fastapi import HTTPException

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


def test_generate_ice_servers_defaults_to_cloudflare_stun(monkeypatch):
    monkeypatch.setattr(main, "TURN_KEY_ID", "")
    monkeypatch.setattr(main, "TURN_API_TOKEN", "")

    assert main.generate_ice_servers() == [
        {"urls": ["stun:stun.cloudflare.com:3478"]},
    ]


def test_live_signalling_relays_only_to_the_named_peer(monkeypatch):
    class FakeWebSocket:
        def __init__(self):
            self.messages = []
            self.accepted = False

        async def accept(self):
            self.accepted = True

        async def send_json(self, message):
            self.messages.append(message)

    async def exercise():
        signalling = main.LiveSignalling()
        first_socket = FakeWebSocket()
        second_socket = FakeWebSocket()
        monkeypatch.setattr(main, "safe_generate_ice_servers", lambda: [])

        first = await signalling.join(first_socket, "alice@example.ie")
        second = await signalling.join(second_socket, "bob@example.ie")
        await signalling.relay(
            first,
            {
                "type": "offer",
                "to": second.peer_id,
                "payload": {"description": {"type": "offer", "sdp": "opaque"}},
            },
        )

        assert first_socket.accepted is True
        assert second_socket.accepted is True
        assert second_socket.messages[-1] == {
            "type": "offer",
            "from": first.peer_id,
            "payload": {"description": {"type": "offer", "sdp": "opaque"}},
        }

        await signalling.handle(first, {"type": "ping", "nonce": "resume-check"})
        assert first_socket.messages[-1] == {
            "type": "pong",
            "nonce": "resume-check",
        }

    asyncio.run(exercise())


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


def test_sync_worker_survives_unexpected_job_exception(monkeypatch, capsys):
    class StopWorker(BaseException):
        pass

    class FakeQueue:
        def __init__(self):
            self.job_ids = iter(["job-1", "job-2"])
            self.completed = 0

        def get(self):
            try:
                return next(self.job_ids)
            except StopIteration:
                raise StopWorker()

        def task_done(self):
            self.completed += 1

    fake_queue = FakeQueue()
    completed_jobs = []

    def fake_run_sync_job(job_id):
        if job_id == "job-1":
            raise RuntimeError("network exploded")
        completed_jobs.append(job_id)

    with main.sync_jobs_lock:
        main.sync_jobs.clear()
        main.sync_jobs["job-1"] = {
            "job_id": "job-1",
            "status": "syncing",
            "updated_at": 1,
        }
    monkeypatch.setattr(main, "sync_job_queue", fake_queue)
    monkeypatch.setattr(main, "run_sync_job", fake_run_sync_job)

    with pytest.raises(StopWorker):
        main.sync_worker_loop()

    with main.sync_jobs_lock:
        failed_job = main.sync_jobs["job-1"]
    assert failed_job["status"] == "failed"
    assert failed_job["ok"] is False
    assert failed_job["message"] == "Unexpected content sync error: network exploded"
    assert completed_jobs == ["job-2"]
    assert fake_queue.completed == 2
    assert "Sync job job-1 failed unexpectedly: network exploded" in capsys.readouterr().out


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
    run_git(tmp_path, "init", "--bare", "-b", "main", str(remote))
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


def test_remote_refresh_build_failure_is_reported_as_sync_failure(monkeypatch, tmp_path):
    repo, remote, song_path = init_content_repo(tmp_path)
    other_repo = tmp_path / "other"
    run_git(tmp_path, "clone", str(remote), str(other_repo))
    run_git(other_repo, "config", "user.name", "Other User")
    run_git(other_repo, "config", "user.email", "other@example.com")
    remote_content = "{title: Country Roads}\n{key: D}\n"
    (other_repo / "songs" / "country-roads.pro").write_text(remote_content, encoding="utf-8")
    run_git(other_repo, "add", "songs/country-roads.pro")
    run_git(other_repo, "commit", "-m", "Remote song update")
    run_git(other_repo, "push", "origin", "main")

    monkeypatch.setattr(main, "CONTENT_REPO_DIR", str(repo))
    monkeypatch.setattr(main, "ensure_content_repo_safe_directory", lambda: None)
    monkeypatch.setattr(main, "rebuild_songs", lambda: {"ok": False, "message": "duplicate ids"})
    monkeypatch.setenv("CONTENT_REPO_PUSH_REMOTE", "origin")
    monkeypatch.setenv("CONTENT_REPO_PUSH_BRANCH", "main")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("CONTENT_REPO_PUSH_REMOTE_URL", raising=False)

    result = main.sync_content_repo(str(song_path), "Update song")

    assert result["ok"] is False
    assert result["pushed"] is False
    assert "previous catalogue remains active" in result["message"]
    assert "duplicate ids" in result["message"]
    assert song_path.read_text(encoding="utf-8") == remote_content


def test_post_rebase_build_failure_prevents_push(monkeypatch, tmp_path):
    repo, remote, song_path = init_content_repo(tmp_path)
    other_repo = tmp_path / "other"
    run_git(tmp_path, "clone", str(remote), str(other_repo))
    run_git(other_repo, "config", "user.name", "Other User")
    run_git(other_repo, "config", "user.email", "other@example.com")
    (other_repo / "songs" / "remote-song.pro").write_text(
        "{title: Remote Song}\n",
        encoding="utf-8",
    )
    run_git(other_repo, "add", "songs/remote-song.pro")
    run_git(other_repo, "commit", "-m", "Add remote song")
    run_git(other_repo, "push", "origin", "main")

    local_content = "{title: Country Roads}\n{key: A}\n"
    song_path.write_text(local_content, encoding="utf-8")
    monkeypatch.setattr(main, "CONTENT_REPO_DIR", str(repo))
    monkeypatch.setattr(main, "ensure_content_repo_safe_directory", lambda: None)
    monkeypatch.setattr(main, "rebuild_songs", lambda: {"ok": False, "message": "catalog error"})
    monkeypatch.setenv("CONTENT_REPO_PUSH_REMOTE", "origin")
    monkeypatch.setenv("CONTENT_REPO_PUSH_BRANCH", "main")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("CONTENT_REPO_PUSH_REMOTE_URL", raising=False)

    result = main.sync_content_repo(str(song_path), "Update song")

    assert result["ok"] is False
    assert result["pushed"] is False
    assert "previous catalogue remains active" in result["message"]
    assert "catalog error" in result["message"]
    assert song_path.read_text(encoding="utf-8") == local_content
    assert run_git(remote, "show", "main:songs/country-roads.pro").stdout == "{title: Country Roads}\n"
    assert "songs/remote-song.pro" in run_git(repo, "ls-tree", "-r", "--name-only", "HEAD").stdout


def test_independently_valid_duplicate_ids_are_not_pushed_after_rebase(monkeypatch, tmp_path):
    repo, remote, _song_path = init_content_repo(tmp_path)
    other_repo = tmp_path / "other"
    run_git(tmp_path, "clone", str(remote), str(other_repo))
    run_git(other_repo, "config", "user.name", "Other User")
    run_git(other_repo, "config", "user.email", "other@example.com")
    (other_repo / "songs" / "remote-grace.pro").write_text(
        "{title: Shared Grace}\n",
        encoding="utf-8",
    )
    run_git(other_repo, "add", "songs/remote-grace.pro")
    run_git(other_repo, "commit", "-m", "Add remote grace song")
    run_git(other_repo, "push", "origin", "main")

    local_song = repo / "songs" / "local-grace.pro"
    local_song.write_text("{title: Shared---Grace!}\n", encoding="utf-8")

    def validate_combined_catalogue():
        seen_ids = set()
        for path in sorted((repo / "songs").glob("*.pro")):
            song_id = main.normalized_song_id(main.extract_song_title(path.read_text(encoding="utf-8")))
            if song_id in seen_ids:
                return {"ok": False, "message": f"duplicate song id: {song_id}"}
            seen_ids.add(song_id)
        return {"ok": True, "message": "catalogue valid"}

    monkeypatch.setattr(main, "CONTENT_REPO_DIR", str(repo))
    monkeypatch.setattr(main, "ensure_content_repo_safe_directory", lambda: None)
    monkeypatch.setattr(main, "rebuild_songs", validate_combined_catalogue)
    monkeypatch.setenv("CONTENT_REPO_PUSH_REMOTE", "origin")
    monkeypatch.setenv("CONTENT_REPO_PUSH_BRANCH", "main")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("CONTENT_REPO_PUSH_REMOTE_URL", raising=False)

    result = main.sync_content_repo(str(local_song), "Create song")

    assert result["ok"] is False
    assert result["pushed"] is False
    assert "duplicate song id: shared-grace" in result["message"]
    assert "songs/local-grace.pro" not in run_git(remote, "ls-tree", "-r", "--name-only", "main").stdout
    local_tree = run_git(repo, "ls-tree", "-r", "--name-only", "HEAD").stdout
    assert "songs/local-grace.pro" in local_tree
    assert "songs/remote-grace.pro" in local_tree
    assert run_git(repo, "status", "--porcelain").stdout == ""


def test_pending_commit_build_failure_prevents_push_without_remote_changes(monkeypatch, tmp_path):
    repo, remote, song_path = init_content_repo(tmp_path)
    local_content = "{title: Country Roads}\n{key: A}\n"
    song_path.write_text(local_content, encoding="utf-8")
    run_git(repo, "add", "songs/country-roads.pro")
    run_git(repo, "commit", "-m", "Pending local edit")

    monkeypatch.setattr(main, "CONTENT_REPO_DIR", str(repo))
    monkeypatch.setattr(main, "ensure_content_repo_safe_directory", lambda: None)
    monkeypatch.setattr(main, "rebuild_songs", lambda: {"ok": False, "message": "duplicate ids"})
    monkeypatch.setenv("CONTENT_REPO_PUSH_REMOTE", "origin")
    monkeypatch.setenv("CONTENT_REPO_PUSH_BRANCH", "main")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("CONTENT_REPO_PUSH_REMOTE_URL", raising=False)

    result = main.sync_content_repo(str(song_path), "Update song")

    assert result["ok"] is False
    assert result["pushed"] is False
    assert "combined song catalogue failed validation" in result["message"]
    assert run_git(remote, "show", "main:songs/country-roads.pro").stdout == "{title: Country Roads}\n"
    assert run_git(repo, "show", "HEAD:songs/country-roads.pro").stdout == local_content


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


def test_build_push_target_converts_github_ssh_without_embedding_token(monkeypatch):
    token = "github_pat_testSecret123456789"
    monkeypatch.setattr(main, "CONTENT_REPO_DIR", "/content")
    monkeypatch.setenv("GITHUB_TOKEN", token)
    monkeypatch.delenv("CONTENT_REPO_PUSH_REMOTE_URL", raising=False)

    def fake_run(args, **_kwargs):
        assert args == ["git", "remote", "get-url", "origin"]
        return subprocess.CompletedProcess(
            args,
            0,
            stdout="git@github.com:Loyyd/holy-songs-content.git\n",
            stderr="",
        )

    monkeypatch.setattr(main.subprocess, "run", fake_run)

    target = main.build_push_target("origin")

    assert target == "https://github.com/Loyyd/holy-songs-content.git"
    assert token not in target


def test_build_push_target_strips_credentials_from_explicit_url(monkeypatch):
    token = "github_pat_testSecret123456789"
    monkeypatch.setenv("GITHUB_TOKEN", token)
    monkeypatch.setenv(
        "CONTENT_REPO_PUSH_REMOTE_URL",
        f"https://x-access-token:{token}@github.com/Loyyd/holy-songs-content.git",
    )

    target = main.build_push_target("origin")

    assert target == "https://github.com/Loyyd/holy-songs-content.git"
    assert token not in target


def test_git_transport_uses_temporary_askpass_without_token_in_argv(monkeypatch):
    token = "github_pat_testSecret123456789"
    captured = {}
    monkeypatch.setenv("CONTENT_REPO_TOKEN", token)
    monkeypatch.setenv("CONTENT_REPO_USERNAME", "holy-songs-bot")

    def fake_run(args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs["env"]
        askpass_path = kwargs["env"]["GIT_ASKPASS"]
        captured["askpass_path"] = askpass_path
        with open(askpass_path, "r", encoding="utf-8") as askpass_file:
            captured["askpass_script"] = askpass_file.read()
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(main.subprocess, "run", fake_run)

    main.run_git_transport(
        ["fetch", "https://github.com/Loyyd/holy-songs-content.git", "main"],
        check=True,
        capture_output=True,
        text=True,
    )

    assert token not in repr(captured["args"])
    assert captured["env"]["CONTENT_REPO_TOKEN"] == token
    assert captured["env"]["CONTENT_REPO_USERNAME"] == "holy-songs-bot"
    assert captured["env"]["GIT_TERMINAL_PROMPT"] == "0"
    assert "$CONTENT_REPO_TOKEN" in captured["askpass_script"]
    assert "$CONTENT_REPO_USERNAME" in captured["askpass_script"]
    assert token not in captured["askpass_script"]
    assert not os.path.exists(captured["askpass_path"])


def test_sync_failure_redacts_token_from_result_job_and_log(monkeypatch, tmp_path, capsys):
    repo, _remote, song_path = init_content_repo(tmp_path)
    token = "github_pat_testSecret123456789"
    credential_url = f"https://x-access-token:{token}@github.com/Loyyd/holy-songs-content.git"
    monkeypatch.setattr(main, "CONTENT_REPO_DIR", str(repo))
    monkeypatch.setattr(main, "ensure_content_repo_safe_directory", lambda: None)
    monkeypatch.setenv("GITHUB_TOKEN", token)
    monkeypatch.setenv("CONTENT_REPO_PUSH_BRANCH", "main")

    def fail_rebase(*_args, **_kwargs):
        raise subprocess.CalledProcessError(
            128,
            ["git", "fetch", credential_url, "main"],
            stderr=f"fatal: authentication failed for {credential_url}; token={token}",
        )

    monkeypatch.setattr(main, "rebase_content_repo", fail_rebase)

    result = main.sync_content_repo(str(song_path), "Update song")
    with main.sync_jobs_lock:
        main.sync_jobs.clear()
        main.sync_jobs["redaction-job"] = {
            "job_id": "redaction-job",
            "status": "failed",
            "action": "Update song",
            "changed_path": str(song_path),
            "message": f"git failed with {token} at {credential_url}",
            "ok": False,
            "pushed": False,
            "created_at": 1,
            "updated_at": 1,
        }
        public_status = main.public_job_status(main.sync_jobs["redaction-job"])

    output = capsys.readouterr().out
    assert token not in result["message"]
    assert token not in public_status["message"]
    assert token not in output
    assert "[REDACTED]" in result["message"]


@pytest.fixture
def isolated_songs(monkeypatch, tmp_path):
    songs_dir = tmp_path / "songs"
    songs_dir.mkdir()
    monkeypatch.setattr(main, "SONGS_DIR", str(songs_dir))
    monkeypatch.setattr(main, "rebuild_songs", lambda: {"ok": True, "message": "rebuilt"})
    monkeypatch.setattr(
        main,
        "enqueue_content_sync",
        lambda _path, _action, **_kwargs: {"job_id": "sync-test", "status": "saved_locally"},
    )
    return songs_dir


def test_get_song_exposes_content_revision(isolated_songs):
    content = "{title: Shared Song}\n{key: C}\n"
    (isolated_songs / "shared-song.pro").write_text(content, encoding="utf-8")

    response = main.get_song("shared-song.pro")

    assert response == {"content": content, "revision": main.song_revision(content)}


def test_create_rejects_duplicate_normalized_id_before_writing(monkeypatch, isolated_songs):
    existing = isolated_songs / "original-name.pro"
    existing.write_text("{title: Grace of the Holy Garden}\n", encoding="utf-8")
    monkeypatch.setattr(
        main,
        "rebuild_songs",
        lambda: pytest.fail("duplicate content must be rejected before rebuilding"),
    )

    with pytest.raises(HTTPException) as error:
        main.create_song(main.SongContent(content="{title: GRACE---of the holy garden!}\n"))

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "duplicate_song_id"
    assert error.value.detail["song_id"] == "grace-of-the-holy-garden"
    assert error.value.detail["conflicts"] == [
        {"filename": "original-name.pro", "title": "Grace of the Holy Garden"}
    ]
    assert sorted(path.name for path in isolated_songs.iterdir()) == ["original-name.pro"]


def test_update_rejects_title_change_that_collides(monkeypatch, isolated_songs):
    original_content = "{title: First Song}\n"
    first_path = isolated_songs / "first-song.pro"
    first_path.write_text(original_content, encoding="utf-8")
    (isolated_songs / "second-song.pro").write_text("{title: Second Song}\n", encoding="utf-8")
    monkeypatch.setattr(
        main,
        "rebuild_songs",
        lambda: pytest.fail("duplicate content must be rejected before rebuilding"),
    )

    with pytest.raises(HTTPException) as error:
        main.update_song(
            "first-song.pro",
            main.SongContent(
                content="{title: Second---Song!}\n",
                expected_revision=main.song_revision(original_content),
            ),
        )

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "duplicate_song_id"
    assert first_path.read_text(encoding="utf-8") == original_content


def test_two_editors_cannot_silently_overwrite_each_other(isolated_songs):
    original_content = "{title: Shared Song}\n{key: C}\n"
    first_edit = "{title: Shared Song}\n{key: D}\n"
    second_edit = "{title: Shared Song}\n{key: E}\n"
    song_path = isolated_songs / "shared-song.pro"
    song_path.write_text(original_content, encoding="utf-8")
    loaded_revision = main.get_song("shared-song.pro")["revision"]

    first_response = main.update_song(
        "shared-song.pro",
        main.SongContent(content=first_edit, expected_revision=loaded_revision),
    )

    assert first_response["revision"] == main.song_revision(first_edit)
    with pytest.raises(HTTPException) as error:
        main.update_song(
            "shared-song.pro",
            main.SongContent(content=second_edit, expected_revision=loaded_revision),
        )

    assert error.value.status_code == 409
    assert error.value.detail == {
        "code": "revision_conflict",
        "message": "This song changed after you opened it. Review the latest version before trying again.",
        "filename": "shared-song.pro",
        "expected_revision": loaded_revision,
        "current_revision": main.song_revision(first_edit),
        "current_content": first_edit,
    }
    assert song_path.read_text(encoding="utf-8") == first_edit


def test_update_requires_expected_revision(isolated_songs):
    original_content = "{title: Shared Song}\n"
    song_path = isolated_songs / "shared-song.pro"
    song_path.write_text(original_content, encoding="utf-8")

    with pytest.raises(HTTPException) as error:
        main.update_song(
            "shared-song.pro",
            main.SongContent(content="{title: Shared Song}\n{key: D}\n"),
        )

    assert error.value.status_code == 428
    assert error.value.detail["code"] == "revision_required"
    assert song_path.read_text(encoding="utf-8") == original_content


def test_failed_update_build_rolls_file_and_catalogue_back(monkeypatch, isolated_songs):
    original_content = "{title: Shared Song}\n{key: C}\n"
    changed_content = "{title: Shared Song}\n{key: D}\n"
    song_path = isolated_songs / "shared-song.pro"
    song_path.write_text(original_content, encoding="utf-8")
    build_results = iter(
        [
            {"ok": False, "message": "invalid song"},
            {"ok": True, "message": "catalogue restored"},
        ]
    )
    monkeypatch.setattr(main, "rebuild_songs", lambda: next(build_results))

    with pytest.raises(HTTPException) as error:
        main.update_song(
            "shared-song.pro",
            main.SongContent(
                content=changed_content,
                expected_revision=main.song_revision(original_content),
            ),
        )

    assert error.value.status_code == 422
    assert error.value.detail["code"] == "song_build_failed"
    assert error.value.detail["rollback_succeeded"] is True
    assert song_path.read_text(encoding="utf-8") == original_content
    assert not list(isolated_songs.glob(".*.tmp"))


def test_failed_create_build_removes_new_file(monkeypatch, isolated_songs):
    build_results = iter(
        [
            {"ok": False, "message": "invalid song"},
            {"ok": True, "message": "catalogue restored"},
        ]
    )
    monkeypatch.setattr(main, "rebuild_songs", lambda: next(build_results))

    with pytest.raises(HTTPException) as error:
        main.create_song(main.SongContent(content="{title: Broken Song}\n"))

    assert error.value.status_code == 422
    assert error.value.detail["rollback_succeeded"] is True
    assert list(isolated_songs.iterdir()) == []


def test_delete_rejects_stale_revision(isolated_songs):
    current_content = "{title: Shared Song}\n{key: D}\n"
    song_path = isolated_songs / "shared-song.pro"
    song_path.write_text(current_content, encoding="utf-8")

    with pytest.raises(HTTPException) as error:
        main.delete_song("shared-song.pro", expected_revision=main.song_revision("older content"))

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "revision_conflict"
    assert error.value.detail["current_content"] == current_content
    assert song_path.exists()


def test_rebase_conflict_aborts_without_picking_a_winner(monkeypatch, tmp_path):
    repo, remote, song_path = init_content_repo(tmp_path)
    local_content = "{title: Country Roads - Local}\n"
    song_path.write_text(local_content, encoding="utf-8")
    run_git(repo, "add", "songs/country-roads.pro")
    run_git(repo, "commit", "-m", "Local editor change")
    local_head = run_git(repo, "rev-parse", "HEAD").stdout.strip()

    other_repo = tmp_path / "other"
    run_git(tmp_path, "clone", str(remote), str(other_repo))
    run_git(other_repo, "config", "user.name", "Other User")
    run_git(other_repo, "config", "user.email", "other@example.com")
    other_song = other_repo / "songs" / "country-roads.pro"
    other_song.write_text("{title: Country Roads - Remote}\n", encoding="utf-8")
    run_git(other_repo, "add", "songs/country-roads.pro")
    run_git(other_repo, "commit", "-m", "Remote editor change")
    run_git(other_repo, "push", "origin", "main")

    monkeypatch.setattr(main, "CONTENT_REPO_DIR", str(repo))
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("CONTENT_REPO_PUSH_REMOTE_URL", raising=False)

    with pytest.raises(subprocess.CalledProcessError):
        main.rebase_content_repo("origin", "main", "Test User", "test@example.com")

    assert run_git(repo, "rev-parse", "HEAD").stdout.strip() == local_head
    assert song_path.read_text(encoding="utf-8") == local_content
    assert run_git(repo, "status", "--porcelain").stdout == ""
    assert not (repo / ".git" / "rebase-merge").exists()
