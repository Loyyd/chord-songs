from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from contextlib import asynccontextmanager, contextmanager
import hashlib
import os
import queue
import subprocess
import re
import tempfile
import threading
import time
import uuid
from urllib.parse import quote

from backend.utils import sanitize_filename


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_sync_worker_started()
    if os.path.exists(SONGS_DIR) and not os.path.exists(DIST_INDEX_PATH):
        rebuild_songs()
    recover_pending_content_repo_backup()
    yield


app = FastAPI(lifespan=lifespan)


def parse_cors_origins() -> list[str]:
    configured = os.environ.get("CORS_ORIGINS", "")
    origins = [origin.strip() for origin in configured.split(",") if origin.strip()]
    if origins:
        return origins
    return [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


# Allow CORS for frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=parse_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SelectiveGZipMiddleware:
    def __init__(self, app, minimum_size: int = 1024):
        self.app = app
        self.gzip_app = GZipMiddleware(app, minimum_size=minimum_size)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and should_gzip_path(scope.get("path", "")):
            await self.gzip_app(scope, receive, send)
            return
        await self.app(scope, receive, send)


def should_gzip_path(path: str) -> bool:
    return path.startswith("/api/") or path.endswith((".css", ".html", ".js", ".json", ".svg"))


app.add_middleware(SelectiveGZipMiddleware, minimum_size=1024)


def cache_control_for_static_path(path: str) -> str:
    normalized_path = path.replace("\\", "/").lstrip("/")
    if normalized_path.startswith("assets/"):
        return "public, max-age=31536000, immutable"
    if normalized_path.startswith("data/") and normalized_path.endswith(".json"):
        return "public, max-age=0, must-revalidate"
    if normalized_path in {"", "."} or normalized_path.endswith(".html"):
        return "no-cache"
    return "public, max-age=86400"


class CachedStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers.setdefault("Cache-Control", cache_control_for_static_path(path))
        return response


# Path to the songs directory (relative to this file)
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DIST_DIR = os.path.join(BASE_DIR, "dist")
DIST_DATA_DIR = os.path.join(DIST_DIR, "data")
DIST_INDEX_PATH = os.path.join(DIST_DATA_DIR, "songs.index.json")
GIT_SHA = os.environ.get("GIT_SHA", "unknown")
IMAGE_REF = os.environ.get("IMAGE_REF", "unknown")
ADMIN_TOKEN = os.environ.get("HOLY_SONGS_ADMIN_TOKEN", "").strip()


def require_write_access(
    authorization: str | None = Header(default=None),
    x_admin_token: str | None = Header(default=None),
):
    if not ADMIN_TOKEN:
        return

    bearer_prefix = "Bearer "
    provided_token = x_admin_token if isinstance(x_admin_token, str) else None
    if isinstance(authorization, str) and authorization.startswith(bearer_prefix):
        provided_token = authorization[len(bearer_prefix):].strip()

    if not provided_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin token required",
        )

    if provided_token != ADMIN_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid admin token",
        )

def has_chordpro_files(directory: str) -> bool:
    try:
        return any(entry.endswith(".pro") for entry in os.listdir(directory))
    except OSError:
        return False

def resolve_songs_dir() -> str:
    configured_dir = os.environ.get("SONGS_DIR")
    if configured_dir:
        return os.path.abspath(configured_dir)

    local_dir = os.path.join(BASE_DIR, "songs")
    if os.path.isdir(local_dir) and has_chordpro_files(local_dir):
        return local_dir

    sibling_dir = os.path.abspath(os.path.join(BASE_DIR, "..", "holy-songs-content", "songs"))
    return sibling_dir

SONGS_DIR = resolve_songs_dir()

def resolve_content_repo_dir() -> str | None:
    configured_dir = os.environ.get("CONTENT_REPO_DIR")
    if configured_dir:
        return os.path.abspath(configured_dir)

    parent_dir = os.path.abspath(os.path.join(SONGS_DIR, ".."))
    if os.path.isdir(os.path.join(parent_dir, ".git")):
        return parent_dir

    sibling_repo = os.path.abspath(os.path.join(BASE_DIR, "..", "holy-songs-content"))
    if os.path.isdir(os.path.join(sibling_repo, ".git")):
        return sibling_repo

    return None

CONTENT_REPO_DIR = resolve_content_repo_dir()

DEFAULT_GIT_USER_NAME = "Holy Songs Bot"
DEFAULT_GIT_USER_EMAIL = "holy-songs-bot@local"


def redact_secrets(value: object) -> str:
    """Remove credentials from text before it reaches logs or API responses."""
    text = str(value)
    github_token = os.environ.get("GITHUB_TOKEN", "")
    if github_token:
        text = text.replace(github_token, "[REDACTED]")
        encoded_token = quote(github_token, safe="")
        if encoded_token != github_token:
            text = text.replace(encoded_token, "[REDACTED]")

    # Also cover credentials supplied in a remote URL and recognizable GitHub
    # tokens that may have reached stderr through external git configuration.
    text = re.sub(r"(?i)(https?://)[^/@\s]+@", r"\1[REDACTED]@", text)
    text = re.sub(
        r"\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+)\b",
        "[REDACTED]",
        text,
    )
    return text


def git_error_detail(error: subprocess.CalledProcessError) -> str:
    stderr = (error.stderr or "").strip()
    stdout = (error.stdout or "").strip()
    return redact_secrets(stderr or stdout or error)


def strip_http_url_credentials(remote_url: str) -> str:
    """Keep secrets out of git argv even when a configured URL contains userinfo."""
    return re.sub(r"(?i)^(https?://)[^/@\s]+@", r"\1", remote_url)


@contextmanager
def git_auth_environment():
    """Provide a GitHub token to git through askpass, never through argv or a file."""
    github_token = os.environ.get("GITHUB_TOKEN", "")
    if not github_token:
        yield None
        return

    descriptor, askpass_path = tempfile.mkstemp(prefix="holy-songs-git-askpass-")
    try:
        os.fchmod(descriptor, 0o700)
        with os.fdopen(descriptor, "w", encoding="utf-8") as askpass_file:
            descriptor = -1
            askpass_file.write(
                "#!/bin/sh\n"
                "case \"$1\" in\n"
                "  *Username*) printf '%s\\n' 'x-access-token' ;;\n"
                "  *Password*) printf '%s\\n' \"$GITHUB_TOKEN\" ;;\n"
                "  *) printf '\\n' ;;\n"
                "esac\n"
            )

        env = os.environ.copy()
        env["GIT_ASKPASS"] = askpass_path
        env["GIT_ASKPASS_REQUIRE"] = "force"
        env["GIT_TERMINAL_PROMPT"] = "0"
        yield env
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(askpass_path)
        except FileNotFoundError:
            pass


def run_git_transport(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    """Run a fetch/push with non-interactive, argv-safe token authentication."""
    with git_auth_environment() as auth_env:
        command = ["git", *args]
        if auth_env is not None:
            kwargs["env"] = auth_env
            # Do not let a machine-level helper silently substitute a different
            # credential; the empty helper falls through to our askpass program.
            command = ["git", "-c", "credential.helper=", *args]
        return subprocess.run(command, **kwargs)

def ensure_content_repo_safe_directory():
    if not CONTENT_REPO_DIR:
        return

    safe_directories = subprocess.run(
        ["git", "config", "--global", "--get-all", "safe.directory"],
        check=False,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    if CONTENT_REPO_DIR in safe_directories:
        return

    subprocess.run(
        ["git", "config", "--global", "--add", "safe.directory", CONTENT_REPO_DIR],
        check=True,
        capture_output=True,
        text=True,
    )

def rebuild_songs() -> dict:
    """Build generated song data without deploying."""
    try:
        env = os.environ.copy()
        # The song builder never needs repository credentials.
        env.pop("GITHUB_TOKEN", None)
        if os.path.exists(DIST_DIR):
            env["SONGS_OUTPUT_DIR"] = DIST_DATA_DIR
        env["SONGS_DIR"] = SONGS_DIR
        
        subprocess.run(
            ["npm", "run", "build:songs"],
            cwd=BASE_DIR,
            check=True,
            env=env,
            capture_output=True,
            text=True,
        )
        message = "Build script executed successfully."
        print(message)
        return {"ok": True, "message": message}
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        stdout = (e.stdout or "").strip()
        message = redact_secrets(f"Error during build: {stderr or stdout or e}")
        print(message)
        return {"ok": False, "message": message}

def build_push_target(remote_name: str) -> str:
    github_token = os.environ.get("GITHUB_TOKEN")
    explicit_remote_url = os.environ.get("CONTENT_REPO_PUSH_REMOTE_URL")

    if explicit_remote_url:
        remote_url = explicit_remote_url
    elif github_token:
        remote_url = subprocess.run(
            ["git", "remote", "get-url", remote_name],
            cwd=CONTENT_REPO_DIR,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    else:
        return remote_name

    remote_url = strip_http_url_credentials(remote_url)
    if github_token and remote_url.startswith("git@github.com:"):
        remote_path = remote_url[len("git@github.com:"):]
        return f"https://github.com/{remote_path}"
    if github_token and remote_url.startswith("ssh://git@github.com/"):
        remote_path = remote_url[len("ssh://git@github.com/"):]
        return f"https://github.com/{remote_path}"
    return remote_url

def get_git_identity() -> tuple[str, str]:
    user_name = os.environ.get("CONTENT_REPO_GIT_USER_NAME", DEFAULT_GIT_USER_NAME)
    user_email = os.environ.get("CONTENT_REPO_GIT_USER_EMAIL", DEFAULT_GIT_USER_EMAIL)
    return user_name, user_email

def rebase_content_repo(remote_name: str, branch: str, user_name: str, user_email: str) -> bool:
    push_target = build_push_target(remote_name)
    before = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=CONTENT_REPO_DIR,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    run_git_transport(
        ["fetch", push_target, branch],
        cwd=CONTENT_REPO_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        subprocess.run(
            [
                "git",
                "-c",
                f"user.name={user_name}",
                "-c",
                f"user.email={user_email}",
                "rebase",
                "FETCH_HEAD",
            ],
            cwd=CONTENT_REPO_DIR,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError:
        # Never pick a silent winner for edits made through another app/source.
        # Leave the local branch and working tree usable for an explicit resolution.
        subprocess.run(
            ["git", "rebase", "--abort"],
            cwd=CONTENT_REPO_DIR,
            check=False,
            capture_output=True,
            text=True,
        )
        raise

    after = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=CONTENT_REPO_DIR,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return before != after

def content_repo_has_uncommitted_tracked_changes() -> bool:
    status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=CONTENT_REPO_DIR,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return bool(status)

def content_repo_has_unpushed_commits() -> bool:
    count = subprocess.run(
        ["git", "rev-list", "--count", "FETCH_HEAD..HEAD"],
        cwd=CONTENT_REPO_DIR,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return int(count or "0") > 0

def push_content_repo_if_needed(remote_name: str, branch: str) -> bool:
    if not content_repo_has_unpushed_commits():
        return False

    push_target = build_push_target(remote_name)
    run_git_transport(
        ["push", push_target, f"HEAD:{branch}"],
        cwd=CONTENT_REPO_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    return True

def recover_pending_content_repo_backup() -> dict | None:
    if not CONTENT_REPO_DIR or not os.path.isdir(os.path.join(CONTENT_REPO_DIR, ".git")):
        return None
    if not os.path.exists(SONGS_DIR):
        return None

    print("Checking for pending local song edits to back up.")
    return sync_content_repo(SONGS_DIR, "Recover local song changes")


def failed_combined_rebuild_result(changed_path: str, build_result: dict) -> dict:
    build_message = redact_secrets(build_result.get("message") or "Unknown build error")
    message = redact_secrets(
        f"Content repo changes for {changed_path} were not pushed because the combined song "
        f"catalogue failed validation. Repository HEAD and any pending commits were kept "
        f"locally, and the previous catalogue remains active. {build_message}"
    )
    print(message)
    return {"ok": False, "pushed": False, "message": message}


def sync_content_repo(changed_path: str, action: str) -> dict:
    if not CONTENT_REPO_DIR or not os.path.isdir(os.path.join(CONTENT_REPO_DIR, ".git")):
        message = "Skipping content repo sync: CONTENT_REPO_DIR is not a git repository."
        print(message)
        return {"ok": False, "pushed": False, "message": message}

    try:
        ensure_content_repo_safe_directory()

        try:
            rel_path = os.path.relpath(os.path.abspath(changed_path), CONTENT_REPO_DIR)
        except ValueError:
            message = f"Skipping content repo sync: {changed_path} is outside the content repo."
            print(message)
            return {"ok": False, "pushed": False, "message": message}

        if rel_path.startswith(".."):
            message = f"Skipping content repo sync: {changed_path} is outside the content repo."
            print(message)
            return {"ok": False, "pushed": False, "message": message}

        remote_name = os.environ.get("CONTENT_REPO_PUSH_REMOTE", "origin")
        branch = os.environ.get("CONTENT_REPO_PUSH_BRANCH")
        if not branch:
            branch = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=CONTENT_REPO_DIR,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()

        user_name, user_email = get_git_identity()
        subprocess.run(["git", "add", "--", rel_path], cwd=CONTENT_REPO_DIR, check=True)

        staged = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "--", rel_path],
            cwd=CONTENT_REPO_DIR,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if not staged:
            remote_changed = rebase_content_repo(remote_name, branch, user_name, user_email)
            has_unpushed_commits = content_repo_has_unpushed_commits()
            if remote_changed or has_unpushed_commits:
                build_result = rebuild_songs()
                if not build_result.get("ok"):
                    return failed_combined_rebuild_result(changed_path, build_result)

            # The push is intentionally after the build. Two independently valid
            # branches can form an invalid catalogue (for example, duplicate IDs).
            pushed = push_content_repo_if_needed(remote_name, branch)
            if remote_changed:
                if pushed:
                    message = f"Content repo refreshed from GitHub and pending commits were synced for {rel_path}."
                    print(message)
                    return {"ok": True, "pushed": True, "message": message}
                message = f"Content repo refreshed from GitHub for {rel_path}."
                print(message)
                return {"ok": True, "pushed": False, "message": message}
            if pushed:
                message = f"Pending content repo commits synced successfully for {rel_path}."
                print(message)
                return {"ok": True, "pushed": True, "message": message}
            message = f"No content repo changes to sync for {rel_path}."
            print(message)
            return {"ok": True, "pushed": False, "message": message}

        commit_message = f"{action}: {os.path.basename(rel_path)} via Holy Songs editor"
        subprocess.run(
            [
                "git",
                "-c",
                f"user.name={user_name}",
                "-c",
                f"user.email={user_email}",
                "commit",
                "-m",
                commit_message,
            ],
            cwd=CONTENT_REPO_DIR,
            check=True,
            capture_output=True,
            text=True,
        )

        if content_repo_has_uncommitted_tracked_changes():
            message = (
                f"Content repo sync paused for {rel_path}: another tracked edit is still "
                "waiting to be committed. The local commit was kept and nothing was pushed."
            )
            print(message)
            return {"ok": False, "pushed": False, "message": message}

        remote_changed = rebase_content_repo(remote_name, branch, user_name, user_email)
        has_unpushed_commits = content_repo_has_unpushed_commits()
        if remote_changed or has_unpushed_commits:
            build_result = rebuild_songs()
            if not build_result.get("ok"):
                return failed_combined_rebuild_result(changed_path, build_result)

        # Validation of the combined local/remote HEAD is the gate for every push.
        pushed = push_content_repo_if_needed(remote_name, branch)
        message = f"Content repo synced successfully for {rel_path}."
        print(message)
        return {"ok": True, "pushed": pushed, "message": message}
    except subprocess.CalledProcessError as error:
        message = redact_secrets(
            f"Content repo sync failed for {changed_path}: {git_error_detail(error)}"
        )
        print(message)
        return {"ok": False, "pushed": False, "message": message}


SYNC_JOB_STATES = {"saved_locally", "rebuilding", "syncing", "synced", "failed"}
sync_job_queue: "queue.Queue[str]" = queue.Queue()
sync_jobs: dict[str, dict] = {}
sync_jobs_lock = threading.Lock()
sync_worker_started = False
sync_worker_lock = threading.Lock()
song_mutation_lock = threading.RLock()


def public_job_status(job: dict) -> dict:
    status = {
        "job_id": job["job_id"],
        "status": job["status"],
        "action": job["action"],
        "filename": os.path.basename(job["changed_path"]),
        "message": redact_secrets(job.get("message")) if job.get("message") is not None else None,
        "ok": job.get("ok"),
        "pushed": job.get("pushed", False),
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
    }
    return status


def update_sync_job(job_id: str, **changes):
    with sync_jobs_lock:
        job = sync_jobs.get(job_id)
        if not job:
            return
        if "status" in changes and changes["status"] not in SYNC_JOB_STATES:
            raise ValueError(f"Invalid sync job status: {changes['status']}")
        if "message" in changes and changes["message"] is not None:
            changes["message"] = redact_secrets(changes["message"])
        job.update(changes)
        job["updated_at"] = time.time()


def run_sync_job(job_id: str):
    with sync_jobs_lock:
        job = sync_jobs.get(job_id)
        if not job:
            return
        changed_path = job["changed_path"]
        action = job["action"]

    with song_mutation_lock:
        rebuild_required = job.get("rebuild_required", True)
        if rebuild_required:
            update_sync_job(
                job_id,
                status="rebuilding",
                message="Saved locally. Rebuilding song data...",
            )
            build_result = rebuild_songs()
            if not build_result["ok"]:
                update_sync_job(
                    job_id,
                    status="failed",
                    ok=False,
                    pushed=False,
                    message=build_result["message"],
                )
                return

        update_sync_job(
            job_id,
            status="syncing",
            message="Song data rebuilt. Syncing content repo...",
        )
        sync_result = sync_content_repo(changed_path, action)
        if sync_result.get("ok"):
            update_sync_job(
                job_id,
                status="synced",
                ok=True,
                pushed=sync_result.get("pushed", False),
                message=sync_result.get("message") or "Content repo synced.",
            )
        else:
            update_sync_job(
                job_id,
                status="failed",
                ok=False,
                pushed=sync_result.get("pushed", False),
                message=sync_result.get("message") or "Content repo sync failed.",
            )


def sync_worker_loop():
    while True:
        job_id = sync_job_queue.get()
        try:
            try:
                run_sync_job(job_id)
            except Exception as error:
                safe_error = redact_secrets(error)
                message = f"Unexpected content sync error: {safe_error}"
                print(f"Sync job {job_id} failed unexpectedly: {safe_error}")
                update_sync_job(
                    job_id,
                    status="failed",
                    ok=False,
                    pushed=False,
                    message=message,
                )
        finally:
            sync_job_queue.task_done()


def ensure_sync_worker_started():
    global sync_worker_started
    with sync_worker_lock:
        if sync_worker_started:
            return
        worker = threading.Thread(target=sync_worker_loop, name="content-sync-worker", daemon=True)
        worker.start()
        sync_worker_started = True


def enqueue_content_sync(changed_path: str, action: str, *, rebuild_required: bool = True) -> dict:
    ensure_sync_worker_started()
    now = time.time()
    job_id = uuid.uuid4().hex
    job = {
        "job_id": job_id,
        "status": "saved_locally",
        "action": action,
        "changed_path": changed_path,
        "message": (
            "Saved locally. Waiting to rebuild song data..."
            if rebuild_required
            else "Song data rebuilt. Waiting to sync content repo..."
        ),
        "ok": None,
        "pushed": False,
        "created_at": now,
        "updated_at": now,
        "rebuild_required": rebuild_required,
    }
    with sync_jobs_lock:
        sync_jobs[job_id] = job
    sync_job_queue.put(job_id)
    return public_job_status(job)


def validate_song_path(filepath: str):
    """Ensure the file path is within the songs directory"""
    if os.path.commonpath([os.path.abspath(filepath), SONGS_DIR]) != SONGS_DIR:
        raise HTTPException(status_code=403, detail="Invalid file path")

class SongContent(BaseModel):
    content: str
    expected_revision: str | None = None


CHORDPRO_META_RE = re.compile(r"^\{\s*([^:]+):\s*(.+)\s*\}$")


def extract_song_title(content: str, *, require_directive: bool = False) -> str:
    """Extract a title using the same last-directive-wins behavior as the builder."""
    title = None
    for line in content.splitlines():
        match = CHORDPRO_META_RE.match(line)
        if match and match.group(1).strip().lower() == "title":
            title = match.group(2).strip()

    if title is None:
        if require_directive:
            raise HTTPException(
                status_code=400,
                detail="Song must have a {title: ...} directive",
            )
        return "Untitled"

    if require_directive and not title:
        raise HTTPException(status_code=400, detail="Song title cannot be empty")
    return title


def normalized_song_id(title: str) -> str:
    """Match the frontend/build slugify implementation exactly."""
    song_id = re.sub(r"[^a-z0-9]+", "-", title.lower().strip())
    return re.sub(r"^-+|-+$", "", song_id)


def song_revision(content: str) -> str:
    """Return a stable revision for optimistic concurrency checks."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def find_song_id_conflicts(song_id: str, *, exclude_filename: str | None = None) -> list[dict]:
    conflicts = []
    if not os.path.exists(SONGS_DIR):
        return conflicts

    for filename in sorted(os.listdir(SONGS_DIR)):
        if not filename.endswith(".pro") or filename == exclude_filename:
            continue
        filepath = os.path.join(SONGS_DIR, filename)
        with open(filepath, "r", encoding="utf-8") as song_file:
            existing_content = song_file.read()
        existing_title = extract_song_title(existing_content)
        if normalized_song_id(existing_title) == song_id:
            conflicts.append({"filename": filename, "title": existing_title})
    return conflicts


def ensure_unique_song_id(content: str, *, exclude_filename: str | None = None) -> tuple[str, str]:
    title = extract_song_title(content, require_directive=True)
    song_id = normalized_song_id(title)
    if not song_id:
        raise HTTPException(
            status_code=400,
            detail="Song title must contain at least one letter or number",
        )

    conflicts = find_song_id_conflicts(song_id, exclude_filename=exclude_filename)
    if conflicts:
        conflicting_files = ", ".join(conflict["filename"] for conflict in conflicts)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "duplicate_song_id",
                "message": (
                    f'A song with the normalized ID "{song_id}" already exists in '
                    f"{conflicting_files}. Choose a different title."
                ),
                "song_id": song_id,
                "title": title,
                "conflicts": conflicts,
            },
        )
    return title, song_id


def fsync_directory(directory: str):
    """Persist a completed rename/removal when the filesystem supports directory fsync."""
    try:
        directory_fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(directory_fd)
    except OSError:
        pass
    finally:
        os.close(directory_fd)


def atomic_write_text(filepath: str, content: str):
    """Write a complete file and atomically replace the previous version."""
    directory = os.path.dirname(filepath)
    os.makedirs(directory, exist_ok=True)
    existing_mode = (os.stat(filepath).st_mode & 0o777) if os.path.exists(filepath) else 0o644
    file_descriptor, temporary_path = tempfile.mkstemp(
        dir=directory,
        prefix=f".{os.path.basename(filepath)}.",
        suffix=".tmp",
    )
    try:
        os.chmod(temporary_path, existing_mode)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as temporary_file:
            file_descriptor = -1
            temporary_file.write(content)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, filepath)
        fsync_directory(directory)
    finally:
        if file_descriptor >= 0:
            os.close(file_descriptor)
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


def transactional_song_write(filepath: str, content: str, previous_content: str | None):
    """Write and verify a song, restoring the prior catalogue state if the build fails."""
    atomic_write_text(filepath, content)
    try:
        build_result = rebuild_songs()
    except Exception as error:
        build_result = {"ok": False, "message": f"Song build failed unexpectedly: {error}"}

    if build_result.get("ok"):
        return

    rollback_error = None
    recovery_result = None
    try:
        if previous_content is None:
            os.remove(filepath)
            fsync_directory(os.path.dirname(filepath))
        else:
            atomic_write_text(filepath, previous_content)
        recovery_result = rebuild_songs()
    except Exception as error:
        rollback_error = str(error)

    rollback_succeeded = rollback_error is None and bool(recovery_result and recovery_result.get("ok"))
    detail = {
        "code": "song_build_failed",
        "message": "The song could not be built, so the change was not saved.",
        "build_error": build_result.get("message") or "Unknown build error",
        "rollback_succeeded": rollback_succeeded,
    }
    if recovery_result and not recovery_result.get("ok"):
        detail["recovery_error"] = recovery_result.get("message") or "Recovery build failed"
    if rollback_error:
        detail["recovery_error"] = rollback_error

    raise HTTPException(
        status_code=422 if rollback_succeeded else 500,
        detail=detail,
    )


def transactional_song_delete(filepath: str, previous_content: str):
    """Delete and verify a song, restoring it if the catalogue cannot be rebuilt."""
    os.remove(filepath)
    fsync_directory(os.path.dirname(filepath))
    try:
        build_result = rebuild_songs()
    except Exception as error:
        build_result = {"ok": False, "message": f"Song build failed unexpectedly: {error}"}

    if build_result.get("ok"):
        return

    rollback_error = None
    recovery_result = None
    try:
        atomic_write_text(filepath, previous_content)
        recovery_result = rebuild_songs()
    except Exception as error:
        rollback_error = str(error)

    rollback_succeeded = rollback_error is None and bool(recovery_result and recovery_result.get("ok"))
    detail = {
        "code": "song_build_failed",
        "message": "The song catalogue could not be rebuilt, so the deletion was undone.",
        "build_error": build_result.get("message") or "Unknown build error",
        "rollback_succeeded": rollback_succeeded,
    }
    if recovery_result and not recovery_result.get("ok"):
        detail["recovery_error"] = recovery_result.get("message") or "Recovery build failed"
    if rollback_error:
        detail["recovery_error"] = rollback_error

    raise HTTPException(
        status_code=422 if rollback_succeeded else 500,
        detail=detail,
    )


def require_matching_revision(
    filename: str,
    expected_revision: str | None,
    current_content: str,
) -> str:
    current_revision = song_revision(current_content)
    if expected_revision is None:
        raise HTTPException(
            status_code=428,
            detail={
                "code": "revision_required",
                "message": "Reload the song before saving or deleting it, then try again.",
                "filename": filename,
                "current_revision": current_revision,
                "current_content": current_content,
            },
        )
    if expected_revision != current_revision:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "revision_conflict",
                "message": "This song changed after you opened it. Review the latest version before trying again.",
                "filename": filename,
                "expected_revision": expected_revision,
                "current_revision": current_revision,
                "current_content": current_content,
            },
        )
    return current_revision

@app.get("/api/version")
def get_version():
    return {"git_sha": GIT_SHA, "image_ref": IMAGE_REF}


@app.get("/api/sync-jobs/{job_id}")
def get_sync_job(job_id: str):
    with sync_jobs_lock:
        job = sync_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Sync job not found")
        return public_job_status(job.copy())


@app.post("/api/refresh", dependencies=[Depends(require_write_access)])
def refresh_from_github():
    with song_mutation_lock:
        return _refresh_from_github()


def _refresh_from_github():
    """Pull the content repository from GitHub and rebuild generated song data."""
    if not CONTENT_REPO_DIR or not os.path.isdir(os.path.join(CONTENT_REPO_DIR, ".git")):
        message = "Cannot refresh: CONTENT_REPO_DIR is not a git repository."
        print(message)
        return {"ok": False, "changed": False, "message": message}

    try:
        ensure_content_repo_safe_directory()

        remote_name = os.environ.get("CONTENT_REPO_PUSH_REMOTE", "origin")
        branch = os.environ.get("CONTENT_REPO_PUSH_BRANCH")
        if not branch:
            branch = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=CONTENT_REPO_DIR,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()

        user_name, user_email = get_git_identity()
        changed = rebase_content_repo(remote_name, branch, user_name, user_email)
        build_result = rebuild_songs()
        if not build_result["ok"]:
            return {"ok": False, "changed": changed, "message": build_result["message"]}

        if changed:
            message = "Content repo refreshed from GitHub."
        else:
            message = "Content repo already up to date; song data rebuilt."
        print(message)
        return {"ok": True, "changed": changed, "message": message}
    except subprocess.CalledProcessError as error:
        message = f"Content repo refresh failed: {git_error_detail(error)}"
        print(message)
        return {"ok": False, "changed": False, "message": message}

@app.get("/api/songs")
def list_songs():
    songs = []
    if os.path.exists(SONGS_DIR):
        for filename in os.listdir(SONGS_DIR):
            if filename.endswith(".pro"):
                songs.append(filename)
    return {"songs": sorted(songs)}

@app.post("/api/songs/create", dependencies=[Depends(require_write_access)])
def create_song(song: SongContent):
    """Create a new song file with auto-generated filename from title"""
    with song_mutation_lock:
        title, song_id = ensure_unique_song_id(song.content)
        base_filename = sanitize_filename(title)
        filename = f"{base_filename}.pro"
        filepath = os.path.join(SONGS_DIR, filename)

        # A filename can be occupied by a song whose title produces a different ID.
        counter = 1
        while os.path.exists(filepath):
            filename = f"{base_filename}-{counter}.pro"
            filepath = os.path.join(SONGS_DIR, filename)
            counter += 1

        validate_song_path(filepath)
        transactional_song_write(filepath, song.content, previous_content=None)
        revision = song_revision(song.content)
        sync = enqueue_content_sync(filepath, "Create song", rebuild_required=False)

    return {
        "message": "Song saved locally",
        "filename": filename,
        "id": song_id,
        "revision": revision,
        "sync": sync,
    }

@app.get("/api/songs/{filename}")
def get_song(filename: str):
    # Basic security check to prevent directory traversal
    if ".." in filename or "/" in filename or "\\" in filename:
         raise HTTPException(status_code=400, detail="Invalid filename")
    
    filepath = os.path.join(SONGS_DIR, filename)

    with song_mutation_lock:
        if not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail="Song not found")

        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()

    return {"content": content, "revision": song_revision(content)}

@app.post("/api/songs/{filename}", dependencies=[Depends(require_write_access)])
@app.put("/api/songs/{filename}", dependencies=[Depends(require_write_access)])
def update_song(filename: str, song: SongContent):
    """Update an existing song file"""
    # Basic security check to prevent directory traversal
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    
    filepath = os.path.join(SONGS_DIR, filename)
    validate_song_path(filepath)

    with song_mutation_lock:
        if not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail="Song not found")

        with open(filepath, "r", encoding="utf-8") as song_file:
            previous_content = song_file.read()
        require_matching_revision(filename, song.expected_revision, previous_content)
        _title, song_id = ensure_unique_song_id(song.content, exclude_filename=filename)
        transactional_song_write(filepath, song.content, previous_content)
        revision = song_revision(song.content)
        sync = enqueue_content_sync(filepath, "Update song", rebuild_required=False)

    return {
        "message": "Song saved locally",
        "filename": filename,
        "id": song_id,
        "revision": revision,
        "sync": sync,
    }

@app.delete("/api/songs/{filename}", dependencies=[Depends(require_write_access)])
def delete_song(filename: str, expected_revision: str | None = None):
    """Delete a song file"""
    # Basic security check to prevent directory traversal
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    
    filepath = os.path.join(SONGS_DIR, filename)
    validate_song_path(filepath)

    with song_mutation_lock:
        if not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail="Song not found")

        with open(filepath, "r", encoding="utf-8") as song_file:
            previous_content = song_file.read()
        require_matching_revision(filename, expected_revision, previous_content)
        transactional_song_delete(filepath, previous_content)
        sync = enqueue_content_sync(filepath, "Delete song", rebuild_required=False)

    return {"message": "Song deleted locally", "sync": sync}

def find_song_file_by_id(song_id: str) -> str | None:
    """Find a .pro file by song ID (slug of title)"""
    if not os.path.exists(SONGS_DIR):
        return None
    
    for filename in os.listdir(SONGS_DIR):
        if not filename.endswith(".pro"):
            continue
        filepath = os.path.join(SONGS_DIR, filename)
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        # Extract title and convert to slug
        title_match = re.search(r'\{title:\s*([^}]+)\}', content, re.IGNORECASE)
        if title_match:
            title = title_match.group(1).strip()
            # Create slug from title (same logic as frontend slugify)
            slug = re.sub(r'[^a-z0-9]+', '-', title.lower().strip())
            slug = re.sub(r'^-+|-+$', '', slug)
            if slug == song_id:
                return filepath
    return None

@app.get("/edit/{song_id:path}")
def serve_edit_page(song_id: str):
    """Serve the SPA shell for direct edit-page loads."""
    index_path = os.path.join(DIST_DIR, "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="Frontend not built")
    return FileResponse(index_path, headers={"Cache-Control": "no-cache"})

# Mount the static files from dist/ directory (production)
if os.path.exists(DIST_DIR):
    app.mount("/", CachedStaticFiles(directory=DIST_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
